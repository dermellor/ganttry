// Change one key in a note's YAML frontmatter and leave the rest of the file
// byte-for-byte alone.
//
// Why this exists rather than `matter.stringify`: round-tripping through a YAML
// serializer rewrites the whole block. Key order, quoting style, comments, blank
// lines and list indentation all come back as the serializer prefers them, so
// opening a vault through the timeline produces a diff over every file that was
// touched — in files the tool did not write and the user maintains by hand. That
// is unacceptable for a directory somebody also edits in an editor and keeps in
// version control.
//
// So: locate the block, locate the key inside it, replace exactly the lines that
// belong to that key. Anything the patcher cannot place is added at the end of
// the block, which is the one edit that cannot disturb what is already there.

const DELIM = /^---[ \t]*$/;

export type Frontmatter = {
  /** The raw lines between the delimiters, without them. */
  lines: string[];
  /** Index of the opening delimiter line, or -1 when the file has no block. */
  open: number;
  /** Index of the closing delimiter line, or -1. */
  close: number;
  /** The file's line ending, preserved on write. */
  eol: '\n' | '\r\n';
};

export function parseFrontmatter(text: string): Frontmatter {
  const eol: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  // The block only counts when it opens on the very first line. A `---` further
  // down is a horizontal rule in the body, and treating it as frontmatter would
  // rewrite prose.
  if (!DELIM.test(lines[0] ?? '')) return { lines: [], open: -1, close: -1, eol };
  for (let i = 1; i < lines.length; i++) {
    if (DELIM.test(lines[i])) return { lines: lines.slice(1, i), open: 0, close: i, eol };
  }
  // An unterminated block is not frontmatter. Closing it ourselves would swallow
  // the body into it.
  return { lines: [], open: -1, close: -1, eol };
}

/** Does this line start the given top-level key? */
function startsKey(line: string, key: string): boolean {
  return new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`).test(line);
}

/** Is this line a continuation of the previous key (indented, or a list item)? */
function isContinuation(line: string): boolean {
  return /^\s+\S/.test(line) || /^\s*-\s/.test(line);
}

/**
 * The line range a top-level key occupies, continuation lines included.
 * Returns null when the key is not present.
 */
function rangeOf(lines: string[], key: string): { from: number; to: number } | null {
  for (let i = 0; i < lines.length; i++) {
    if (!startsKey(lines[i], key)) continue;
    let to = i + 1;
    while (to < lines.length && isContinuation(lines[to])) to++;
    return { from: i, to };
  }
  return null;
}

/**
 * Plain scalars that the reader resolves to something other than a string.
 *
 * The reader is `gray-matter`, which parses with js-yaml 3 and therefore the
 * YAML **1.1** rules — a wider net than 1.2, and the reason a hand-picked list
 * of „looks numeric" cases is not enough: `0211` is octal 137, `12:30` is
 * sexagesimal 750, `1_000` is 1000, and `007` loses its zeros. A string written
 * unquoted then comes back as a number, so the value the interface stores and
 * the value it reads next are different types, and the field renders empty.
 *
 * Over-quoting costs a pair of quotes; under-quoting costs the value. So these
 * are deliberately generous, and `frontmatter.test.ts` pins them by round-tripping
 * through the actual parser rather than by asserting the regexes.
 *
 * **Dates stay out of this on purpose.** `2026-01-01` also comes back as a
 * non-string (a `Date`), but the scanner's date cascade expects exactly that,
 * and quoting them would rewrite the `date:` line of every note the timeline
 * ever touches — the vault-wide diff this whole module exists to prevent.
 */
const YAML_CONST = /^(?:~|[Nn]ull|NULL|[Tt]rue|TRUE|[Ff]alse|FALSE)$/;
const YAML_NUMBER =
  /^[-+]?(?:0x[0-9a-fA-F_]+|0b[01_]+|0[0-7_]+|[0-9][0-9_]*(?::[0-5]?[0-9])+(?:\.[0-9_]*)?|(?:[0-9][0-9_]*)?\.[0-9_]+(?:[eE][-+]?[0-9]+)?|[0-9][0-9_]*\.?[0-9_]*(?:[eE][-+]?[0-9]+)?|\.(?:inf|Inf|INF|nan|NaN|NAN))$/;

/**
 * Render a value as YAML.
 *
 * Deliberately narrow: strings, numbers, booleans and flat string arrays. That
 * covers every field the timeline writes back. Anything else is refused by the
 * caller rather than guessed at, because a wrong guess here corrupts a file the
 * tool does not own.
 *
 * `inFlow` marks the elements of a `[a, b]` sequence, where three more
 * characters are structural.
 */
export function toYamlValue(value: unknown, inFlow = false): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map((v) => toYamlValue(v, true)).join(', ')}]`;
  const s = String(value);
  // Quote whenever the plain form would not read back as this exact string: a
  // leading indicator character, a trailing space, a colon-space (which would
  // start a nested mapping), a space-hash (which would start a comment and
  // truncate the value), an empty string, or a constant/number as above.
  //
  // `-`, `?` and `:` are indicators only when a space follows — otherwise
  // `2026-01-01` would come back quoted, which is noise in a file somebody reads
  // by hand.
  //
  // Inside a flow sequence, `,` and the brackets end the element wherever they
  // appear, not just in first position. An unquoted `]` there does not merely
  // lose the value: it makes the whole block unparseable, and the scanner skips
  // an unparseable note, so one edit drops the item off the timeline.
  const needsQuotes =
    s === '' ||
    YAML_CONST.test(s) ||
    YAML_NUMBER.test(s) ||
    /^[\s>|*&!%@`"'\[\]{}#,]/.test(s) ||
    /^[-?:](\s|$)/.test(s) ||
    /:\s/.test(s) ||
    /\s#/.test(s) ||
    /\s$/.test(s) ||
    (inFlow && /[,\[\]{}]/.test(s));
  return needsQuotes ? `'${s.replace(/'/g, "''")}'` : s;
}

export type Patch = Record<string, unknown>;

/**
 * Apply `patch` to the file's frontmatter and return the new file text.
 *
 * A `null` or `undefined` value removes the key: in a file, „unset" is the
 * absence of the line, the same rule the JSON write path follows.
 *
 * A file with no frontmatter block gets one, prepended. A file that has one
 * keeps its body untouched, including a body that starts with `---`.
 */
export function patchFrontmatter(text: string, patch: Patch): string {
  const fm = parseFrontmatter(text);
  const eol = fm.eol;
  const entries = Object.entries(patch);
  if (entries.length === 0) return text;

  if (fm.open < 0) {
    // No block yet. Everything that is not a removal becomes the new block; the
    // original text follows unchanged.
    const added = entries.filter(([, v]) => v != null).map(([k, v]) => `${k}: ${toYamlValue(v)}`);
    if (added.length === 0) return text;
    return ['---', ...added, '---', text].join(eol);
  }

  const lines = [...fm.lines];
  for (const [key, value] of entries) {
    const range = rangeOf(lines, key);
    if (value == null) {
      if (range) lines.splice(range.from, range.to - range.from);
      continue;
    }
    const rendered = `${key}: ${toYamlValue(value)}`;
    if (range) lines.splice(range.from, range.to - range.from, rendered);
    else lines.push(rendered);
  }

  const all = text.split(/\r?\n/);
  const body = all.slice(fm.close + 1);
  return ['---', ...lines, '---', ...body].join(eol);
}

/**
 * Replace the body below the frontmatter, leaving the block itself alone.
 * A file without a block is replaced wholesale.
 */
export function setBody(text: string, body: string): string {
  const fm = parseFrontmatter(text);
  if (fm.open < 0) return body;
  const eol = fm.eol;
  return ['---', ...fm.lines, '---', ...body.split(/\r?\n/)].join(eol);
}
