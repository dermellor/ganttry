// Pure presence model: who is connected, what they're doing, and how a raw
// channel roster collapses into something renderable. DOM-free on purpose — the
// renderers (presence.ts for the header badge, itemPresence.ts for the per-item
// marks) and the channel glue (realtime.ts) all sit on top of this, and the
// collapsing rules are unit-tested in presenceModel.test.ts.

export type PresenceUser = { email: string; name?: string };

/**
 * What a connected user is currently doing in the timeline. Broadcast on the
 * same presence channel as the identity (no extra channel, no DB table):
 * `itemId` is the item they have selected / open in their panel, `editing`
 * marks the ones who actually changed something a moment ago (see
 * markSelfEditing in persistence.ts).
 */
export type PresenceActivity = { itemId?: string | null; editing?: boolean };

/**
 * One roster entry: who, plus what they're doing. `at` is the sender's clock when
 * it announced this activity — the ordering key dedupeRoster needs (see there).
 */
export type PresenceEntry = PresenceUser & PresenceActivity & { at?: number };

/**
 * How much a roster entry says: editing an item beats merely having one
 * selected, which beats just being connected. Only a **tiebreaker** for entries
 * of the same age — never a substitute for recency, see dedupeRoster.
 */
export function activityRank(e: PresenceEntry): number {
  if (e.editing && e.itemId) return 2;
  if (e.itemId) return 1;
  return 0;
}

/**
 * Collapse a raw channel roster to one entry per e-mail: the **most recently
 * announced** one (largest `at`), falling back to the more specific activity
 * only when the timestamps can't separate them.
 *
 * Recency is the whole point, and picking "most specific" instead is a trap that
 * looks right and isn't: a channel roster holds several metas per key — one per
 * tab, but also the *superseded* metas of a single tab, because re-announcing an
 * activity adds a meta rather than replacing it. Ranking by specificity lets a
 * stale meta outrank the current one (an old `editing` beats the fresh
 * `selected` that replaced it), so the mark sticks on "editiert gerade" for
 * good. Newest-wins can't strand a state that way, and across tabs it reads as
 * "the person's last action", which is what a viewer wants to see anyway.
 *
 * Entries without an e-mail are dropped; activity fields are normalised so
 * consumers don't have to test for undefined.
 */
export function dedupeRoster(entries: PresenceEntry[]): PresenceEntry[] {
  const byEmail = new Map<string, PresenceEntry>();
  for (const entry of entries) {
    if (!entry?.email) continue;
    const next: PresenceEntry = {
      email: entry.email,
      name: entry.name,
      itemId: entry.itemId ?? null,
      editing: !!entry.editing,
      at: typeof entry.at === 'number' ? entry.at : undefined,
    };
    const prev = byEmail.get(entry.email);
    if (!prev || supersedes(next, prev)) byEmail.set(entry.email, next);
  }
  return [...byEmail.values()];
}

// Does `next` describe a more current state than `prev` (same person)?
function supersedes(next: PresenceEntry, prev: PresenceEntry): boolean {
  const a = next.at;
  const b = prev.at;
  if (a != null && b != null && a !== b) return a > b;
  if (a != null && b == null) return true; // a stamped entry beats an unstamped one
  if (a == null && b != null) return false;
  return activityRank(next) > activityRank(prev);
}

/**
 * Bucket a roster by the item each user occupies, dropping ourselves (our own
 * selection is already the timeline's selection) and everyone who isn't on an
 * item. Within a bucket, editing users come first, then a stable alphabetical
 * order — so the avatars (and the ring colour taken from the first one) don't
 * reshuffle on every roster sync.
 */
export function groupPresenceByItem(
  entries: PresenceEntry[],
  selfEmail: string | null,
): Map<string, PresenceEntry[]> {
  const byItem = new Map<string, PresenceEntry[]>();
  for (const entry of entries) {
    if (!entry.itemId) continue;
    if (selfEmail && entry.email === selfEmail) continue;
    const list = byItem.get(entry.itemId);
    if (list) list.push(entry);
    else byItem.set(entry.itemId, [entry]);
  }
  for (const list of byItem.values()) {
    list.sort(
      (a, b) => Number(!!b.editing) - Number(!!a.editing) || labelFor(a).localeCompare(labelFor(b)),
    );
  }
  return byItem;
}

/** Two-letter monogram from a name ("Robin Fischer" → RF) or email local part. */
export function initials(u: PresenceUser): string {
  const name = u.name?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }
  const local = (u.email.split('@')[0] || u.email).trim();
  const parts = local.split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

/** Deterministic hue (0–359) so a given user keeps the same avatar colour. */
export function hueFor(email: string): number {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) % 360;
  return h;
}

/** Human label for tooltips: "Name (email)", or just the email. */
export function labelFor(u: PresenceUser): string {
  return u.name ? `${u.name} (${u.email})` : u.email;
}
