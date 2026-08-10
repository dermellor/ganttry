// The „Benutzer" screen: who belongs to this instance, and the four things an
// admin does about it — invite, change a role, suspend, restore.
//
// A section of the settings area rather than a screen of its own. It shipped as
// a dialog on its own header button, which was the second surface showing
// instance-wide state and heading for the „a button per concern, and no
// overview" arrangement the area exists to prevent. What it lost in the move is
// only the frame it drew for itself — the modal, its backdrop and its heading.
// The list, the invite form and the row actions are unchanged.
//
// It is still not a view: a view in this app names a timeline source (see
// `applyView` in main.ts) and membership is not one. Building on mount keeps the
// whole surface out of the bundle's hot path — nothing here runs, and no member
// markup exists in the document, until an admin opens the section.
//
// Everything it offers is also enforced server-side (scripts/db/http.ts). What
// the interface hides is an affordance, never a permission: a viewer who
// crafts the request by hand still gets a 403, and hiding the button is only so
// that people are not offered buttons that will refuse them.
//
// The invitation link is built here rather than returned by the server: only the
// browser knows the origin the user actually reached the instance under, and a
// server that guessed it would hand out links to the wrong host behind a proxy.

import {
  Badge,
  Button,
  Callout,
  Dialog,
  el,
  Select,
  Table,
  TableCell,
  TableHead,
  TableRow,
  Text,
  TextInput,
} from './design-system';
import './styles/members.css';
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

/** Where the built subtree currently lives, or null while unmounted. */
let root: HTMLElement | null = null;
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
  membership_unavailable: 'Die Mitgliederliste ist nicht lesbar. Vermutlich fehlt die Migration.',
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
function row(m: Member): HTMLElement {
  const action = (act: string, label: string, danger = false) =>
    Button({ label, variant: danger ? 'danger' : 'outline', size: 'sm', attrs: { 'data-act': act } });

  const actions: HTMLElement[] = [];
  if (m.status === 'invited') actions.push(action('resend', 'Einladung erneut'));
  if (m.status === 'active') actions.push(action('suspend', 'Sperren'));
  if (m.status === 'suspended' || m.status === 'removed') actions.push(action('restore', 'Entsperren'));
  if (m.status !== 'removed') actions.push(action('remove', 'Entfernen', true));

  return TableRow({
    className: `member-row is-${m.status}`,
    attrs: { 'data-email': m.email },
    children: [
      TableCell({
        primary: true,
        children: m.name
          ? [m.name, Text({ text: m.email, tone: 'muted', className: 'member-mail' })]
          : m.email,
      }),
      TableCell({
        children: Select({
          block: false,
          attrs: { 'data-act': 'role', 'aria-label': 'Rolle' },
          options: MEMBER_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r], selected: r === m.role })),
        }),
      }),
      TableCell({
        children: Badge({
          label: STATUS_LABEL[m.status],
          tone: m.status === 'active' ? 'accent' : m.status === 'invited' ? 'neutral' : 'muted',
        }),
      }),
      TableCell({
        nowrap: true,
        muted: true,
        children: m.lastSeenAt ? new Date(m.lastSeenAt).toLocaleDateString('de-DE') : '—',
      }),
      // On a div inside the cell, never on the `<td>`: a flex table cell stops
      // participating in the table's column sizing, which makes every row a
      // different height and pushes the buttons past the dialog's edge.
      TableCell({ children: el('div', { class: 'member-actions' }, actions) }),
    ],
  });
}

function render(): void {
  const body = root?.querySelector('#member-rows');
  if (!body) return;
  body.replaceChildren(
    ...(members.length
      ? members.map(row)
      : [
          TableRow({
            children: TableCell({
              colspan: 5,
              muted: true,
              children: Text({ text: 'Noch niemand eingeladen.', placeholder: true }),
            }),
          }),
        ]),
  );
}

function say(message: string, kind: 'ok' | 'error' = 'ok'): void {
  const slot = root?.querySelector('#member-note') as HTMLElement | null;
  if (!slot) return;
  slot.replaceChildren(
    ...(message
      ? [
          Callout({
            text: message,
            tone: kind === 'error' ? 'danger' : 'info',
            // `alert` rather than `status`: every one of these is the result of
            // something the admin just did, so interrupting is right.
            role: 'alert',
            className: 'member-note',
          }),
        ]
      : []),
  );
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
  const box = root?.querySelector('#member-invite') as HTMLElement | null;
  const field = root?.querySelector('#member-invite-url') as HTMLInputElement | null;
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
  if (!root) return;

  root.querySelector('#member-invite-form')!.addEventListener('submit', async (ev) => {
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
  root.querySelector('#member-rows')!.addEventListener('click', (ev) => {
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

  root.querySelector('#member-rows')!.addEventListener('change', (ev) => {
    const select = ev.target as HTMLSelectElement;
    if (select.dataset.act !== 'role') return;
    const email = select.closest('tr')?.getAttribute('data-email');
    if (email) void act(email, { role: select.value }, `Rolle von ${email} geändert.`);
  });

  root.querySelector('#member-invite-copy')!.addEventListener('click', async () => {
    const field = root!.querySelector('#member-invite-url') as HTMLInputElement;
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

}

/**
 * The section's markup, built here rather than carried in the app shell.
 *
 * Nothing in this module runs until an admin opens the section, so building it
 * on mount keeps the whole surface — and its stylesheet — off the path every
 * other visitor takes. It also means the shell has no markup for a feature most
 * instances never switch on. The heading and the close button are the area's,
 * which is what this stopped drawing when it stopped being a dialog.
 */
function build(): HTMLElement {
  return el('div', { class: 'member-screen' }, [
      el('form', { id: 'member-invite-form', class: 'member-invite-form' }, [
        TextInput({
          type: 'email',
          name: 'email',
          placeholder: 'adresse@example.com',
          required: true,
          attrs: { 'aria-label': 'E-Mail-Adresse einladen' },
        }),
        Select({
          name: 'role',
          block: false,
          attrs: { 'aria-label': 'Rolle' },
          options: MEMBER_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r], selected: r === 'editor' })),
        }),
        Button({ label: 'Einladen', type: 'submit' }),
      ]),

      el('div', { id: 'member-note' }),

      el('div', { id: 'member-invite', class: 'member-invite', hidden: true }, [
        Text({
          as: 'p',
          children: [
            'Einladungslink für ',
            el('strong', { class: 'member-invite-for' }),
            '. Er wird nur dieses eine Mal angezeigt. Die Person kann sich auch einfach unter der normalen Adresse anmelden: die Einladung hängt an ihrer E-Mail-Adresse, nicht am Link.',
          ],
        }),
        el('div', { class: 'member-invite-row' }, [
          TextInput({
            id: 'member-invite-url',
            readonly: true,
            attrs: { 'aria-label': 'Einladungslink' },
          }),
          Button({ label: 'Kopieren', variant: 'outline', attrs: { id: 'member-invite-copy' } }),
        ]),
      ]),

      el('div', { class: 'member-table-wrap' }, [
        Table({
          className: 'member-table',
          children: [
            TableHead({ columns: ['Person', 'Rolle', 'Status', 'Zuletzt', ''] }),
            el('tbody', { id: 'member-rows' }),
          ],
        }),
      ]),
  ]);
}

/**
 * Mount the screen into the settings area, loading the list fresh.
 *
 * Fresh on every mount rather than cached, for the reason the dialog reloaded on
 * every open: roles and statuses change while the section is closed, and a stale
 * table is a table an admin acts on.
 *
 * The listeners are wired to the freshly built subtree each time. That is not a
 * leak — `unmountMemberAdmin` drops the whole subtree, and the listeners go with
 * the nodes they sit on.
 */
export async function mountMemberAdmin(container: HTMLElement): Promise<void> {
  root = build();
  container.replaceChildren(root);
  wire();
  say('');
  (root.querySelector('#member-invite') as HTMLElement).hidden = true;
  try {
    await reload();
  } catch (e) {
    say(e instanceof Error ? e.message : String(e), 'error');
  }
}

/**
 * Drop the screen when another section takes the panel.
 *
 * `members` is cleared with it: keeping the last roster around would let a
 * re-mount paint stale rows for the instant before the reload answers, and those
 * rows carry role dropdowns somebody can click.
 */
export function unmountMemberAdmin(): void {
  root = null;
  members = [];
}
