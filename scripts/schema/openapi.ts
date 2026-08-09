// Generates openapi.yaml for the HTTP API.
//
// Split by what actually changes: the **payload schemas** are generated from
// `src/types.ts` (so an added field shows up without anyone editing YAML), while
// the **routes** — paths, methods, headers, status codes — are declared here by
// hand, because the dispatcher in scripts/db/api.ts is an if-chain and carries no
// per-route types to generate from. Typing those routes first would be a refactor
// of the core write path, which is deliberately not part of this.
//
// What keeps the hand-written half honest is a test, not discipline:
// scripts/schema/openapi.test.ts asserts every `SubKind` from api.ts appears in
// the spec, so adding a sub-resource without documenting it fails CI.
//
//   npm run openapi        # regenerate openapi.yaml
//   npm run openapi:check  # verify the committed file matches (CI)

import { createGenerator } from 'ts-json-schema-generator';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROUTES, type RouteDef } from './openapi-routes.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = resolve(REPO_ROOT, 'openapi.yaml');
const check = process.argv.includes('--check');

/**
 * Types whose schemas the spec references. Generated, never hand-written.
 *
 * All of them come from `src/types.ts`, and no plugin's types are here any more:
 * `Pricing`, `PricingFeature`, `PricingTier` and `PricingHighlight` were in this
 * list while the core file format carried one plugin's model, and they left with
 * it (#17). A plugin's rows are documented generically, as `PluginDataRow` —
 * what a row may contain is its manifest's business and is checked at runtime,
 * not something this spec can or should restate.
 */
const SCHEMA_TYPES = [
  'TimelineFile',
  'TimelineFileItem',
  'TimelinePhase',
  'CustomFieldDef',
  'Watermark',
  'DirectoryUser',
  'PluginRef',
  'PluginDataRow',
  'PluginStatus',
];

/**
 * OpenAPI restricts component names to `[a-zA-Z0-9.\-_]`, while the generator
 * names anonymous definitions after their TypeScript expression, e.g.
 * `Record<string,unknown>`. Those names have to be rewritten, refs included, or
 * the spec is invalid.
 */
function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, '');
}

function componentSchemas(): Record<string, unknown> {
  const generator = createGenerator({
    path: resolve(REPO_ROOT, 'src/types.ts'),
    tsconfig: resolve(REPO_ROOT, 'tsconfig.json'),
    additionalProperties: false,
    topRef: false,
    expose: 'all',
  });
  const out: Record<string, unknown> = {};
  const renames = new Map<string, string>();
  for (const type of SCHEMA_TYPES) {
    const schema = generator.createSchema(type) as Record<string, unknown>;
    // Fold the generated $defs into the component map and rewrite the refs, so
    // the spec is self-contained rather than pointing at external files (which
    // many OpenAPI tools refuse to follow).
    const defs = (schema.definitions ?? schema.$defs ?? {}) as Record<string, unknown>;
    for (const [name, def] of Object.entries(defs)) {
      const safe = safeName(name);
      if (safe !== name) renames.set(name, safe);
      out[safe] ??= def;
    }
    delete schema.definitions;
    delete schema.$defs;
    delete schema.$schema;
    if (Object.keys(schema).length) out[safeName(type)] ??= schema;
  }
  let json = JSON.stringify(out).replace(/#\/(?:definitions|\$defs)\//g, '#/components/schemas/');
  for (const [from, to] of renames) {
    // The generator writes refs percent-encoded (`Record%3Cstring%2Cunknown%3E`),
    // so replacing only the plain form leaves every ref dangling.
    for (const variant of new Set([from, encodeURIComponent(from)])) {
      json = json.split(`#/components/schemas/${variant}`).join(`#/components/schemas/${to}`);
    }
  }
  return JSON.parse(json);
}

/** Stable, readable operation ids: method + path segments. */
function operationId(method: string, path: string): string {
  const parts = path
    .replace(/^\/api\/?/, '')
    .split('/')
    .filter(Boolean)
    .map((seg) =>
      seg.startsWith('{')
        ? `By${seg.slice(1, -1).replace(/^./, (c) => c.toUpperCase())}`
        : seg.replace(/-([a-z])/g, (_, c) => c.toUpperCase()).replace(/^./, (c) => c.toUpperCase()),
    );
  return method.toLowerCase() + parts.join('');
}

function pathsFrom(routes: RouteDef[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    paths[r.path] ??= {};
    if (r.pathParams?.length) {
      paths[r.path].parameters = r.pathParams.map((p) => ({
        name: p.name,
        in: 'path',
        required: true,
        description: p.description,
        schema: { type: 'string' },
      }));
    }
    for (const op of r.operations) {
      const responses: Record<string, unknown> = {};
      for (const [code, res] of Object.entries(op.responses)) {
        responses[code] = res.schema
          ? { description: res.description, content: { 'application/json': { schema: res.schema } } }
          : { description: res.description };
      }
      paths[r.path][op.method.toLowerCase()] = {
        operationId: operationId(op.method, r.path),
        summary: op.summary,
        ...(op.description ? { description: op.description } : {}),
        // An empty list means "no auth", which is how a deliberately public
        // endpoint is expressed machine-readably rather than only in prose.
        ...(r.public ? { security: [] } : {}),
        // Generated clients strike a deprecated operation through, which is the
        // point: the retired route still answers, so nothing else would signal
        // that it must not be called any more.
        ...(r.deprecated ? { deprecated: true } : {}),
        ...(op.optimisticLock
          ? {
              parameters: [
                {
                  name: 'If-Match',
                  in: 'header',
                  required: false,
                  description:
                    "The row version the client last saw. A mismatch answers 409 instead of overwriting. Falls back to `body.version` when the header is absent — except for pricing features, where `version` is the domain field 'available from'.",
                  schema: { type: 'integer' },
                },
              ],
            }
          : {}),
        ...(op.requestBody
          ? {
              requestBody: {
                required: true,
                content: { 'application/json': { schema: op.requestBody } },
              },
            }
          : {}),
        responses,
      };
    }
  }
  return paths;
}

// Minimal YAML writer: the document is plain maps, arrays, strings, numbers and
// booleans, so a dependency for this would buy nothing.
function toYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (value === null) return 'null';
  if (typeof value === 'string') {
    if (value.includes('\n')) {
      const body = value
        .split('\n')
        .map((l) => (l ? `${pad}  ${l}` : ''))
        .join('\n');
      return `|-\n${body}`;
    }
    return /^[\w./-]+$/.test(value) && !/^(true|false|null|~|\d)/.test(value)
      ? value
      : JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return value
      .map((v) => {
        const rendered = toYaml(v, indent + 1);
        return typeof v === 'object' && v !== null && !Array.isArray(v)
          ? `\n${pad}- ${rendered.replace(/^\s+/, '')}`
          : `\n${pad}- ${rendered}`;
      })
      .join('');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length) return '{}';
  return entries
    .map(([k, v]) => {
      // Numeric-looking keys must stay quoted: OpenAPI response codes are
      // strings, and bare `200:` parses as the integer 200, which strict
      // validators reject.
      const key = /^[A-Za-z_][\w./-]*$/.test(k) ? k : JSON.stringify(k);
      const isBlock = typeof v === 'object' && v !== null;
      const rendered = toYaml(v, indent + 1);
      if (Array.isArray(v)) return `\n${pad}${key}:${v.length ? rendered : ' []'}`;
      if (isBlock) return `\n${pad}${key}:${rendered === '{}' ? ' {}' : `\n${'  '.repeat(indent + 1)}${rendered.replace(/^\s+/, '')}`}`;
      return `\n${pad}${key}: ${rendered}`;
    })
    .join('');
}

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Ganttry HTTP API',
    version: '0.1.0',
    description:
      'Read and write timelines. Served identically by the Vite dev middleware and the deployed edge function: both dispatch through handleTimelineApi in scripts/db/api.ts.\n\nAuthentication: every endpoint sits behind the auth gate when AUTH_REQUIRED=true, except the public plugin read route and the retired GET /api/pricing/{id}. An MCP client may bypass the gate with a valid X-MCP-Token header.\n\nConcurrency: a PATCH sends the row version in If-Match and gets 409 on a mismatch. A PATCH only touches keys present in the body, so clearing an optional field requires sending it as an explicit null.\n\nThis file is generated — payload schemas come from src/types.ts. See scripts/schema/openapi.ts.',
    license: { name: 'MIT', identifier: 'MIT' },
  },
  servers: [{ url: '/', description: 'Same origin as the viewer' }],
  // Applies to every operation; a public endpoint overrides it with an
  // empty list. Either credential is enough: a browser session, or the MCP token
  // that lets a non-interactive client through the same gate.
  security: [{ sessionCookie: [] }, { mcpToken: [] }],
  paths: pathsFrom(ROUTES),
  components: {
    securitySchemes: {
      sessionCookie: {
        type: 'apiKey',
        in: 'cookie',
        name: 'session',
        description:
          'Session cookie set by the auth gate after Google sign-in, restricted to the allowed e-mail domains. HttpOnly, so a client cannot read it — use GET /api/me to learn the current identity. Only enforced when AUTH_REQUIRED=true.',
      },
      mcpToken: {
        type: 'apiKey',
        in: 'header',
        name: 'X-MCP-Token',
        description:
          'Service token that bypasses the interactive login for non-interactive clients such as the MCP server, compared in constant time. Edits made with it are attributed as `mcp`. Inactive when MCP_API_TOKEN is unset.',
      },
    },
    schemas: {
      ...componentSchemas(),
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'string',
            description:
              "Machine-readable code: version_conflict, invalid_request, not_found, server_error, session_expired, or a short message for 405.",
          },
          message: { type: 'string', description: 'Human-readable detail, when available.' },
        },
      },
      Ok: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean', enum: [true] } },
        description: 'Returned by deletes and bulk writes that have nothing to echo back.',
      },
    },
  },
};

const yaml = `# Generated by scripts/schema/openapi.ts — do not edit by hand.\n# Run \`npm run openapi\` after changing routes or src/types.ts.\n${toYaml(spec).replace(/^\n/, '')}\n`;

if (check) {
  let committed = '';
  try {
    committed = readFileSync(OUT, 'utf8');
  } catch {
    console.error('[openapi] MISSING openapi.yaml — run `npm run openapi`');
    process.exit(1);
  }
  if (committed !== yaml) {
    console.error(
      '[openapi] STALE openapi.yaml — it no longer matches the routes or src/types.ts.\n' +
        '          Run `npm run openapi` and commit the result.',
    );
    process.exit(1);
  }
  console.log('[openapi] ok    openapi.yaml matches the routes and src/types.ts');
} else {
  writeFileSync(OUT, yaml);
  const ops = ROUTES.reduce((n, r) => n + r.operations.length, 0);
  console.log(`[openapi] wrote openapi.yaml — ${ROUTES.length} paths, ${ops} operations`);
}
