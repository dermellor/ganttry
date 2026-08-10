// Who may install a plugin.
//
// Installing is not editing. It loads third-party CODE into every session of the
// instance and grants it capabilities over other people's timelines, so it cannot
// share a permission with „may change an item". Every signed-in user being able to
// install would make the auth gate meaningless the moment one plugin is hostile.
//
// This repository has no role model. The deploy gates on a sign-in domain, which
// says „works here", not „runs the place". So the honest v1 is an explicit
// operator list plus the server-side MCP token, and the default is NOBODY:
//
//   PLUGIN_OPERATOR_EMAILS=alice@example.com,bob@example.com
//
// Unset means no HTTP caller can install, which is the fail-closed default this
// repo prefers elsewhere too (`ALLOWED_EMAIL_DOMAINS` behaves the same way). An
// operator who has not set it can still install through the MCP token or by
// writing the row, both of which require access to the server's own secrets.
//
// **This is where a role model becomes unavoidable.** A multi-tenant instance
// needs per-tenant admins, an audit trail of who granted which capability, and a
// review gate in front of the catalog (issue #15). A comma-separated env var is
// enough for one operator running their own deployment and is deliberately not
// enough for anything larger — see docs/plugin-lifecycle.md.

/** Who is asking, as far as the runtime could establish. */
export type Caller = {
  /** Signed-in address, when there is a session. */
  email?: string | null;
  /** Did the request present the server's MCP token? */
  mcp?: boolean;
};

/** Parse the configured operator list. Empty when unset — nobody passes. */
export function parseOperators(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * May this caller install, uninstall or switch a plugin off instance-wide?
 *
 * The MCP token counts, and that is a deliberate equivalence rather than a
 * loophole: it is a server-side secret only whoever configured the deployment
 * holds, so presenting it already proves operator access. Treating it as less
 * would leave the honest automation path — a script the operator runs — with no
 * way in at all.
 */
export function isOperator(caller: Caller, operators: string[]): boolean {
  if (caller.mcp) return true;
  const email = caller.email?.trim().toLowerCase();
  if (!email) return false;
  return operators.includes(email);
}

/**
 * Why a caller was refused, phrased so the answer is actionable. Naming the env
 * var matters: „forbidden" alone sends an operator looking for a bug in the
 * plugin instead of a missing line in their configuration.
 */
export function operatorRefusal(operators: string[]): string {
  return operators.length
    ? 'installing plugins is limited to this instance\'s operators (PLUGIN_OPERATOR_EMAILS)'
    : 'no plugin operators are configured on this instance; set PLUGIN_OPERATOR_EMAILS to allow it over HTTP';
}
