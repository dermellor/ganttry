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
  group: string;
  /** German, like the rest of the interface — see „user-facing text" below. */
  label: string;
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

// German because this is interface text, and it travels with the declaration
// rather than sitting in a lookup table on the client for one reason: a table
// keyed by setting name is exactly the „the page knows each setting" coupling
// this module exists to avoid, and it would make every new setting an interface
// change again. The repository's own language stays English (AGENTS.md); the
// interface is German (CONTRIBUTING.md), and these strings are interface.

/**
 * What every section says when the server answers `access_control_disabled`.
 *
 * A refusal, so it stays: both sections of the area hit the same 503 from the same
 * branch, and one text for it keeps two from telling different stories about one
 * refusal. It names the variable and stops there — what being off implies for roles
 * and for the administration screen was explanation on top of the refusal.
 */
export const ACCESS_CONTROL_OFF_TEXT =
  'Die Zugriffskontrolle ist auf dieser Instanz aus: TIMELINES_ACCESS_CONTROL=true schaltet sie ein.';

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
    group: 'Zugang',
    label: 'Zugriffskontrolle',
    home: 'env',
    editable: false,
    expose: 'value',
    // The gate's own reading, so „an" here and „an" in the API cannot diverge.
    // Only the exact string `true` counts; anything else leaves it off.
    resolve: (raw) => String(accessControlEnabled(raw)),
  },
  {
    key: 'TIMELINES_BOOTSTRAP_ADMIN',
    group: 'Zugang',
    label: 'Master-Key (erster Administrator)',
    home: 'env',
    editable: false,
    // Presence only. The address is the one identity that can promote itself
    // past an empty member list, and naming it here would hand anybody who
    // reaches this page the exact account worth attacking.
  },
  {
    key: 'AUTH_REQUIRED',
    group: 'Zugang',
    label: 'Anmeldung erforderlich',
    home: 'env',
    editable: false,
    expose: 'value',
    // The gate compares against the literal `true` (netlify/edge-functions/auth.ts).
    resolve: (raw) => String(raw === 'true'),
  },
  {
    key: 'ALLOWED_EMAIL_DOMAINS',
    group: 'Zugang',
    label: 'Erlaubte Anmelde-Domains',
    home: 'env',
    editable: false,
    expose: 'value',
  },
  {
    key: 'TIMELINES_TRUSTED_IDENTITY_HEADER',
    group: 'Zugang',
    label: 'Identitäts-Header des Proxys',
    home: 'env',
    editable: false,
    expose: 'value',
  },
  {
    key: 'TIMELINES_ALLOWED_EMAIL_DOMAINS',
    group: 'Zugang',
    label: 'Erlaubte Domains hinter dem Proxy',
    home: 'env',
    editable: false,
    expose: 'value',
  },
  {
    key: 'MCP_TOKEN_ROLE',
    group: 'Automation',
    label: 'Rolle der Service-Token',
    home: 'env',
    editable: false,
    expose: 'value',
    resolve: serviceRoleFrom,
  },
  {
    key: 'MCP_API_TOKEN',
    group: 'Automation',
    label: 'Service-Token',
    home: 'env',
    editable: false,
    // Presence only: it is a bearer credential.
  },
  {
    key: 'TIMELINES_DATABASE_URL',
    group: 'Daten',
    label: 'Postgres-Verbindung',
    home: 'env',
    editable: false,
    // Presence only: a connection string carries its own password.
  },
  {
    key: 'TIMELINES_SUPABASE_URL',
    group: 'Daten',
    label: 'Supabase-Projekt',
    home: 'env',
    editable: false,
    // Presence only. The URL alone is not a credential, but the pair is what
    // makes an instance reachable, and „fail closed" decides the doubtful case.
  },
  {
    key: 'TIMELINES_SUPABASE_SERVICE_KEY',
    group: 'Daten',
    label: 'Supabase-Service-Key',
    home: 'env',
    editable: false,
    // Presence only: it is the service-role key.
  },
  {
    key: 'TIMELINES_DB_LIVE',
    group: 'Daten',
    label: 'Live-Updates',
    home: 'env',
    editable: false,
    expose: 'value',
  },
  {
    key: 'TIMELINES_DATA_DIR',
    group: 'Daten',
    label: 'Datenverzeichnis',
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
    group: 'Daten',
    label: 'Gebaute Datenquellen',
    home: 'build',
    editable: false,
    expose: 'value',
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
export function declareSetting(decl: SettingDeclaration, raw: string | undefined | null): DeclaredSetting {
  // Trimmed before anything else, so a variable set to spaces in a hosting
  // dashboard reads as the typo it is rather than as a configured value.
  const value = (raw ?? '').trim();
  const out: DeclaredSetting = {
    key: decl.key,
    group: decl.group,
    label: decl.label,
    home: decl.home,
    editable: decl.editable,
    set: value !== '',
  };
  if (decl.expose === 'value') out.value = decl.resolve ? decl.resolve(value) : value;
  return out;
}

/**
 * Read this instance's values into every declaration.
 *
 * `read` is the runtime's own environment accessor — `Deno.env.get`, the Node
 * cascade's `envValue`, or `process.env` in the dev middleware. Passing it in is
 * what keeps this module out of `node:*` and therefore usable in all three.
 */
export function declaredSettings(read: (key: string) => string | undefined | null): DeclaredSetting[] {
  return REGISTRY.map((decl) => declareSetting(decl, read(decl.key)));
}
