// „Is this connection string local?" — the rule behind every destructive guard.
//
// It lives in its own module because `reset.ts` runs on import: it is a script,
// so importing it to reach these two functions executes its guard and exits the
// process. Anything else that needs the same answer (the migration test, and
// whatever destructive tooling comes next) would otherwise have to restate the
// host list, which is how one copy learns about a new loopback spelling and the
// other does not.
//
// Pure, no database, no env: the two callers differ only in what they do with a
// `false`.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

/** The host a connection string points at, or null if it cannot be parsed. */
export function urlHost(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

/**
 * Local, and therefore safe to drop.
 *
 * An unparseable string answers false: „I cannot tell" has to mean „do not wipe
 * it", because the alternative is a guard that opens on malformed input.
 */
export function isLocalUrl(url: string): boolean {
  const host = urlHost(url);
  return host !== null && LOCAL_HOSTS.has(host);
}
