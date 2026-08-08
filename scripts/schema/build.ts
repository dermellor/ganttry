// Generates the JSON Schemas for the committed data files out of src/types.ts,
// and validates the committed examples against them.
//
// `src/types.ts` stays the single source of truth: the schemas are derived, so a
// field added to a type appears in the schema without anyone maintaining a second
// list. Committing the output is deliberate — that is what makes the `"$schema"`
// reference in the data files resolve in an editor.
//
//   npm run schema        # regenerate, then validate
//   npm run schema:check  # verify the committed schemas match the types (CI)
//
// The check mode is what catches drift: it regenerates into memory and compares.
// A type change without a regenerated schema fails there rather than silently
// shipping a schema that describes yesterday's types.

import { createGenerator } from 'ts-json-schema-generator';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const check = process.argv.includes('--check');

type Target = {
  /** Exported type in src/types.ts that describes the file's root object. */
  type: string;
  /** Where the schema is written, relative to the repo root. */
  out: string;
  /** Committed files that must validate against it. */
  examples: string[];
};

const TARGETS: Target[] = [
  {
    type: 'TimelineFile',
    out: 'schema/timeline.schema.json',
    examples: ['data/example-projektplan.json', 'data/launch-roadmap.json'],
  },
  {
    // The `timeline.json` of a directory source: a timeline without its items,
    // because there the items are the directory's Markdown files.
    type: 'TimelineContainer',
    out: 'schema/container.schema.json',
    examples: [],
  },
  {
    type: 'Config',
    out: 'schema/config.schema.json',
    examples: ['timelines.config.json'],
  },
];

function generate(type: string, out: string): string {
  const schema = createGenerator({
    path: resolve(REPO_ROOT, 'src/types.ts'),
    tsconfig: resolve(REPO_ROOT, 'tsconfig.json'),
    type,
    // Every field the data files may carry has to be in the type, so an unknown
    // key is an error rather than silently accepted. That is what surfaced the
    // stale `title` field the dropped DB column had left behind in the examples.
    additionalProperties: false,
    topRef: true,
  }).createSchema(type);
  return JSON.stringify({ $id: `https://ganttry.dev/${out}`, ...schema }, null, 2) + '\n';
}

let failed = false;

for (const target of TARGETS) {
  const path = resolve(REPO_ROOT, target.out);
  const generated = generate(target.type, target.out);

  if (check) {
    let committed = '';
    try {
      committed = readFileSync(path, 'utf8');
    } catch {
      console.error(`[schema] MISSING ${target.out} — run \`npm run schema\``);
      failed = true;
      continue;
    }
    if (committed !== generated) {
      console.error(
        `[schema] STALE ${target.out} — it no longer matches ${target.type} in src/types.ts.\n` +
          `         Run \`npm run schema\` and commit the result.`,
      );
      failed = true;
      continue;
    }
    console.log(`[schema] ok    ${target.out} matches ${target.type}`);
  } else {
    writeFileSync(path, generated);
    console.log(`[schema] wrote ${target.out} from ${target.type}`);
  }

  // Validate the examples either way: in check mode this is the actual test.
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(generated));
  for (const example of target.examples) {
    const data = JSON.parse(readFileSync(resolve(REPO_ROOT, example), 'utf8'));
    if (validate(data)) {
      console.log(`[schema] ok    ${example}`);
    } else {
      failed = true;
      console.error(`[schema] INVALID ${example}`);
      for (const err of validate.errors ?? []) {
        const where = err.instancePath || '(root)';
        const extra = err.params && 'additionalProperty' in err.params
          ? ` (${(err.params as { additionalProperty: string }).additionalProperty})`
          : '';
        console.error(`           ${where} ${err.message}${extra}`);
      }
    }
  }
}

if (failed) process.exit(1);
