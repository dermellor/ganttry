// The user directory an item's Owner links to (GET /api/users, backed by the
// `app_users` table): loading it, caching it, and rendering a user.
//
// `metadata.owner` stores an **e-mail** — a stable id — and this module is what
// turns it back into a person for display. The rules for what a stored value
// means and which users a query matches are pure and live in ownerModel.ts; what
// is here is the state and the DOM.
//
// The directory is loaded **once per page load** and cached. It changes only when
// someone new signs in, and it is read on every list repaint and every form open;
// re-fetching per read would put a request on the critical path of both for data
// that virtually never moves. Fetching it also registers us (the endpoint upserts
// its caller), so this one call is what puts the current user in everyone else's
// picker.
//
// Display initials/hue come from presenceModel.ts, so the same person looks the
// same as an owner and as a presence avatar.

import { Avatar, el, html, Text } from './design-system';
import { hueFor, initials, type PresenceUser } from './presenceModel';
import { indexUsers, matchUsers, resolveOwnerIn, type ResolvedOwner } from './ownerModel';
import type { DirectoryUser } from './types';
import { t } from './i18n';

export { displayName } from './ownerModel';

let directory: DirectoryUser[] = [];
let byEmail = new Map<string, DirectoryUser>();
let loaded: Promise<void> | null = null;
let reachable = false;

/**
 * Why the directory might be offering nobody — the picker needs this to say
 * something instead of silently not opening, and the two causes have different
 * remedies: `unavailable` is a DB/endpoint problem (e.g. the migration has not
 * been applied), `empty` means nobody has signed in yet, which is the normal
 * state of a fresh install.
 */
export function directoryState(): { status: 'ok' | 'empty' | 'unavailable'; count: number } {
  if (!reachable) return { status: 'unavailable', count: 0 };
  return { status: directory.length ? 'ok' : 'empty', count: directory.length };
}

/**
 * Load the directory once and cache it. Best-effort by design: a failure leaves
 * the cache empty, which degrades the owner picker to "offers nobody" and the
 * display to raw addresses — never to a broken view. Concurrent callers share
 * one in-flight request.
 */
export function loadUserDirectory(): Promise<void> {
  if (loaded) return loaded;
  loaded = (async () => {
    try {
      const res = await fetch('/api/users');
      if (!res.ok) return;
      const data = (await res.json()) as { users?: unknown };
      if (!Array.isArray(data.users)) return;
      const users: DirectoryUser[] = [];
      for (const raw of data.users) {
        const u = raw as { email?: unknown; name?: unknown };
        if (typeof u.email !== 'string' || !u.email) continue;
        users.push(
          typeof u.name === 'string' && u.name ? { email: u.email, name: u.name } : { email: u.email },
        );
      }
      directory = users;
      byEmail = indexUsers(users);
      reachable = true;
    } catch {
      // keep the empty cache; `reachable` stays false so the picker can say why
    }
  })();
  return loaded;
}

/** What a stored `metadata.owner` value means, against the loaded directory. */
export function resolveOwner(raw: string): ResolvedOwner | null {
  return resolveOwnerIn(byEmail, raw);
}

/** Directory search for the owner picker's autosuggest. */
export function searchUsers(query: string, limit = 8): DirectoryUser[] {
  return matchUsers(directory, query, limit);
}

/**
 * A user's initials avatar. The colour comes from `hueFor(email)` and the
 * component owns the look, so one person keeps one monogram in one colour
 * wherever they appear: the presence stack, the per-item presence marks, the
 * owner chip and the list's Owner column.
 *
 * `md` stands alone in the header; `sm` sits on a text line inside a chip, a
 * suggestion row or a table cell.
 */
export function userAvatar(u: PresenceUser | DirectoryUser, size: 'sm' | 'md' = 'md'): HTMLElement {
  return Avatar({ initials: initials(u), hue: hueFor(u.email), size });
}

/**
 * A stored owner value as one read-only cell: avatar + name for a linked user,
 * a marked plain label for a legacy free-text value, an em-dash for none. Shared
 * so every read-only surface renders an owner the same way.
 */
export function ownerCell(raw: string): HTMLElement {
  const owner = resolveOwner(raw);
  if (!owner) return Text({ text: '—', tone: 'muted' });
  if (!owner.known) {
    return Text({
      text: owner.label,
      placeholder: true,
      attrs: { title: t('form.owner.unlinked', { value: owner.raw }) },
    });
  }
  return el('span', { class: 'owner-cell', title: owner.raw }, [
    userAvatar(owner.user!, 'sm'),
    Text({ text: owner.label, truncate: true }),
  ]);
}

/** The same cell as markup, for the renderers that assemble strings. */
export function ownerCellHtml(raw: string): string {
  return html(ownerCell(raw));
}
