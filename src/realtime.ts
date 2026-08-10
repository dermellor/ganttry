// Client-side Supabase Realtime subscription for live collaboration.
//
// Opt-in per environment: only active when VITE_SUPABASE_URL and
// VITE_SUPABASE_ANON_KEY are provided at build time. The anon key is public
// once shipped, so leaving these unset keeps timeline reads server-gated
// (the app still works — remote changes appear on the next reload).

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  dedupeRoster,
  type PresenceActivity,
  type PresenceEntry,
  type PresenceUser,
} from './presenceModel';
import type { SourceLive, Watermark } from './types';
import { nextPollDelay, watermarkChanged } from './poll';
import { pluginRealtimeTables } from './pluginHost/registry';

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const ANON = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export function isRealtimeEnabled(): boolean {
  return !!URL && !!ANON;
}

let client: SupabaseClient | null = null;
function getClient(): SupabaseClient | null {
  if (!isRealtimeEnabled()) return null;
  if (!client) client = createClient(URL!, ANON!, { auth: { persistSession: false } });
  return client;
}

export type RemoteChange = {
  // A plugin-owned table name is just a string here: the host subscribes to what
  // the registry declares, and knows nothing about what those tables mean.
  table: 'timeline_items' | 'timelines' | (string & {});
  event: 'INSERT' | 'UPDATE' | 'DELETE';
  id: string; // item id (items) or timeline id (timelines); row id for pricing tables
  version?: number; // new row version for items (own-echo suppression)
};

/**
 * Subscribe to changes for one timeline. Returns an unsubscribe function.
 * `onChange` fires for item inserts/updates/deletes and timeline (phase/meta)
 * updates scoped to this timeline id.
 */
export function subscribeTimeline(timelineId: string, onChange: (c: RemoteChange) => void): () => void {
  const db = getClient();
  if (!db) return () => {};

  let channel = db
    .channel(`timeline:${timelineId}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'timeline_items', filter: `timeline_id=eq.${timelineId}` },
      (payload) => {
        const row = (payload.new ?? payload.old) as Record<string, any>;
        onChange({
          table: 'timeline_items',
          event: payload.eventType as RemoteChange['event'],
          id: row?.id,
          version: (payload.new as Record<string, any>)?.version,
        });
      },
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'timelines', filter: `id=eq.${timelineId}` },
      () => onChange({ table: 'timelines', event: 'UPDATE', id: timelineId }),
    );

  // Plugin-owned tables: any row change re-reads that plugin's model. Declared
  // per plugin (registry `realtimeTables`) rather than listed here, so a second
  // plugin with its own rows needs no change to the core subscription. Goes away
  // with the generic store (#12), where one table covers every plugin.
  for (const table of pluginRealtimeTables()) {
    channel = channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table, filter: `timeline_id=eq.${timelineId}` },
      (payload) => {
        const row = (payload.new ?? payload.old) as Record<string, any>;
        onChange({ table, event: payload.eventType as RemoteChange['event'], id: row?.id });
      },
    );
  }
  channel.subscribe();

  return () => {
    void db.removeChannel(channel);
  };
}

export type WatchOptions = {
  live: SourceLive;
  // Poll only: withhold a reload while the user is mid-interaction (open edit
  // form / active drag). The change isn't lost — it fires once `isBusy` clears.
  isBusy?: () => boolean;
};

/**
 * Poll `GET /api/source/<id>/watermark` and fire `onChange` when the signature
 * moves. The watermark endpoint is server-gated (no anon key needed), so this
 * works for sources without Supabase Realtime. A change detected while the user
 * is busy is deferred, not dropped. Returns an unsubscribe function.
 *
 * Coarser than the realtime path by design (the issue's "zunächst Full-Reload"):
 * any detected change triggers one reload via `onChange`, including shortly
 * after the client's own write (the reload then re-baselines saved versions, so
 * subsequent polls stay quiet). Delta-fetch is a later optimization.
 */
export function pollTimeline(
  timelineId: string,
  onChange: (c: RemoteChange) => void,
  opts?: { isBusy?: () => boolean },
): () => void {
  const isBusy = opts?.isBusy ?? (() => false);
  let prev: Watermark | null = null;
  let pending = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const hidden = () => typeof document !== 'undefined' && document.hidden;

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      const res = await fetch(`/api/source/${timelineId}/watermark`);
      if (res.ok) {
        const wm = (await res.json()) as Watermark;
        // First read only establishes the baseline — no reload on initial load.
        if (prev && watermarkChanged(prev, wm)) pending = true;
        prev = wm;
      }
    } catch {
      // Network blip: keep the old baseline and try again next tick.
    }
    if (pending && !isBusy()) {
      pending = false;
      // A coarse "something changed" signal — persistence does a full reload.
      onChange({ table: 'timelines', event: 'UPDATE', id: timelineId });
    }
    if (!stopped) timer = setTimeout(() => void tick(), nextPollDelay(hidden()));
  }

  void tick();

  // Re-check immediately when the tab becomes visible again (drop the long
  // hidden backoff so a returning user sees fresh data fast).
  const onVisible = () => {
    if (stopped || hidden()) return;
    if (timer) clearTimeout(timer);
    void tick();
  };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
  };
}

/**
 * The live-update seam: subscribe to one timeline's changes with the impl its
 * source declares (`capabilities.live`, surfaced to the client via loadSource).
 *   'realtime' → Supabase WebSocket channel, falling back to polling when this
 *                build carries no anon key
 *   'poll'     → watermark polling (server-gated, no anon key)
 *   'none'     → no live updates (file sources)
 * Returns an unsubscribe function. `onChange` has the same shape for both impls.
 *
 * The fallback matters because the two halves of "realtime" are configured
 * apart: the server advertises the mode from ITS Supabase vars, while the
 * channel needs `VITE_SUPABASE_ANON_KEY`, which is baked in at build time and is
 * routinely absent (a build without it, a self-hosted deployment). This used to
 * return an inert unsubscribe, so the viewer sat there looking live and updated
 * on reload only. Polling reaches the same server that just answered the load,
 * so it works wherever the app does.
 */
export function watchTimeline(
  timelineId: string,
  onChange: (c: RemoteChange) => void,
  opts: WatchOptions,
): () => void {
  if (opts.live === 'realtime' && isRealtimeEnabled()) {
    return subscribeTimeline(timelineId, onChange);
  }
  if (opts.live === 'realtime' || opts.live === 'poll') {
    return pollTimeline(timelineId, onChange, { isBusy: opts.isBusy });
  }
  return () => {};
}

/**
 * Handle on the joined presence channel: keeps the identity announced and lets
 * the client amend what it is doing (which item is open / being edited) without
 * a leave-rejoin cycle.
 */
export type PresenceHandle = {
  /** Re-announce this client with a new activity. Cheap no-op if unchanged. */
  setActivity(activity: PresenceActivity): void;
  leave(): void;
};

/**
 * Join the presence channel for one timeline and announce `me` as online.
 * `onSync` fires whenever the roster changes with the de-duplicated list of
 * users currently connected (one entry per email, even across multiple tabs —
 * the tab with the most specific activity wins). Returns a handle for amending
 * our own activity and for leaving. Inert when realtime is disabled.
 */
export function joinPresence(
  timelineId: string,
  me: PresenceUser,
  onSync: (users: PresenceEntry[]) => void,
): PresenceHandle {
  const db = getClient();
  if (!db) return { setActivity: () => {}, leave: () => {} };

  const channel = db.channel(`presence:${timelineId}`, {
    config: { presence: { key: me.email } },
  });

  const emit = () => {
    const roster = channel.presenceState<PresenceEntry>();
    onSync(dedupeRoster(Object.values(roster).flat()));
  };

  // The activity we last announced (or want to announce as soon as the channel
  // is up — `track` before SUBSCRIBED is dropped by supabase-js).
  let activity: PresenceActivity = {};
  let tracked: string | null = null;
  let subscribed = false;

  const push = () => {
    if (!subscribed) return;
    const identity = { email: me.email, name: me.name, ...activity };
    const key = JSON.stringify(identity);
    if (key === tracked) return; // nothing new to say — don't churn the channel
    tracked = key;
    // `at` stamps *when* we said this, so receivers can tell a re-announcement
    // from the meta it supersedes (dedupeRoster). Deliberately outside the
    // compare key above — otherwise every push would look like news.
    void channel.track({ ...identity, at: Date.now() });
  };

  channel.on('presence', { event: 'sync' }, emit).subscribe((status) => {
    if (status !== 'SUBSCRIBED') return;
    subscribed = true;
    push();
  });

  return {
    setActivity(next: PresenceActivity) {
      activity = { itemId: next.itemId ?? null, editing: !!next.editing };
      push();
    },
    leave() {
      void db.removeChannel(channel);
    },
  };
}
