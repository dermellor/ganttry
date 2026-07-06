// Client-side Supabase Realtime subscription for live collaboration.
//
// Opt-in per environment: only active when VITE_SUPABASE_URL and
// VITE_SUPABASE_ANON_KEY are provided at build time. The anon key is public
// once shipped, so leaving these unset keeps timeline reads server-gated
// (the app still works — remote changes appear on the next reload).

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

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
  table: 'timeline_items' | 'timelines';
  event: 'INSERT' | 'UPDATE' | 'DELETE';
  id: string; // item id (items) or timeline id (timelines)
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

  const channel = db
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
    )
    .subscribe();

  return () => {
    void db.removeChannel(channel);
  };
}
