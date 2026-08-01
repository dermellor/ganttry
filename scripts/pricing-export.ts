// Pricing export: Timeline (DB, source of truth) → Markdown in the vault.
//
// Pulls a product timeline's pricing model via the live API (same X-MCP-Token
// path as scripts/mcp/server.ts), renders it with pricingToMarkdown, and writes
// the result to a generated Markdown file in the vault. One-way: the timeline is
// authoritative; the .md is a generated artifact ("do not edit by hand").
//
// Usage:
//   npm run export:pricing               # default timeline id
//   npm run export:pricing -- <id>       # explicit timeline id
//
// Config (env, with fallback to ~/_AGENTS/.env then <repo>/.env.local):
//   MCP_API_TOKEN      — required; matches the Netlify env var of the same name
//   TIMELINES_LIVE_URL — optional; default https://example-timelines.netlify.app
//   PRICING_MD_OUT     — optional; output path (default: AI-Agents Preismodell.md)

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TimelineFile } from '../src/types.ts';
import { PRODUCT_ROADMAP_PLUGIN, hasPlugin } from '../src/plugins.ts';
import { pricingToMarkdown } from '../src/kinds/product-roadmap/pricing.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const DEFAULT_TIMELINE_ID = 'acme/example-roadmap';
const DEFAULT_OUT = resolve(
  homedir(),
  'Library/Mobile Documents/iCloud~md~obsidian/Documents/_NOTIZEN/Strategie/Acme AI Agents/Preismodell.md',
);

/** Minimal .env parser — mirrors scripts/mcp/server.ts. process.env always wins. */
function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = readFileSync(path, 'utf8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let value = m[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      out[m[1]] = value;
    }
  } catch {
    /* file may not exist — fine */
  }
  return out;
}

const fromFiles = {
  ...parseEnvFile(resolve(homedir(), '_AGENTS/.env')),
  ...parseEnvFile(resolve(REPO_ROOT, '.env.local')),
};
const pick = (k: string): string => process.env[k] ?? fromFiles[k] ?? '';

const BASE_URL = (pick('TIMELINES_LIVE_URL') || 'https://example-timelines.netlify.app').replace(/\/+$/, '');
const API_TOKEN = pick('MCP_API_TOKEN');

function encodeId(id: string): string {
  return id.split('/').map(encodeURIComponent).join('/');
}

async function getTimeline(id: string): Promise<TimelineFile> {
  if (!API_TOKEN) {
    throw new Error('MCP_API_TOKEN is not set. Add it to ~/_AGENTS/.env (matching the Netlify env var).');
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
  const timelineId = process.argv[2] || DEFAULT_TIMELINE_ID;
  const outPath = pick('PRICING_MD_OUT') || DEFAULT_OUT;

  const file = await getTimeline(timelineId);

  if (!hasPlugin(file, PRODUCT_ROADMAP_PLUGIN)) {
    console.error(`[pricing-export] "${timelineId}" is not a product-roadmap timeline — nothing to export.`);
    process.exit(1);
  }
  if (!file.pricing || (!file.pricing.tiers?.length && !file.pricing.features?.length)) {
    console.error(`[pricing-export] "${timelineId}" has no pricing model — nothing to export.`);
    process.exit(1);
  }

  const md = pricingToMarkdown(
    { timelineId, name: file.name, pricing: file.pricing },
    { updated: todayIso() },
  );

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md, 'utf8');
  console.error(
    `[pricing-export] wrote ${file.pricing.tiers.length} tiers × ${file.pricing.features.length} features → ${outPath}`,
  );
}

main().catch((err) => {
  console.error('[pricing-export] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
