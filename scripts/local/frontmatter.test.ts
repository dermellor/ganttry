import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { parseFrontmatter, patchFrontmatter, setBody, toYamlValue } from './frontmatter.ts';

const NOTE = [
  '---',
  '# wann das stattfindet',
  'date: 2026-03-01',
  'tags:',
  '  - eins',
  '  - zwei',
  "title: 'Mit: Doppelpunkt'",
  '---',
  '',
  '## Body',
  '',
  'Text mit einer --- Trennlinie mittendrin.',
  '',
].join('\n');

describe('parseFrontmatter', () => {
  test('finds the block only when it opens the file', () => {
    assert.equal(parseFrontmatter(NOTE).open, 0);
    assert.equal(parseFrontmatter('Text\n---\ndate: x\n---\n').open, -1, 'a rule in the body is not frontmatter');
  });

  test('an unterminated block is not frontmatter', () => {
    assert.equal(parseFrontmatter('---\ndate: 2026-01-01\nkein Ende\n').open, -1);
  });

  test('CRLF is detected and kept', () => {
    assert.equal(parseFrontmatter('---\r\ndate: x\r\n---\r\nBody\r\n').eol, '\r\n');
  });
});

describe('patchFrontmatter: surgical', () => {
  test('changing one key leaves every other line byte-identical', () => {
    const out = patchFrontmatter(NOTE, { date: '2026-04-01' });
    assert.match(out, /^date: 2026-04-01$/m);
    for (const line of ['# wann das stattfindet', 'tags:', '  - eins', '  - zwei', "title: 'Mit: Doppelpunkt'"]) {
      assert.ok(out.includes(line), `„${line}" muss unverändert bleiben`);
    }
  });

  test('the body survives untouched, including a --- line in it', () => {
    const out = patchFrontmatter(NOTE, { date: '2026-04-01' });
    assert.ok(out.includes('Text mit einer --- Trennlinie mittendrin.'));
    assert.equal(out.split('---').length, NOTE.split('---').length, 'no delimiter added or lost');
  });

  test('a multi-line value is replaced as a whole, not half', () => {
    const out = patchFrontmatter(NOTE, { tags: ['drei'] });
    assert.match(out, /^tags: \[drei\]$/m);
    assert.ok(!out.includes('  - eins'), 'the old list items are gone');
    assert.ok(out.includes('date: 2026-03-01'), 'the neighbouring key is untouched');
  });

  test('an absent key is appended, not merged into the previous one', () => {
    const out = patchFrontmatter(NOTE, { end: '2026-05-01' });
    const fm = parseFrontmatter(out);
    assert.equal(fm.lines[fm.lines.length - 1], 'end: 2026-05-01');
    assert.ok(out.includes('  - zwei'), 'the list before it stays intact');
  });

  test('null removes the key and its continuation lines', () => {
    const out = patchFrontmatter(NOTE, { tags: null });
    assert.ok(!out.includes('tags:'));
    assert.ok(!out.includes('  - eins'));
    assert.ok(out.includes('date: 2026-03-01'));
  });

  test('several keys in one pass', () => {
    const out = patchFrontmatter(NOTE, { date: '2026-06-01', end: '2026-07-01', tags: null });
    assert.match(out, /^date: 2026-06-01$/m);
    assert.match(out, /^end: 2026-07-01$/m);
    assert.ok(!out.includes('tags:'));
  });

  test('CRLF stays CRLF', () => {
    const crlf = '---\r\ndate: 2026-01-01\r\n---\r\nBody\r\n';
    const out = patchFrontmatter(crlf, { date: '2026-02-02' });
    assert.ok(out.includes('\r\n'));
    assert.ok(!/[^\r]\n/.test(out), 'kein einzelnes \\n übrig');
  });

  test('a file without a block gets one, and keeps its text', () => {
    const out = patchFrontmatter('Nur Text.\n', { date: '2026-01-01' });
    assert.ok(out.startsWith('---\ndate: 2026-01-01\n---\n'));
    assert.ok(out.includes('Nur Text.'));
  });

  test('removing from a file without a block changes nothing', () => {
    assert.equal(patchFrontmatter('Nur Text.\n', { date: null }), 'Nur Text.\n');
  });

  test('an empty patch is a no-op', () => {
    assert.equal(patchFrontmatter(NOTE, {}), NOTE);
  });

  test('a key that is a prefix of another is not confused with it', () => {
    const note = '---\nend: 2026-01-01\nend_date: 2026-02-02\n---\nBody\n';
    const out = patchFrontmatter(note, { end: '2026-03-03' });
    assert.match(out, /^end: 2026-03-03$/m);
    assert.match(out, /^end_date: 2026-02-02$/m);
  });
});

describe('toYamlValue', () => {
  test('plain scalars stay unquoted', () => {
    assert.equal(toYamlValue('2026-01-01'), '2026-01-01');
    assert.equal(toYamlValue('Kickoff'), 'Kickoff');
    assert.equal(toYamlValue(3), '3');
    assert.equal(toYamlValue(true), 'true');
  });

  test('values that would parse as something else get quoted', () => {
    assert.equal(toYamlValue('Titel: mit Doppelpunkt'), "'Titel: mit Doppelpunkt'");
    assert.equal(toYamlValue('- kein Listeneintrag'), "'- kein Listeneintrag'");
    assert.equal(toYamlValue(''), "''");
    assert.equal(toYamlValue('trailing '), "'trailing '");
  });

  test('a single quote inside is escaped', () => {
    assert.equal(toYamlValue("it's: here"), "'it''s: here'");
  });

  test('arrays render flow-style', () => {
    assert.equal(toYamlValue(['a', 'b']), '[a, b]');
  });
});

describe('setBody', () => {
  test('replaces the body and keeps the block', () => {
    const out = setBody(NOTE, 'Ganz neuer Text.');
    assert.ok(out.includes('date: 2026-03-01'));
    assert.ok(out.includes('Ganz neuer Text.'));
    assert.ok(!out.includes('## Body'));
  });
});
