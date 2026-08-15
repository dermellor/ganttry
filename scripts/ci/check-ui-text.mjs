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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
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

// ---- The catalogues -----------------------------------------------------------
//
// Where the interface's text actually lives since #153. Everything above finds a
// string literal at a *rendering site*, which was the whole interface until the
// strings moved into `src/i18n/messages.*.ts` — and a check that only looks at call
// sites would have gone quietly green as they emptied, retiring the rule exactly the
// way „Interface text" (AGENTS.md) says prose comes back.
//
// Checking the catalogue is strictly the better half of this script: it is the
// complete list rather than whatever a regex matched, it is in one place, and it
// covers **both** languages — a rule enforced on German only would have let the
// English translation of a label grow into a sentence unnoticed.
//
// `refusal.*` is exempt from the word limit and not from the check. That is the
// third category the rule always had („Refusals and results of something the user
// just did"), which was allowed to be a full sentence and used to escape this
// script for the wrong reason: it sat in a DOM-free rule module rather than at a
// rendering site, so „is this a refusal?" was answered by where the string
// happened to live. The prefix makes the claim explicit and greppable, and calling
// a label `refusal.` to buy room is a visible lie in a diff rather than an
// invisible one.
//
// Three further prefixes are exempt for the same reason — each names a category
// that is a full statement by nature, and each is a claim the diff shows:
//
//   `warn.`   a fault the software found in the **data** and reports rather than
//             resolving: two sprint windows overlapping, a history row pointing at
//             a sprint that does not exist. It is a refusal's sibling — the
//             software declining to pretend — and naming the two things it found
//             takes a sentence.
//   `doc.`    text written into a **generated document**, not into the interface:
//             the provenance line of an exported Markdown file. It is prose on
//             purpose, and it is read in a file rather than beside a control.
//   `*.aria`  an accessible name that stands in for a **graphic**. A burndown's
//             accessible equivalent has to carry the figures the picture shows, so
//             holding it to a label's length would delete exactly the information
//             it exists to convey.
//
// A plugin's catalogue is held to the same rule, and the plugin folders are
// **found** rather than listed — `src/plugins/*/messages.ts`, skipping the
// `_`-prefixed template, the same globbing the catalogue generator and the
// bundle-split check use. Listing them by hand is how the rule would apply to the
// two plugins that existed the day it was written and to no plugin after that.
/** The four categories above, by the name their key has to carry. */
const EXEMPT_KEY = /^(refusal|warn|doc)\.|\.aria$/;

const CATALOGUES = [
  'src/i18n/messages.en.ts',
  'src/i18n/messages.de.ts',
  ...readdirSync('src/plugins')
    .filter((name) => !name.startsWith('_'))
    .map((name) => join('src/plugins', name, 'messages.ts'))
    .filter((p) => existsSync(p)),
];

for (const file of CATALOGUES) {
  let source;
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    // The catalogues are the interface's text; a missing one is not a silent pass.
    problems.push({ file, line: 0, words: 0, sentences: 0, text: 'catalogue is missing' });
    continue;
  }

  // `'key': 'text',` including a run broken across lines by the formatter. The
  // key is captured so the `refusal.` exemption can be applied by name.
  const entry = /^\s*'([\w.]+)':\s*((?:'(?:[^'\\]|\\.)*')(?:\s*\+\s*'(?:[^'\\]|\\.)*')*),?\s*$/gm;
  const multiline = /^\s*'([\w.]+)':\s*\n\s*((?:'(?:[^'\\]|\\.)*')(?:\s*\+\s*'(?:[^'\\]|\\.)*')*),?\s*$/gm;

  for (const pattern of [entry, multiline]) {
    for (const m of source.matchAll(pattern)) {
      const key = m[1];
      if (EXEMPT_KEY.test(key)) continue;
      const text = [...m[2].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((p) => p[1]).join('');
      if (!text.trim()) continue;
      const words = wordCount(text);
      const sentences = sentenceCount(text);
      if (words <= MAX_WORDS && sentences <= 1) continue;
      problems.push({
        file,
        line: source.slice(0, m.index).split('\n').length,
        words,
        sentences,
        text: `${key}: ${text}`,
      });
    }
  }
}

// ---- `t()` at module scope ----------------------------------------------------
//
// The one way to misuse the catalogue, and it fails silently in the direction
// nobody checks. A `const LABEL = t('form.save')` at the top of a file is
// evaluated on **import**, which happens before `initLocale()` has decided the
// language — so the product default is frozen into it and no language change ever
// moves it. The symptom is a half-translated screen: the nav stays English while
// every section body follows the setting, which reads as a bug in the switch
// rather than in the constant.
//
// Found the hard way in `settingsArea.ts`, whose section list was exactly this.
//
// The test is indentation: a `const` at column zero is module scope, one inside a
// function is not. Crude, and right for this codebase's formatting — a false
// positive is fixed by making the constant a function, which is the fix anyway.
for (const file of files('src')) {
  const source = readFileSync(file, 'utf8');
  source.split('\n').forEach((line, i) => {
    if (!/^(export )?(const|let|var) /.test(line)) return;
    if (!/\bt\(['"]/.test(line)) return;
    problems.push({
      file,
      line: i + 1,
      words: 0,
      sentences: 0,
      text: `t() at module scope — evaluated before initLocale(), so the language is frozen in: ${line.trim()}`,
    });
  });
}

// ---- German outside a catalogue -----------------------------------------------
//
// „Interface text lives in the catalogues, never at the call site" (AGENTS.md),
// made mechanical. It exists because that rule was written down, followed through
// most of a sweep, and then quietly half-abandoned: the branch that introduced the
// language setting left 121 German literals at rendering sites. What that renders
// is not a visible failure — it is an interface whose buttons say „Edit sprint"
// and whose figures beside them say „Umfang (Points)". Each file looks finished on
// its own, which is why no reviewer catches it and a machine has to.
//
// **Why the subject is language and not „every literal must be `t()`".** The
// strings left behind sat in positional arguments (`numberBox('Umfang (Points)')`),
// not in the props the checks above know, so a site-based rule would have missed
// exactly the ones that were missed. Language is what actually distinguishes „left
// behind" from „fine".
//
// The heuristic errs in the safe direction: German it does not recognise is a miss,
// never a false accusation. Verified the way the sibling checks were, against three
// deliberately introduced violations, one per shape it has to see — a German label
// at a call site, an English interface sentence quoting a value („3 items in „x" ·
// 2 groups"), and a plugin catalogue entry over the length limit without an exempt
// prefix. All three were reported and the run exited non-zero; the tree passed
// again once they were removed.
const GERMAN = {
  letters: /[äöüßÄÖÜ]/,
  // The quotation marks this product quotes a *value* with. They are not German
  // in the sense the rest of this test is about — they are the tell that a string
  // is interface text, whatever language it happens to be written in, which is the
  // half a language test cannot see on its own.
  //
  // Found the hard way: the status line under the timeline read
  // „${n} items in „${name}" · ${g} groups" — English at a call site, so the sweep
  // for German walked straight past it and it stayed English for a German reader
  // while everything around it moved. The quotes caught it.
  quotes: /[„“”]/,
  // Function words and interface nouns that do not occur in English. Short on
  // purpose: the umlaut test carries most of the load, and this covers the German
  // that happens to be spelled in ASCII.
  words:
    /\b(der|die|das|den|dem|des|und|oder|nicht|kein|keine|keinen|mit|von|für|ohne|noch|wurde|wird|muss|sind|einen|einem|eine|Datei|Eintrag|Einträge|Gruppe|Gruppen|Speichern|Abbrechen|Löschen|Schließen|Entfernen|Umfang|Offen|Abgeschlossen|Bezeichnung|Zeitraum|lesend|bearbeiten|anzeigen|herunterladen|Preise|Produkt)\b/,
};

// German that is **stored**, not shown: translating it would orphan the data
// carrying it, which is the opposite of the bug above. Each entry names why.
// `src/i18n/storedValues.test.ts` holds the same line from the other side.
const NOT_A_LABEL = [
  // A tag value on real items, and the key of its colour. Renaming it unstyles
  // every item carrying the tag and matches none of them afterwards.
  { file: 'src/buildItems.ts', text: 'Qualität & Daten' },
];

// The **agent** surface, which is English by rule (docs/mcp.md) and quotes the
// values it reports back — a tool's notes, and the JSON-schema descriptions in a
// manifest. The language half of this check still applies to them, because German
// there is a violation too; the quote half does not, since quoting a sprint's name
// in a note is what those files are supposed to do.
const AGENT_SURFACE = /\/(tools|manifest)\.ts$/;

const LANGUAGE_SKIP = [
  /\/i18n\/messages\.(de|en)\.ts$/, // the catalogues — German is their content
  /\/plugins\/[^/]+\/messages\.ts$/, // ditto, per plugin
  /\/playground\//, // a specimen page, all demonstration text
  /\/_template\//, // the plugin template: strings meant to be copied
  /\.test\.ts$/, // tests quote the interface they pin
];

function germanFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...germanFiles(p));
    else if (p.endsWith('.ts') && !LANGUAGE_SKIP.some((r) => r.test(p))) out.push(p);
  }
  return out;
}

for (const file of germanFiles('src')) {
  const source = readFileSync(file, 'utf8');
  source.split('\n').forEach((line, i) => {
    const code = line.trim();
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
    for (const m of line.matchAll(/'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
      const raw = m[1] ?? m[2] ?? '';
      // `${…}` becomes a placeholder so the German around it still reads as
      // German: `Umfang (${unit})` is the shape half of them had.
      const text = raw.replace(/\$\{[^}]*\}/g, '…');
      if (text.trim().length < 3) continue;
      const german = GERMAN.letters.test(text) || GERMAN.words.test(text);
      if (!german && !(GERMAN.quotes.test(text) && !AGENT_SURFACE.test(file))) continue;
      // A selector, a url or an id — tested after the language test, so a German
      // word inside one still counts.
      if (/^[a-z0-9.:#[\]/@_-]+$/.test(text)) continue;
      if (NOT_A_LABEL.some((e) => file === e.file && raw.includes(e.text))) continue;
      problems.push({ file, line: i + 1, words: 0, sentences: 0, text: `German at a call site: ${text}` });
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
