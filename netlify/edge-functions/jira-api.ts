// Netlify Edge Function — JIRA issue-picker proxy.
//
// Handles GET /api/jira/search?q=<query> for the autosuggest in the editor.
// Proxies JIRA Cloud's issue picker using a single service-account token
// (search is read-only suggestion data — the link itself is stored in the
// timeline JSON/sheet, so per-user attribution isn't needed here).
//
// Gated behind the auth session: only logged-in (whitelisted-domain) users
// reach it. The browser never sees the JIRA credentials.
//
// Required env vars (Netlify dashboard):
//   JIRA_ENABLED     — "true" to activate this proxy
//   JIRA_BASE_URL    — e.g. https://your-org.atlassian.net
//   JIRA_EMAIL       — service-account email
//   JIRA_API_TOKEN   — service-account API token (secret)

import type { Context, Config } from '@netlify/edge-functions';
import { readSession } from './_shared/session.ts';
import { basicAuthHeader, buildPickerUrl, parsePickerResponse } from '../../scripts/jira/picker.ts';

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async function handler(req: Request, _ctx: Context): Promise<Response | void> {
  if (Deno.env.get('JIRA_ENABLED') !== 'true') return;

  const url = new URL(req.url);
  if (url.pathname !== '/api/jira/search') return;
  if (req.method !== 'GET') return jsonResponse({ error: 'method not allowed' }, 405);

  // Require a valid session when the auth gate is active.
  if (Deno.env.get('AUTH_REQUIRED') === 'true') {
    const session = await readSession(req);
    if (!session) return jsonResponse({ error: 'unauthorized' }, 401);
  }

  const baseUrl = Deno.env.get('JIRA_BASE_URL') ?? '';
  const email = Deno.env.get('JIRA_EMAIL') ?? '';
  const apiToken = Deno.env.get('JIRA_API_TOKEN') ?? '';
  if (!baseUrl || !email || !apiToken) {
    return jsonResponse({ error: 'jira_not_configured' }, 503);
  }

  const query = (url.searchParams.get('q') ?? '').trim();
  if (!query) return jsonResponse({ issues: [] });

  try {
    const upstream = await fetch(buildPickerUrl(baseUrl, query), {
      headers: {
        Authorization: basicAuthHeader(email, apiToken),
        Accept: 'application/json',
      },
    });
    if (!upstream.ok) {
      return jsonResponse({ error: 'jira_request_failed', status: upstream.status }, 502);
    }
    const data = await upstream.json();
    return jsonResponse({ issues: parsePickerResponse(data) });
  } catch (err) {
    return jsonResponse({ error: 'jira_request_failed', detail: String(err) }, 502);
  }
}

export const config: Config = {
  path: '/api/jira/search',
};
