// JIRA linking — shared client helpers.
//
// Linked issues live in an item's `metadata.jira` as an array of
// `{ key, summary }` (summary cached so links stay readable without a live
// JIRA call). Autosuggest hits `/api/jira/search?q=` which is served by the
// Vite dev middleware locally and by the `jira-api` Netlify Edge Function in
// production. Both proxy JIRA Cloud's issue picker; the browser never sees
// the JIRA credentials.

export type JiraIssue = {
  key: string;
  summary: string;
};

// Base URL for `…/browse/<KEY>` links. Public, build-time — set
// VITE_JIRA_BASE_URL to your Atlassian Cloud origin.
const RAW_BASE = (import.meta.env.VITE_JIRA_BASE_URL ?? 'https://your-org.atlassian.net') as string;
export const JIRA_BASE_URL = RAW_BASE.replace(/\/+$/, '');

// Match a JIRA issue key like "ABC-123" (project key is 2+ uppercase
// alphanumerics starting with a letter, then a number).
const KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

export function isJiraKey(s: string): boolean {
  return KEY_RE.test(s.trim().toUpperCase());
}

export function normalizeKey(s: string): string {
  return s.trim().toUpperCase();
}

export function jiraBrowseUrl(key: string): string {
  return JIRA_BASE_URL ? `${JIRA_BASE_URL}/browse/${encodeURIComponent(key)}` : '';
}

// Read linked issues out of an item's metadata, tolerating older/looser
// shapes: an array of strings ("ABC-1") or of objects ({ key, summary }).
export function readJiraIssues(metadata: unknown): JiraIssue[] {
  if (!metadata || typeof metadata !== 'object') return [];
  const raw = (metadata as Record<string, unknown>).jira;
  if (!Array.isArray(raw)) return [];
  const out: JiraIssue[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    let key = '';
    let summary = '';
    if (typeof entry === 'string') {
      key = normalizeKey(entry);
    } else if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      key = normalizeKey(String(obj.key ?? ''));
      summary = typeof obj.summary === 'string' ? obj.summary : '';
    }
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ key, summary });
  }
  return out;
}

let searchAbort: AbortController | null = null;

// Query the proxy for issue suggestions. Returns [] when the endpoint is
// unavailable (e.g. a static export or a misconfigured deploy) so callers can
// degrade gracefully. Cancels any in-flight request.
export async function searchJira(query: string): Promise<JiraIssue[]> {
  const q = query.trim();
  if (!q) return [];

  searchAbort?.abort();
  const ctrl = new AbortController();
  searchAbort = ctrl;

  try {
    const res = await fetch(`/api/jira/search?q=${encodeURIComponent(q)}`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { issues?: JiraIssue[] };
    return Array.isArray(data.issues) ? data.issues : [];
  } catch {
    return [];
  } finally {
    if (searchAbort === ctrl) searchAbort = null;
  }
}

// Build the inline HTML used for the detail-panel "JIRA" meta row.
export function jiraLinksHtml(
  issues: JiraIssue[],
  escape: (s: string) => string,
): string {
  if (!issues.length) return '';
  return issues
    .map((iss) => {
      const url = jiraBrowseUrl(iss.key);
      const label = iss.summary
        ? `${iss.key} – ${iss.summary}`
        : iss.key;
      if (!url) return `<span class="jira-ref">${escape(label)}</span>`;
      return `<a class="jira-ref" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(label)}</a>`;
    })
    .join('');
}
