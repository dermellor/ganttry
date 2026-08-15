// „Konto" — what the person looking at this deployment set for themselves.
//
// The first **writable** setting in the settings area, and the first section of it
// that is about the reader rather than about the deployment. Both firsts were
// anticipated: „Editing. `editable` exists and the interface reads it; nothing
// declares `true` yet" (docs/settings.md), and „The row is not the place for
// „Konto" either: there is no account surface, and a heading over an empty one
// would be inventing a level rather than naming it"
// (docs/information-architecture.md). A per-person preference is what makes that
// surface non-empty, which is the condition that sentence set.
//
// It sits in the **instance** area rather than getting a level of its own, because
// the scope is „this person, on this deployment" — the same deployment the other
// sections describe. „Scope equals storage" (information-architecture.md) then
// puts the store on `app_users`, one row per person per instance, which is what
// migration 0025 does.
//
// The instance section next door is a table of values this page cannot change.
// This one is the opposite, and that is the point of putting them side by side:
// „An area that is 80% values you cannot change there teaches people to ignore it,
// and once ignored the editable remainder is missed too" (docs/settings.md).

import { Field, SegmentedControl } from './design-system';
import { LOCALES, locale, setLocale, t, type Locale } from './i18n';

/** The event the area listens for: every label on screen is now in another language. */
export const LOCALE_CHANGED = 'zeitlines:locale-changed';

/**
 * Where a choice gets written, which is a different fact from what was chosen.
 *
 * A deployment with no `app_users` table has nobody to store a preference for, so
 * the honest answer is „this device" rather than a profile that does not exist.
 * The interface says so with a label, for the reason the „Herkunft" badge exists
 * one section over: where a value lives is most of what somebody is asking. Saying
 * nothing would let a person expect the setting to follow them to another browser.
 */
type Scope = 'profile' | 'device';

/**
 * Whether this deployment can store a preference at all.
 *
 * `stored` on the write is the authoritative answer and comes back from the route;
 * this is the same question asked before anything is written, so the label is right
 * on first paint rather than only after the first switch.
 */
async function storageScope(): Promise<Scope> {
  try {
    const res = await fetch('/api/preferences');
    if (!res.ok) return 'device';
    // A served `null` is „nothing stored for you", which on a database instance
    // still means the profile is where a choice would go. Scope is about where a
    // write lands, not about whether one has happened — so the body is not
    // consulted here beyond the route having answered at all.
    await res.json();
    return 'profile';
  } catch {
    return 'device';
  }
}

/**
 * Persist the choice, and report where it landed.
 *
 * The device is written **first and unconditionally** (`setLocale`), because that
 * is the store that always exists and the one the next page load paints from. The
 * request is the part only some deployments can honour. The other order would make
 * a switch on a file-backed instance look like it failed.
 */
async function persist(next: Locale): Promise<Scope> {
  setLocale(next);
  try {
    const res = await fetch('/api/preferences', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: next }),
    });
    if (!res.ok) return 'device';
    const data = (await res.json()) as { stored?: unknown };
    return data.stored === true ? 'profile' : 'device';
  } catch {
    return 'device';
  }
}

export async function mountAccount(root: HTMLElement): Promise<void> {
  const scope = await storageScope();

  const picker = SegmentedControl({
    ariaLabel: t('account.language'),
    segments: LOCALES.map((value) => ({
      value,
      // The language's own name, in both catalogues, never translated: somebody
      // switching *away* from a language they cannot read has to recognise the
      // target in the list.
      label: t(value === 'de' ? 'account.language.de' : 'account.language.en'),
      selected: value === locale(),
      on: {
        click: () => {
          if (value === locale()) return;
          void persist(value).then(() => {
            // The whole area is rebuilt rather than this control patched: every
            // label in it, the section nav beside it included, is now in the other
            // language. Repainting one control would leave a German nav over an
            // English page, which reads as a bug in the switch that just worked.
            window.dispatchEvent(new CustomEvent(LOCALE_CHANGED));
          });
        },
      },
    })),
  });

  root.replaceChildren(
    Field({
      label: t('account.language'),
      className: 'account-language',
      control: picker,
      // „Nur auf diesem Gerät" only where that is the whole truth. On a deployment
      // that stores it, saying so would be a note restating what „Konto" already
      // means — the kind of sentence „Interface text" (AGENTS.md) rules out.
      hint: scope === 'device' ? t('account.local') : undefined,
    }),
  );
}
