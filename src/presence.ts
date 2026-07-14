// Header presence badge: renders the avatars of everyone who currently has the
// active timeline open. Fed by the Supabase presence channel (src/realtime.ts),
// which is opt-in per environment (VITE_SUPABASE_*). No realtime → no badge.

import { els } from './state';

export type PresenceUser = { email: string; name?: string };

// Beyond this many concurrent viewers the rest collapse into a "+N" chip so the
// header never overflows.
const MAX_AVATARS = 5;

/** Two-letter monogram from a name ("Robin Fischer" → RF) or email local part. */
function initials(u: PresenceUser): string {
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
function hueFor(email: string): number {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 31 + email.charCodeAt(i)) % 360;
  return h;
}

function label(u: PresenceUser): string {
  return u.name ? `${u.name} (${u.email})` : u.email;
}

/**
 * Render the presence avatars. `selfEmail` (if known) is placed first and gets
 * a highlight ring. An empty list hides the badge entirely.
 */
export function renderPresence(users: PresenceUser[], selfEmail: string | null): void {
  const el = els.presence;
  if (!el) return;

  if (!users.length) {
    el.hidden = true;
    el.replaceChildren();
    return;
  }

  const sorted = [...users].sort((a, b) => {
    if (a.email === selfEmail) return -1;
    if (b.email === selfEmail) return 1;
    return label(a).localeCompare(label(b));
  });

  const shown = sorted.slice(0, MAX_AVATARS);
  const overflow = sorted.length - shown.length;
  const frag = document.createDocumentFragment();

  for (const u of shown) {
    const avatar = document.createElement('span');
    avatar.className = 'presence-avatar';
    if (u.email === selfEmail) avatar.classList.add('is-self');
    avatar.style.setProperty('--presence-hue', String(hueFor(u.email)));
    avatar.textContent = initials(u);
    avatar.title = u.email === selfEmail ? `${label(u)} — du` : label(u);
    frag.appendChild(avatar);
  }

  if (overflow > 0) {
    const more = document.createElement('span');
    more.className = 'presence-avatar presence-more';
    more.textContent = `+${overflow}`;
    more.title = sorted.slice(MAX_AVATARS).map(label).join('\n');
    frag.appendChild(more);
  }

  el.replaceChildren(frag);
  el.hidden = false;
  el.setAttribute('aria-label', `${users.length} online`);
}
