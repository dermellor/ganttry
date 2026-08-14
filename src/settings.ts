// What this instance is: every setting declares where it lives, whether it can
// be changed here, and whether its value may be served at all.
//
// Instance-wide state sits in three places — the host's environment, the
// committed config, and what the build discovered — and none of them is visible
// from inside the running app. Answering „does this deployment require sign-in,
// who may administer it, what do the automations act as" meant reading an env
// file, a hosting dashboard and `psql`, and knowing in advance which of the
// three held the answer.
//
// The failure mode this module is shaped against is deciding „env or database"
// once per setting and encoding that decision in the page, because then the page
// has to know each setting by name and every new one is an interface change.
// Instead each setting declares itself and the page renders declarations. Adding
// a setting is a line in REGISTRY below and nothing else — `settings.test.ts`
// asserts that, since it is the only thing that makes the shape more than a
// struct around a value.
//
// This repo already decides editability exactly this way, twice, and both times
// the rule is the same: the runtime declares it and the client never guesses. A
// source adapter's `SourceCapabilities { editable, live }` travel to the client,
// and a local source gets `view.source.editable` stamped at build time — both so
// the client routes deterministically instead of probing (docs/architecture.md).
// A client that tries a write to find out whether it is allowed learns the answer
// from a failure, at a moment when the user has already typed something.
//
// Pure, DOM-free and free of `node:*` on purpose: the browser renders the result,
// the Deno edge function and the Node server produce it, and the three must not
// disagree. Reading the environment is the runtime's job — every entry point
// passes its own reader into `declaredSettings`, the same way `accessControlEnabled`
// takes a raw string rather than reaching for `process.env` itself.

// Explicit `.ts`, because this module is reachable from the edge function and
// Deno resolves specifiers literally (scripts/ci/edge-imports.test.ts).
import { accessControlEnabled, serviceRoleFrom } from './access.ts';
import { translate, type MessageKey } from './i18n/catalogue.ts';
import { DEFAULT_LOCALE, normalizeLocale, type Locale } from './i18n/locale.ts';
import type { DeclaredSetting, SettingHome } from './types';

/**
 * One declared setting, before this instance's value is read into it.
 *
 * `resolve` is why this type is not the served one: it is a function, so a
 * declaration is code and only its result crosses the API.
 */
export type SettingDeclaration = {
  /** The environment variable, or the build value's name. Serves as the row id. */
  key: string;
  /** Section heading this row sits under. Ordering follows first appearance. */
  groupKey: MessageKey;
  /**
   * The catalogue key for this row's label, resolved into the caller's language
   * **before it is served** — see „The label is resolved on the server" below.
   */
  labelKey: MessageKey;
  home: SettingHome;
  editable: boolean;
  /**
   * Whether the VALUE may be served, or only whether it is set.
   *
   * Absent means presence only, and that direction is deliberate: a setting
   * added without thinking about this one is withheld rather than exposed. The
   * argument „the operator interface needs it" is not a reason to serve a
   * secret, and the same reasoning that makes the member list `manage`-only does
   * not generalise to a connection string.
   */
  expose?: 'value';
  /**
   * The effective value from the raw one, when the two differ.
   *
   * `MCP_TOKEN_ROLE=nonsense` acts as `editor`, and a page showing `nonsense`
   * would describe an instance that does not exist. Every resolver here is the
   * parser the runtime actually uses, imported rather than restated.
   */
  resolve?: (raw: string) => string;
};

// ---- The label is resolved on the server -----------------------------------
//
// A declaration carries a catalogue *key*, and `declaredSettings` resolves it into
// the caller's language before the row goes over the wire. The served shape
// (`DeclaredSetting`) is unchanged: it still carries a finished `label` string.
//
// That split is what keeps this module's whole point intact. The page must not
// hold a table keyed by setting name — that is exactly the „the page knows each
// setting" coupling this module exists to avoid, and shipping a *key* to the
// client would have rebuilt it, one lookup per new setting. Resolving on the
// server means the client keeps rendering a string it never has to look up, and a
// new setting stays one line here.
//
// The server can do this because it knows who is asking: `/api/settings` sits
// behind the auth gate and the caller's row carries their language (migration
// `0025`). The catalogue is DOM-free and `.ts`-suffixed for the same reason this
// module is — the Deno edge function and the Node server both import it.

/**
 * Every setting this instance has.
 *
 * Order is the order on the page. Nothing here is editable yet, and that is a
 * property of what exists rather than of the mechanism: the first setting the
 * app itself writes is the plugin registry from the plugin-lifecycle work, and
 * it arrives with `home: 'db'` and `editable: true` without this file learning
 * anything new.
 */
export const REGISTRY: readonly SettingDeclaration[] = [
  {
    key: 'TIMELINES_ACCESS_CONTROL',
    groupKey: 'setting.group.access',
    labelKey: 'setting.TIMELINES_ACCESS_CONTROL',
    home: 'env',
    editable: false,
    expose: 'value',
    // The gate's own reading, so „an" here and „an" in the API cannot diverge.
    // Only the exact string `true` counts; anything else leaves it off.
    resolve: (raw) => String(accessControlEnabled(raw)),
  },
  {
    key: 'TIMELINES_BOOTSTRAP_ADMIN',
    groupKey: 'setting.group.access',
    labelKey: 'setting.TIMELINES_BOOTSTRAP_ADMIN',
    home: 'env',
    editable: false,
    // Presence only. The address is the one identity that can promote itself
    // past an empty member list, and naming it here would hand anybody who
    // reaches this page the exact account worth attacking.
  },
  {
    key: 'AUTH_REQUIRED',
    groupKey: 'setting.group.access',
    labelKey: 'setting.AUTH_REQUIRED',
    home: 'env',
    editable: false,
    expose: 'value',
    // The gate compares against the literal `true` (netlify/edge-functions/auth.ts).
    resolve: (raw) => String(raw === 'true'),
  },
  {
    key: 'ALLOWED_EMAIL_DOMAINS',
    groupKey: 'setting.group.access',
    labelKey: 'setting.ALLOWED_EMAIL_DOMAINS',
    home: 'env',
    editable: false,
    expose: 'value',
  },
  {
    key: 'TIMELINES_TRUSTED_IDENTITY_HEADER',
    groupKey: 'setting.group.access',
    labelKey: 'setting.TIMELINES_TRUSTED_IDENTITY_HEADER',
    home: 'env',
    editable: false,
    expose: 'value',
  },
  {
    key: 'TIMELINES_ALLOWED_EMAIL_DOMAINS',
    groupKey: 'setting.group.access',
    labelKey: 'setting.TIMELINES_ALLOWED_EMAIL_DOMAINS',
    home: 'env',
    editable: false,
    expose: 'value',
  },
  {
    key: 'MCP_TOKEN_ROLE',
    groupKey: 'setting.group.automation',
    labelKey: 'setting.MCP_TOKEN_ROLE',
    home: 'env',
    editable: false,
    expose: 'value',
    resolve: serviceRoleFrom,
  },
  {
    key: 'MCP_API_TOKEN',
    groupKey: 'setting.group.automation',
    labelKey: 'setting.MCP_API_TOKEN',
    home: 'env',
    editable: false,
    // Presence only: it is a bearer credential.
  },
  {
    key: 'TIMELINES_DATABASE_URL',
    groupKey: 'setting.group.data',
    labelKey: 'setting.TIMELINES_DATABASE_URL',
    home: 'env',
    editable: false,
    // Presence only: a connection string carries its own password.
  },
  {
    key: 'TIMELINES_SUPABASE_URL',
    groupKey: 'setting.group.data',
    labelKey: 'setting.TIMELINES_SUPABASE_URL',
    home: 'env',
    editable: false,
    // Presence only. The URL alone is not a credential, but the pair is what
    // makes an instance reachable, and „fail closed" decides the doubtful case.
  },
  {
    key: 'TIMELINES_SUPABASE_SERVICE_KEY',
    groupKey: 'setting.group.data',
    labelKey: 'setting.TIMELINES_SUPABASE_SERVICE_KEY',
    home: 'env',
    editable: false,
    // Presence only: it is the service-role key.
  },
  {
    key: 'TIMELINES_DB_LIVE',
    groupKey: 'setting.group.data',
    labelKey: 'setting.TIMELINES_DB_LIVE',
    home: 'env',
    editable: false,
    expose: 'value',
  },
  {
    key: 'TIMELINES_DATA_DIR',
    groupKey: 'setting.group.data',
    labelKey: 'setting.TIMELINES_DATA_DIR',
    home: 'build',
    editable: false,
    expose: 'value',
    // `build:data` writes to public/<this>, and vite.config.ts derives the
    // client's fetch prefix from the same value — so an unset variable is the
    // documented default rather than „nothing".
    resolve: (raw) => raw.trim() || 'data',
  },
  {
    key: 'TIMELINES_SOURCES_SUBDIR',
    groupKey: 'setting.group.data',
    labelKey: 'setting.TIMELINES_SOURCES_SUBDIR',
    home: 'build',
    editable: false,
    expose: 'value',
  },
  {
    key: 'TIMELINES_DEFAULT_LANGUAGE',
    groupKey: 'setting.group.access',
    labelKey: 'setting.TIMELINES_DEFAULT_LANGUAGE',
    home: 'env',
    // Not editable here, and that is the same answer every `home: 'env'` row
    // gives: this page cannot write a hosting dashboard. What *is* editable now
    // is the per-person choice, and it lives one section over (`#settings=account`)
    // because it belongs to the reader rather than to the deployment.
    editable: false,
    expose: 'value',
    // The resolver the interface actually uses, so this row cannot claim a
    // language the app would not render. An unset or misspelt variable shows the
    // product default rather than the typo — the same reasoning as MCP_TOKEN_ROLE.
    resolve: (raw) => normalizeLocale(raw) ?? DEFAULT_LOCALE,
  },
];

/**
 * One declaration plus this instance's raw value, as it goes over the wire.
 *
 * Separate from `declaredSettings` so the read gate can be tested against a
 * declaration the registry does not contain — which is the whole acceptance
 * criterion: a setting nothing has heard of has to come out fully rendered. A
 * test that could only reach this through `REGISTRY` would prove that the
 * registry works, not that the mechanism does.
 *
 * A declaration without `expose: 'value'` yields no `value` field at all, rather
 * than an empty or masked one: a redacted string is still a claim about length
 * and shape, and an absent field cannot be un-redacted by a client that decides
 * to render it anyway.
 */
export function declareSetting(
  decl: SettingDeclaration,
  raw: string | undefined | null,
  locale: Locale = DEFAULT_LOCALE,
): DeclaredSetting {
  // Trimmed before anything else, so a variable set to spaces in a hosting
  // dashboard reads as the typo it is rather than as a configured value.
  const value = (raw ?? '').trim();
  const out: DeclaredSetting = {
    key: decl.key,
    group: translate(locale, decl.groupKey),
    label: translate(locale, decl.labelKey),
    home: decl.home,
    editable: decl.editable,
    set: value !== '',
  };
  if (decl.expose === 'value') out.value = decl.resolve ? decl.resolve(value) : value;
  return out;
}

/**
 * Read this instance's values into every declaration, in the caller's language.
 *
 * `read` is the runtime's own environment accessor — `Deno.env.get`, the Node
 * cascade's `envValue`, or `process.env` in the dev middleware. Passing it in is
 * what keeps this module out of `node:*` and therefore usable in all three.
 *
 * `locale` defaults rather than being required, because two of the three runtimes
 * reach this before they have resolved a caller — and a page of untranslated keys
 * is a worse answer to „who is asking?" than a page in the product default.
 */
export function declaredSettings(
  read: (key: string) => string | undefined | null,
  locale: Locale = DEFAULT_LOCALE,
): DeclaredSetting[] {
  return REGISTRY.map((decl) => declareSetting(decl, read(decl.key), locale));
}
