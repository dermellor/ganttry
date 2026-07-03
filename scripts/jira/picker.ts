// Shared JIRA issue-picker helpers — runtime-agnostic (no Node/Deno APIs),
// used by both the Vite dev middleware and the Netlify Edge Function so the
// picker-response parsing lives in exactly one place.

export type JiraIssue = {
  key: string;
  summary: string;
};

export function buildPickerUrl(baseUrl: string, query: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({
    query,
    currentJQL: 'order by lastViewed DESC',
    showSubTasks: 'true',
    showSubTaskParent: 'true',
  });
  return `${base}/rest/api/3/issue/picker?${params.toString()}`;
}

export function basicAuthHeader(email: string, apiToken: string): string {
  // btoa is available in both modern Node (18+) and Deno.
  return `Basic ${btoa(`${email}:${apiToken}`)}`;
}

// JIRA strips the matched substring into <b>…</b> in summaryText; drop the tags.
function stripTags(s: string): string {
  return s.replace(/<\/?[^>]+>/g, '');
}

type PickerSection = {
  issues?: Array<{ key?: string; summaryText?: string; summary?: string }>;
};

// Flatten the picker's sections into a de-duplicated, capped issue list.
export function parsePickerResponse(data: unknown, max = 15): JiraIssue[] {
  const sections = (data as { sections?: PickerSection[] } | null)?.sections;
  if (!Array.isArray(sections)) return [];
  const out: JiraIssue[] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    for (const issue of section.issues ?? []) {
      const key = (issue.key ?? '').trim().toUpperCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const summaryRaw = issue.summaryText ?? issue.summary ?? '';
      out.push({ key, summary: stripTags(String(summaryRaw)).trim() });
      if (out.length >= max) return out;
    }
  }
  return out;
}
