// Client-side Supabase Realtime subscription for live collaboration.
//
// Opt-in per environment: only active when VITE_SUPABASE_URL and
// VITE_SUPABASE_ANON_KEY are provided at build time. The anon key is public
// once shipped, so leaving these unset keeps timeline reads server-gated
// (the app still works — remote changes appear on the next reload).

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { PresenceUser } from './presence';
import type { SourceLive, Watermark } from './types';
import { nextPollDelay, watermarkChanged } from './poll';

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

// Pricing child tables that carry their own rows (versions live on the
// `timelines` row, so they arrive via the `timelines` UPDATE listener).
export const PRICING_TABLES = [
  'pricing_features',
  'pricing_tiers',
  'pricing_tier_values',
  'pricing_highlights',
] as const;
export type PricingTable = (typeof PRICING_TABLES)[number];

export type RemoteChange = {
  table: 'timeline_items' | 'timelines' | PricingTable;
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

  // Pricing child tables: any row change re-reads the assembled model.
  for (const table of PRICING_TABLES) {
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
 *   'realtime' → Supabase WebSocket channel (needs the anon key; no-op without)
 *   'poll'     → watermark polling (server-gated, no anon key)
 *   'none'     → no live updates (file sources)
 * Returns an unsubscribe function. `onChange` has the same shape for both impls.
 */
export function watchTimeline(
  timelineId: string,
  onChange: (c: RemoteChange) => void,
  opts: WatchOptions,
): () => void {
  if (opts.live === 'realtime') {
    if (!isRealtimeEnabled()) return () => {};
    return subscribeTimeline(timelineId, onChange);
  }
  if (opts.live === 'poll') {
    return pollTimeline(timelineId, onChange, { isBusy: opts.isBusy });
  }
  return () => {};
}

/**
 * Join the presence channel for one timeline and announce `me` as online.
 * `onSync` fires whenever the roster changes with the de-duplicated list of
 * users currently connected (one entry per email, even across multiple tabs).
 * Returns an unsubscribe function. No-op when realtime is disabled.
 */
export function joinPresence(
  timelineId: string,
  me: PresenceUser,
  onSync: (users: PresenceUser[]) => void,
): () => void {
  const db = getClient();
  if (!db) return () => {};

  const channel = db.channel(`presence:${timelineId}`, {
    config: { presence: { key: me.email } },
  });

  const emit = () => {
    const roster = channel.presenceState<PresenceUser>();
    const byEmail = new Map<string, PresenceUser>();
    for (const entries of Object.values(roster)) {
      for (const entry of entries) {
        if (entry?.email) byEmail.set(entry.email, { email: entry.email, name: entry.name });
      }
    }
    onSync([...byEmail.values()]);
  };

  channel
    .on('presence', { event: 'sync' }, emit)
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') void channel.track({ email: me.email, name: me.name });
    });

  return () => {
    void db.removeChannel(channel);
  };
}
