// Which language the interface speaks, and how that is decided for one person.
//
// The language is a property of the **reader**, not of the deployment and not of
// the source: one instance has German and English speakers looking at the same
// timelines. So there is no build flag and no instance-wide switch that decides
// it for everybody — there is a preference per person, and three places it can
// come from.
//
// Pure, DOM-free and free of `node:*` on purpose. The browser resolves a locale
// to render with, and the Deno edge function and the Node server resolve the same
// one to translate a settings label before serving it (see „The label is resolved
// on the server" in docs/settings.md). Three runtimes must not disagree about what
// `de-AT` or an empty string means.

/**
 * The languages the interface has. Two, and adding a third is a catalogue plus a
 * line here — deliberately a closed union rather than an open string, so a typo
 * in a database column cannot become a language nothing has messages for.
 */
export const LOCALES = ['de', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * What a fresh instance speaks when nobody has said otherwise.
 *
 * English, because the documentation, the site and the tracker are English and a
 * fresh install is by definition somebody who has not met the German interface.
 * This is the **product** default and deliberately not a statement about any
 * existing deployment: an instance that was German before this shipped keeps
 * every one of its people on German, through the backfill in migration `0025`
 * and through `TIMELINES_DEFAULT_LANGUAGE`. See „Two defaults, two questions"
 * below.
 */
export const DEFAULT_LOCALE: Locale = 'en';

/**
 * A stored or declared value read as a locale, or `null` when it is not one.
 *
 * Accepts a region tag (`de-DE`, `en-GB`) by its primary subtag, because that is
 * what `navigator.language` and an `Accept-Language` header carry and refusing
 * them would mean nobody's browser ever matched. Case and surrounding space are
 * forgiven for the same reason a hosting dashboard's stray space is trimmed in
 * `declareSetting`: it reads as the typo it is rather than as a language.
 *
 * `null` rather than the default on failure, so a caller can tell „not set" from
 * „set to English" and fall through to the next source instead of stopping at
 * the first one that answered.
 */
export function normalizeLocale(raw: unknown): Locale | null {
  if (typeof raw !== 'string') return null;
  const primary = raw.trim().toLowerCase().split(/[-_]/)[0];
  return (LOCALES as readonly string[]).includes(primary) ? (primary as Locale) : null;
}

/**
 * The locale to render for one person, from the sources in precedence order.
 *
 * **Two defaults, two questions.** `chosen` is what this person picked and always
 * wins. `instanceDefault` (`TIMELINES_DEFAULT_LANGUAGE`) is what somebody who has
 * never picked gets *on this deployment* — the question „what does a new colleague
 * see", which is the operator's to answer and therefore lives in the instance
 * profile. `DEFAULT_LOCALE` answers „what does a deployment that has said nothing
 * at all speak", which is the product's to answer.
 *
 * Collapsing the two would force one of them wrong: a single product default flips
 * an existing German deployment to English on the day this ships, and a single
 * instance default leaves a fresh install with no answer at all.
 *
 * Every argument is allowed to be absent or malformed, because each comes from a
 * place that can hold nonsense — a database column, an environment variable, a
 * `localStorage` key a user can edit in a console.
 */
export function resolveLocale(sources: {
  chosen?: unknown;
  instanceDefault?: unknown;
}): Locale {
  return (
    normalizeLocale(sources.chosen) ?? normalizeLocale(sources.instanceDefault) ?? DEFAULT_LOCALE
  );
}

/**
 * The BCP 47 tag to hand `Intl` for a locale.
 *
 * A region, because the bare primary subtag is not enough for the two things this
 * is used for: `de` alone formats a date as `1.1.2026` in some runtimes and
 * `01.01.2026` in others, and a collator without a region is free to sort umlauts
 * either way. Pinning the region makes the rendering the same everywhere, which is
 * what makes a screenshot in an issue reproducible.
 */
export const INTL_TAG: Record<Locale, string> = {
  de: 'de-DE',
  en: 'en-GB',
};
