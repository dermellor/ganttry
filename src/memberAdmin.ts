// The „Benutzer" screen: who belongs to this instance, and the four things an
// admin does about it — invite, change a role, suspend, restore.
//
// A dialog rather than a view, because a view in this app names a timeline
// source (see `applyView` in main.ts) and membership is not one. It also keeps
// the whole surface out of the bundle's hot path: nothing here runs until an
// admin opens it.
//
// Everything it offers is also enforced server-side (scripts/db/http.ts). What
// the interface hides is an affordance, never a permission: a viewer who
// crafts the request by hand still gets a 403, and hiding the button is only so
// that people are not offered buttons that will refuse them.
//
// The invitation link is built here rather than returned by the server: only the
// browser knows the origin the user actually reached the instance under, and a
// server that guessed it would hand out links to the wrong host behind a proxy.

import { escapeHtml } from './buildItems';
import { MEMBER_ROLES, type MemberRole, type MemberStatus } from './access';
import type { Member } from './types';

const STATUS_LABEL: Record<MemberStatus, string> = {
  invited: 'Eingeladen',
  active: 'Aktiv',
  suspended: 'Gesperrt',
  removed: 'Entfernt',
};

const ROLE_LABEL: Record<MemberRole, string> = {
  admin: 'Administrator',
  editor: 'Bearbeiter',
  viewer: 'Leser',
};

let dialog: HTMLDialogElement | null = null;
let members: Member[] = [];

/**
 * The refusals worth a sentence of their own.
 *
 * The server answers in English, like everything written into the repository,
 * while the interface is German — so the codes are translated here rather than
 * at the source. Anything not listed falls back to the server's own message,
 * which is still more use than a status code.
 */
const ERROR_TEXT: Record<string, string> = {
  last_admin: 'Das würde die Instanz ohne aktiven Administrator zurücklassen.',
  nothing_to_resend: 'Diese Mitgliedschaft wartet auf keine Einladung.',
  db_not_configured: 'Für Mitgliedschaften braucht diese Instanz eine Datenbank.',
  access_control_disabled: 'Die Benutzerverwaltung ist auf dieser Instanz nicht eingeschaltet.',
  forbidden: 'Dafür fehlen dir die Rechte.',
  invalid_request: 'Diese Eingabe ist nicht gültig.',
  'not found': 'Diese Adresse ist kein Mitglied.',
};

async function api(method: string, body?: unknown): Promise<any> {
  const res = await fetch('/api/members', {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(ERROR_TEXT[data.error] || data.message || data.error || `HTTP ${res.status}`);
  }
  return data;
}

function inviteUrl(token: string): string {
  return `${location.origin}/invite/${token}`;
}

/** One row. `removed` members stay listed: an item's owner may still point at them. */
function rowHtml(m: Member): string {
  const label = m.name ? `${m.name} <span class="member-mail">${escapeHtml(m.email)}</span>` : escapeHtml(m.email);
  const roleOptions = MEMBER_ROLES.map(
    (r) => `<option value="${r}"${r === m.role ? ' selected' : ''}>${ROLE_LABEL[r]}</option>`,
  ).join('');
  const seen = m.lastSeenAt ? new Date(m.lastSeenAt).toLocaleDateString('de-DE') : '—';

  const actions: string[] = [];
  if (m.status === 'invited') {
    actions.push('<button type="button" data-act="resend">Einladung erneut</button>');
  }
  if (m.status === 'active') {
    actions.push('<button type="button" data-act="suspend">Sperren</button>');
  }
  if (m.status === 'suspended' || m.status === 'removed') {
    actions.push('<button type="button" data-act="restore">Entsperren</button>');
  }
  if (m.status !== 'removed') {
    actions.push('<button type="button" data-act="remove" class="is-destructive">Entfernen</button>');
  }

  return `<tr data-email="${escapeHtml(m.email)}" class="member-row is-${m.status}">
    <td class="member-who">${label}</td>
    <td><select data-act="role" aria-label="Rolle">${roleOptions}</select></td>
    <td><span class="member-status is-${m.status}">${STATUS_LABEL[m.status]}</span></td>
    <td class="member-seen">${seen}</td>
    <td><div class="member-actions">${actions.join('')}</div></td>
  </tr>`;
}

function render(): void {
  const body = dialog?.querySelector('#member-rows');
  if (!body) return;
  body.innerHTML = members.length
    ? members.map(rowHtml).join('')
    : '<tr><td colspan="5" class="list-empty">Noch niemand eingeladen.</td></tr>';
}

function say(message: string, kind: 'ok' | 'error' = 'ok'): void {
  const note = dialog?.querySelector('#member-note') as HTMLElement | null;
  if (!note) return;
  note.textContent = message;
  note.className = `member-note is-${kind}`;
  note.hidden = !message;
}

/**
 * Show an invitation link to copy.
 *
 * This is the whole delivery mechanism until mail exists, and it stays useful
 * afterwards: an instance with no mail provider configured can still invite, and
 * an admin who wants to hand the link over in a chat message does not have to
 * make the person wait for an e-mail.
 */
function showInvite(email: string, token: string): void {
  const box = dialog?.querySelector('#member-invite') as HTMLElement | null;
  const field = dialog?.querySelector('#member-invite-url') as HTMLInputElement | null;
  if (!box || !field) return;
  field.value = inviteUrl(token);
  box.hidden = false;
  (box.querySelector('.member-invite-for') as HTMLElement).textContent = email;
  field.focus();
  field.select();
}

async function reload(): Promise<void> {
  members = (await api('GET')).members ?? [];
  render();
}

async function act(email: string, patch: Record<string, unknown>, done: string): Promise<void> {
  try {
    const res = await api('PATCH', { email, ...patch });
    if (res.inviteToken) showInvite(email, res.inviteToken);
    await reload();
    say(done);
  } catch (e) {
    say(e instanceof Error ? e.message : String(e), 'error');
    // Re-render from the server's state, NOT only on success: a refused role
    // change leaves the dropdown showing the value the server rejected, so the
    // screen would claim a role nobody has. Reload before the message, and the
    // refusal reads as „it did not happen" rather than „it happened and also
    // complained".
    try {
      await reload();
    } catch {
      // The list we already have is closer to the truth than a blank table.
    }
  }
}

function wire(): void {
  if (!dialog) return;

  dialog.querySelector('#member-invite-form')!.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const form = ev.target as HTMLFormElement;
    const email = (form.elements.namedItem('email') as HTMLInputElement).value.trim();
    const role = (form.elements.namedItem('role') as HTMLSelectElement).value;
    if (!email) return;
    try {
      const res = await api('POST', { email, role });
      form.reset();
      await reload();
      say(`${email} eingeladen.`);
      if (res.inviteToken) showInvite(email, res.inviteToken);
    } catch (e) {
      say(e instanceof Error ? e.message : String(e), 'error');
    }
  });

  // One delegated listener rather than one per row: the table is re-rendered on
  // every change, and per-row listeners would leak with it.
  dialog.querySelector('#member-rows')!.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest('button[data-act]') as HTMLButtonElement | null;
    const email = btn?.closest('tr')?.getAttribute('data-email');
    if (!btn || !email) return;
    switch (btn.dataset.act) {
      case 'resend':
        return void act(email, { resend: true }, `Neue Einladung für ${email}.`);
      case 'suspend':
        return void act(email, { status: 'suspended' }, `${email} gesperrt.`);
      case 'restore':
        return void act(email, { status: 'active' }, `${email} entsperrt.`);
      case 'remove':
        return void act(email, { status: 'removed' }, `${email} entfernt.`);
    }
  });

  dialog.querySelector('#member-rows')!.addEventListener('change', (ev) => {
    const select = ev.target as HTMLSelectElement;
    if (select.dataset.act !== 'role') return;
    const email = select.closest('tr')?.getAttribute('data-email');
    if (email) void act(email, { role: select.value }, `Rolle von ${email} geändert.`);
  });

  dialog.querySelector('#member-invite-copy')!.addEventListener('click', async () => {
    const field = dialog!.querySelector('#member-invite-url') as HTMLInputElement;
    try {
      await navigator.clipboard.writeText(field.value);
      say('Link kopiert.');
    } catch {
      // Clipboard access can be refused; the field is selected either way, so
      // the link is still one keystroke from being copied.
      field.select();
      say('Link markiert — mit Strg/Cmd+C kopieren.');
    }
  });

  dialog.querySelector('#member-close')!.addEventListener('click', () => dialog!.close());
}

/** Open the screen, loading the list fresh — roles change while it is closed. */
export async function openMemberAdmin(): Promise<void> {
  dialog ??= document.getElementById('member-dialog') as HTMLDialogElement;
  if (!dialog) return;
  if (!dialog.dataset.wired) {
    wire();
    dialog.dataset.wired = 'true';
  }
  say('');
  (dialog.querySelector('#member-invite') as HTMLElement).hidden = true;
  dialog.showModal();
  try {
    await reload();
  } catch (e) {
    say(e instanceof Error ? e.message : String(e), 'error');
  }
}
