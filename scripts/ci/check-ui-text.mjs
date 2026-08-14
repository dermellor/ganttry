#!/usr/bin/env node
// Interface text is labels, headings and refusals. This check fails on the thing
// that keeps growing back instead: explanation.
//
// The failure mode is not a bug and no reviewer catches it reliably, because every
// single instance looks reasonable. A form field gets a line under it saying what
// the field does; a settings row gets a sentence saying where its value lives; an
// empty state gets a paragraph about what to do next. Each was written in
// anticipation of a question nobody asked, and together they push the actual
// controls below the fold. Prose is the default output of anything generating
// interface, so the rule needs a machine behind it and not a paragraph in a
// document.
//
// What it flags: an interface string literal that is longer than one sentence or
// than MAX_WORDS words. That threshold is what separates „Nur lesend" (a label)
// from „Statische Kopie: dieser Stand wurde beim Build erzeugt und kann hier nicht
// bearbeitet werden." (an explanation), and it needed no exemptions when it was
// written — every violation was deleted instead, which is the point.
//
// Error messages are unaffected by construction: they live in DOM-free rule
// modules (src/fieldDefs.ts, src/itemExtent.ts, src/phaseOverlap.ts) and reach the
// interface through a variable, so no literal at a rendering site carries them. A
// long refusal is therefore still allowed — it just cannot be written inline.
//
// Runs on src/ only: interface. `scripts/` messages go to a terminal.
//
// Verified the way the sibling checks were, against deliberately introduced
// violations — one per shape it has to see: a component prop, a `+`-concatenated
// run of literals, an HTML attribute, and the text content of markup built as a
// string. All four were caught, and „Noch keine eigenen Felder.", „optional" and
// „z.B. ab 449,95 €/Monat" passed in the same run.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_WORDS = 8;

// The keys a component takes its user-visible strings through, plus the same
// three as HTML attributes for the views that build markup as text.
const KEYS = ['text', 'hint', 'title', 'label', 'summary', 'placeholder', 'ariaLabel', "'aria-label'"];
const ATTRS = ['title', 'placeholder', 'aria-label'];

// Skipped, each for a reason rather than for convenience:
//   design-system/  the components themselves — their strings are the callers'
//   playground/     a specimen page whose whole content is demonstration text
//   _template/      the plugin template, whose strings are instructions to copy
//   *.test.ts       tests quote the interface they pin
//   manifest.ts     a plugin's `catalogue.summary` is one required sentence about
//                   the plugin, demanded by the manifest validator and printed in
//                   PLUGINS.md — commissioned copy, not an explanation added beside
//                   a control
const SKIP = [/\/design-system\//, /\/playground\//, /\/_template\//, /\.test\.ts$/, /\/manifest\.ts$/];

function files(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (p.endsWith('.ts') && !SKIP.some((r) => r.test(p))) out.push(p);
  }
  return out;
}

const wordCount = (t) => t.trim().split(/\s+/).filter(Boolean).length;

/**
 * Sentences, counting only boundaries a reader would see.
 *
 * „z. B. PROJ-123" and „z.B. 3.000" are one sentence: a full stop after a single
 * letter or before a digit is an abbreviation or a thousands separator. Without
 * this the check fails on every example placeholder in the pricing forms, which is
 * how a checker earns an ignore list it does not need.
 */
function sentenceCount(text) {
  // The word the full stop belongs to, so „B." can be told from „geladen." — a
  // one-character lookbehind is a single letter for both and counts nothing.
  const boundaries = [...text.matchAll(/([^\s.!?]*)[.!?]+[\s)]+(?=[A-ZÄÖÜ0-9])/g)].filter((m) => {
    // Brackets and quotes around the word do not make it a sentence: „(z. B." is
    // an abbreviation, and „3.000" is a thousands separator.
    const word = m[1].replace(/[^\p{L}]/gu, '');
    return word.length > 1 && !/\d$/.test(m[1]);
  });
  return boundaries.length + 1;
}

/** Every string literal, `+`-concatenated runs joined, reported at its own line. */
function literalsFor(source, pattern) {
  const found = [];
  for (const m of source.matchAll(pattern)) {
    const raw = m[1];
    const parts = [...raw.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map(
      (p) => p[1] ?? p[2] ?? '',
    );
    const text = parts.join('');
    if (!text.trim()) continue;
    found.push({ text, line: source.slice(0, m.index).split('\n').length });
  }
  return found;
}

const problems = [];

for (const file of files('src')) {
  const source = readFileSync(file, 'utf8');

  const sites = [
    // `text: 'a' + 'b',` — a component prop, including a concatenated run
    ...literalsFor(source, new RegExp(`(?:${KEYS.join('|')})\\s*:\\s*((?:'(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*")(?:\\s*\\+\\s*(?:'(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*"))*)`, 'g')),
    // `title="…"` — the same three as an attribute in markup built as a string
    ...literalsFor(source, new RegExp(`(?:${ATTRS.join('|')})=("(?:[^"\\\\{$]|\\\\.)*")`, 'g')),
    // `>Prose that is not a label<` — text content in markup built as a string
    ...literalsFor(source, /(?:>)("[^"]*")(?:<)/g),
  ];

  for (const { text, line } of sites) {
    // Not interface: a selector, a URL, a mime type, an SVG path, an id.
    if (/^[\w.:#[\]/@-]+$/.test(text)) continue;
    const words = wordCount(text);
    const sentences = sentenceCount(text);
    if (words <= MAX_WORDS && sentences <= 1) continue;
    problems.push({ file, line, words, sentences, text });
  }
}

// The same rule for text content in template literals, where the string is markup
// rather than a prop. Kept separate because the match is a tag body, not a literal.
for (const file of files('src')) {
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    const code = line.trim();
    if (code.startsWith('//') || code.startsWith('*')) return;
    for (const m of line.matchAll(/>([^<>{}`$"]{12,})</g)) {
      const text = m[1].trim();
      if (!/[a-zäöüß]{3}\s/.test(text)) continue;
      if (wordCount(text) <= MAX_WORDS && sentenceCount(text) <= 1) continue;
      problems.push({ file, line: i + 1, words: wordCount(text), sentences: sentenceCount(text), text });
    }
  });
}

if (problems.length) {
  console.error('check-ui-text: interface text carries explanation\n');
  for (const p of problems) {
    console.error(`  ${p.file}:${p.line}  (${p.words} words, ${p.sentences} sentences)`);
    console.error(`    ${p.text}\n`);
  }
  console.error(
    `Interface text is labels, headings and refusals: at most one sentence and ${MAX_WORDS} words.\n` +
      'Delete the explanation rather than shortening it — see „Interface text" in AGENTS.md.\n' +
      'A genuinely long refusal belongs in a DOM-free rule module and reaches the interface\n' +
      'as a variable, the way src/fieldDefs.ts does it.',
  );
  process.exit(1);
}

console.log(`check-ui-text: ok`);
