// The JSON Schema subset a collection may declare, and the check of a row
// against it.
//
// Why a subset rather than a real validator: this module is imported by the
// dispatcher, which is bundled for the Deno edge functions. Pulling a validator
// in there means a large dependency in a bundle that is deliberately kept to the
// repo's own code, and the schemas a collection declares are row shapes — a
// dozen keywords cover them.
//
// The load-bearing half is `unsupportedKeywords`. A validator that silently
// skips what it does not understand is worse than none: the plugin author reads
// their `minLength` in the manifest and believes the host enforces it. So the
// unknown keyword is rejected when the MANIFEST is checked, once, rather than
// ignored on every write. By the time a row reaches `validateRow`, every keyword
// in the schema is one this module implements.

/** Keywords `validateRow` implements. Anything else makes a manifest invalid. */
export const SUPPORTED_KEYWORDS = [
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'uniqueItems',
  'description',
  'title',
  'default',
] as const;

const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] as const;
type JsonType = (typeof TYPES)[number];

type Schema = Record<string, unknown>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Every keyword in `schema` (recursively) that this module does not implement,
 * as `path: keyword` strings. Empty means the schema is fully enforceable.
 *
 * Called from manifest validation, so an author learns at load time that a
 * constraint would not have been applied.
 */
export function unsupportedKeywords(schema: unknown, path = ''): string[] {
  if (!isPlainObject(schema)) return [`${path || '(root)'}: schema must be an object`];
  const known = new Set<string>(SUPPORTED_KEYWORDS);
  const out: string[] = [];
  for (const key of Object.keys(schema)) {
    if (!known.has(key)) out.push(`${path || '(root)'}: unsupported keyword "${key}"`);
  }
  const t = schema.type;
  const declared = Array.isArray(t) ? t : t == null ? [] : [t];
  for (const one of declared) {
    if (typeof one !== 'string' || !(TYPES as readonly string[]).includes(one)) {
      out.push(`${path || '(root)'}: unknown type ${JSON.stringify(one)}`);
    }
  }
  if (schema.properties != null) {
    if (!isPlainObject(schema.properties)) out.push(`${path || '(root)'}: properties must be an object`);
    else {
      for (const [name, sub] of Object.entries(schema.properties)) {
        out.push(...unsupportedKeywords(sub, `${path}.${name}`));
      }
    }
  }
  if (schema.items != null) out.push(...unsupportedKeywords(schema.items, `${path}[]`));
  if (isPlainObject(schema.additionalProperties)) {
    out.push(...unsupportedKeywords(schema.additionalProperties, `${path}.*`));
  }
  return out;
}

function typeOf(value: unknown): JsonType {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'boolean') return 'boolean';
  return 'object';
}

function typeMatches(declared: JsonType, actual: JsonType): boolean {
  // An integer satisfies `number`; the reverse does not hold. Everything else is
  // an exact match, including `null` — a nullable field declares ['string','null'].
  return declared === actual || (declared === 'number' && actual === 'integer');
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Structural compare for enum/const/uniqueItems over objects and arrays. Key
  // order would make a JSON.stringify compare report two equal objects as
  // different, which is exactly the false rejection an author cannot debug.
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && sameValue(a[k], b[k]));
  }
  return false;
}

/**
 * Check `value` against `schema`. Returns every problem, not the first: a plugin
 * author fixing one field per failed request is the slow way to learn that three
 * are wrong.
 *
 * An absent schema means „no shape declared" and passes everything. That is a
 * deliberate default, not an oversight: a collection may legitimately be a bag,
 * and forcing a schema on one would be a rule the manifest never promised.
 */
export function validateRow(schema: unknown, value: unknown, path = ''): string[] {
  if (schema == null) return [];
  if (!isPlainObject(schema)) return [`${path || 'row'}: schema must be an object`];
  const where = path || 'row';
  const out: string[] = [];

  const t = schema.type;
  const declared = (Array.isArray(t) ? t : t == null ? [] : [t]) as JsonType[];
  const actual = typeOf(value);
  if (declared.length && !declared.some((d) => typeMatches(d, actual))) {
    return [`${where}: expected ${declared.join(' or ')}, got ${actual}`];
  }

  if ('const' in schema && !sameValue(schema.const, value)) {
    out.push(`${where}: must equal ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((c) => sameValue(c, value))) {
    out.push(`${where}: must be one of ${schema.enum.map((c) => JSON.stringify(c)).join(', ')}`);
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      out.push(`${where}: shorter than ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      out.push(`${where}: longer than ${schema.maxLength} characters`);
    }
    if (typeof schema.pattern === 'string') {
      let re: RegExp | null = null;
      try {
        re = new RegExp(schema.pattern);
      } catch {
        out.push(`${where}: pattern ${JSON.stringify(schema.pattern)} is not a valid regular expression`);
      }
      if (re && !re.test(value)) out.push(`${where}: does not match ${JSON.stringify(schema.pattern)}`);
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) out.push(`${where}: below ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) out.push(`${where}: above ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      out.push(`${where}: needs at least ${schema.minItems} entries`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      out.push(`${where}: takes at most ${schema.maxItems} entries`);
    }
    if (schema.uniqueItems === true) {
      for (let i = 0; i < value.length; i++) {
        if (value.slice(0, i).some((earlier) => sameValue(earlier, value[i]))) {
          out.push(`${where}[${i}]: duplicate entry`);
          break;
        }
      }
    }
    if (schema.items != null) {
      value.forEach((entry, i) => out.push(...validateRow(schema.items, entry, `${where}[${i}]`)));
    }
  }

  if (isPlainObject(value)) {
    const props = isPlainObject(schema.properties) ? schema.properties : {};
    for (const name of Array.isArray(schema.required) ? schema.required : []) {
      if (typeof name === 'string' && !(name in value)) out.push(`${where}: missing required "${name}"`);
    }
    for (const [name, entry] of Object.entries(value)) {
      if (name in props) {
        out.push(...validateRow(props[name], entry, `${where}.${name}`));
      } else if (schema.additionalProperties === false) {
        out.push(`${where}: unknown property "${name}"`);
      } else if (isPlainObject(schema.additionalProperties)) {
        out.push(...validateRow(schema.additionalProperties, entry, `${where}.${name}`));
      }
    }
  }

  return out;
}
