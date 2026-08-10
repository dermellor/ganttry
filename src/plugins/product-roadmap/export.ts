// Pricing export: Timeline (source of truth) → Markdown.
//
// It lives in the plugin folder rather than in `scripts/` because it is this
// plugin's tool: it reads the plugin's model and renders the plugin's Markdown.
// A script in core space that knows one plugin is the coupling #17 removes, and
// a CI check now asserts core files do not import from a plugin folder.
//
// Pulls a product timeline's pricing model via the live API (same X-MCP-Token
// path as scripts/mcp/server.ts), renders it with pricingToMarkdown, and writes
// the result to a generated Markdown file in the vault. One-way: the timeline is
// authoritative; the .md is a generated artifact ("do not edit by hand").
//
// Usage:
//   npm run export:pricing -- <id>       # timeline id (or set PRICING_TIMELINE_ID)
//
// Config (read through the shared cascade in ./db/env.ts: process.env →
// <repo>/.env.local → files named by TIMELINES_ENV_FILE):
//   MCP_API_TOKEN       — required; matches the Netlify env var of the same name
//   TIMELINES_LIVE_URL  — required; base URL of the deployed site
//   PRICING_TIMELINE_ID — optional; used when no <id> arg is given
//   PRICING_MD_OUT      — optional; output path (default: <repo>/export/pricing.md)

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TimelineFile } from '../../types.ts';
import { PRODUCT_ROADMAP_PLUGIN } from './plugin.ts';
import { hasPlugin } from '../../pluginHost/plugins.ts';
import { pricingToMarkdown } from './pricing.ts';
import { currentPricing } from './compose.ts';
import { envSourcesHint, envValue } from '../../../scripts/db/env.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');

const DEFAULT_OUT = resolve(REPO_ROOT, 'export', 'pricing.md');

const BASE_URL = envValue('TIMELINES_LIVE_URL').replace(/\/+$/, '');
const API_TOKEN = envValue('MCP_API_TOKEN');

function encodeId(id: string): string {
  return id.split('/').map(encodeURIComponent).join('/');
}

async function getTimeline(id: string): Promise<TimelineFile> {
  if (!API_TOKEN) {
    throw new Error(`MCP_API_TOKEN is not set. Add it to ${envSourcesHint()} (matching the Netlify env var).`);
  }
  const res = await fetch(`${BASE_URL}/api/source/${encodeId(id)}`, {
    headers: { 'X-MCP-Token': API_TOKEN, Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET /api/source/${id} → ${res.status}${text ? ` — ${text.slice(0, 300)}` : ''}`);
  const data = text ? (JSON.parse(text) as TimelineFile) : ({} as TimelineFile);
  if (!data || !Array.isArray(data.items)) {
    throw new Error(`Source "${id}" did not return a timeline object.`);
  }
  return data;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  if (!BASE_URL) {
    throw new Error('TIMELINES_LIVE_URL is not set — point it at the deployed site.');
  }
  const timelineId = process.argv[2] || envValue('PRICING_TIMELINE_ID');
  if (!timelineId) {
    throw new Error('No timeline id. Pass one as an argument or set PRICING_TIMELINE_ID.');
  }
  const outPath = envValue('PRICING_MD_OUT') || DEFAULT_OUT;

  const file = await getTimeline(timelineId);

  if (!hasPlugin(file, PRODUCT_ROADMAP_PLUGIN)) {
    console.error(`[pricing-export] "${timelineId}" is not a product-roadmap timeline — nothing to export.`);
    process.exit(1);
  }
  // Composed from the stored rows. `file.pricing` is gone: the core file format
  // stopped carrying one plugin's data by name (#17), and this script lives in
  // the plugin now for the same reason.
  const pricing = currentPricing(file);
  if (!pricing.tiers.length && !pricing.features.length) {
    console.error(`[pricing-export] "${timelineId}" has no pricing model — nothing to export.`);
    process.exit(1);
  }

  const md = pricingToMarkdown({ timelineId, name: file.name, pricing }, { updated: todayIso() });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md, 'utf8');
  console.error(
    `[pricing-export] wrote ${pricing.tiers.length} tiers × ${pricing.features.length} features → ${outPath}`,
  );
}

main().catch((err) => {
  console.error('[pricing-export] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
