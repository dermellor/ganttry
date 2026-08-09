// Admission to the self-hosted server: is there a trusted identity on this
// request at all?
//
// Deliberately NOT named `access`, and deliberately not in `src/`. The role
// model (#46) puts the *authorization* rules in `src/access.ts` — which
// capability a request needs, whether a role has it, whether a membership
// counts — shared by every runtime. This module answers the question one layer
// below and only for `scripts/serve.ts`: may this caller in at all. Two modules
// called "access" answering different questions is the confusion worth spending
// a rename to avoid.
//
// `scripts/serve.ts` has no login of its own and is not going to grow one: the
// deployments this serves already have an identity provider in front (oauth2-proxy,
// Authelia, an SSO ingress), and re-implementing OAuth badly next to it would be
// worse than trusting the proxy that already did it. What this decides is only
// whether a request carries an identity the operator said to trust.
//
// A pure function rather than middleware because the interesting part is the
// policy, not the plumbing — this way the rules are unit-tested against a table
// of cases instead of against a running server.

/** What the operator configured, already read from the environment. */
export type AccessConfig = {
  /**
   * Lower-cased name of the header a trusted proxy sets, e.g. `x-forwarded-email`.
   * Empty/undefined disables the gate entirely: no identity, and anyone who can
   * reach the port can edit.
   */
  identityHeader?: string;
  /**
   * Optional allow-list of e-mail domains, mirroring `ALLOWED_EMAIL_DOMAINS` on
   * the Netlify gate. Empty means any domain the proxy vouches for.
   */
  allowedDomains?: string[];
};

export type AccessDecision =
  | { allow: true; email?: string }
  | { allow: false; status: 401 | 403; error: string; detail: string };

/**
 * Is this path readable without an identity?
 *
 * Only the public pricing endpoint, which is public by contract (`security: []`
 * in openapi.yaml) and consumed by external pages that have no session. Gating
 * it would break the one integration the API explicitly promises.
 */
export function isPublicPath(pathname: string): boolean {
  return pathname === '/api/pricing' || pathname.startsWith('/api/pricing/');
}

/** Parse a comma-separated domain list; empty entries are dropped. */
export function parseDomains(raw: string | undefined | null): string[] {
  return (raw ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

/**
 * Decide whether a request may proceed.
 *
 * `identity` is the raw header value the server read, or undefined when the
 * header was absent.
 *
 * The rule that matters: once an identity header is configured, a request
 * WITHOUT it is refused. Accepting it would defeat the whole arrangement — the
 * proxy would be enforcing nothing for anyone who reaches the origin directly,
 * and "we have SSO in front" is exactly the belief that makes a bypassed origin
 * dangerous. Fail closed, and let the operator open it by not configuring a
 * header at all, which is at least an honest statement.
 */
export function decideAccess(
  pathname: string,
  identity: string | undefined,
  config: AccessConfig,
): AccessDecision {
  if (isPublicPath(pathname)) return { allow: true };
  // No gate configured: the server is open by the operator's choice, and says so
  // loudly on every start.
  if (!config.identityHeader) return { allow: true };

  const email = identity?.trim().toLowerCase();
  if (!email) {
    return {
      allow: false,
      status: 401,
      error: 'unauthenticated',
      detail: `No ${config.identityHeader} header. This server expects an authenticating proxy in front of it.`,
    };
  }

  const domains = config.allowedDomains ?? [];
  if (domains.length) {
    const at = email.lastIndexOf('@');
    const domain = at === -1 ? '' : email.slice(at + 1);
    // Exact match only. A suffix test would let `evil-example.com` through a
    // list containing `example.com`.
    if (!domains.includes(domain)) {
      return {
        allow: false,
        status: 403,
        error: 'forbidden',
        detail: 'Your e-mail domain is not in TIMELINES_ALLOWED_EMAIL_DOMAINS.',
      };
    }
  }

  return { allow: true, email };
}
