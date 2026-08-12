// The header's own menu: what is true of the instance rather than of the open
// timeline, behind one trigger at the trailing edge.
//
// It exists because the row ran out of room for a second settings entry that
// reads as one. „Einstellungen" was an outline button in the row itself, which
// worked while the timeline's gear was a sun; once that gear was drawn as a gear,
// the header offered two settings entries told apart only by where they sat (see
// „What the navigation has to provide" in docs/information-architecture.md).
//
// What it holds is decided elsewhere and only revealed here: `main.ts` offers
// „Einstellungen" to a role that may manage and „Abmelden" where there is a
// session to end. This module owns nothing but opening and closing, plus the row
// that explains an empty menu — the trigger is always on screen, so the empty case
// has to say something rather than open an empty box.

import { els } from './state';

function isOpen(): boolean {
  return !els.appMenu.hidden;
}

function open(): void {
  els.appMenu.hidden = false;
  els.appMenuBtn.setAttribute('aria-expanded', 'true');
  els.appMenu.querySelector<HTMLButtonElement>('.ds-MenuItem:not([hidden])')?.focus();
}

export function closeAppMenu(): void {
  if (!isOpen()) return;
  els.appMenu.hidden = true;
  els.appMenuBtn.setAttribute('aria-expanded', 'false');
}

/**
 * Show the explanatory row when neither action applies.
 *
 * The trigger itself is always on screen. Hiding it when the menu is empty was the
 * first shape of this, and it cost more than it bought: an ungated instance has no
 * role to administer with and no session to end, which is every instance this is
 * developed on, so the menu was invisible exactly where somebody would look for
 * it. What an empty menu must not be is an empty box — that reads as a failed
 * load, so the empty case says so in a row of its own.
 *
 * Called after the role and the identity are known, since both rows hang on that
 * answer.
 */
export function refreshAppMenu(): void {
  const rows = [els.settingsBtn, els.logoutBtn];
  els.appMenuEmpty.hidden = !rows.every((row) => row.hidden);
}

export function wireAppMenu(): void {
  els.appMenuBtn.addEventListener('click', () => (isOpen() ? closeAppMenu() : open()));

  // Opening the settings area is wired in settingsArea.ts, which knows nothing
  // about this menu. Closing it here rather than there keeps that module free of
  // the menu, and an open popover left floating over the area it just opened is
  // the thing this prevents.
  els.settingsBtn.addEventListener('click', () => closeAppMenu());

  // The gate answers `/auth/logout` with a 302 that also clears the session
  // cookie, so a navigation is the whole logout — no fetch, no state to unwind
  // here. `assign` rather than `replace`, so Back still returns to the app the
  // person was in rather than skipping past it.
  els.logoutBtn.addEventListener('click', () => {
    closeAppMenu();
    window.location.assign('/auth/logout');
  });

  // Dismissal, in the two ways a menu is left. Kept local rather than shared with
  // the switcher and the filter popover: those two carry their own copies of this
  // and unifying all three is a change to their behaviour, not to this menu's.
  document.addEventListener('click', (e) => {
    if (!isOpen()) return;
    const target = e.target as Node;
    if (!els.appMenu.contains(target) && !els.appMenuBtn.contains(target)) closeAppMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !isOpen()) return;
    closeAppMenu();
    // Back to the trigger: closing with the keyboard otherwise drops focus onto
    // the document and the next Tab starts over at the top of the page.
    els.appMenuBtn.focus();
  });
}
