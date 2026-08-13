// Which control edits which config key: the form a plugin's `configSchema` implies.
//
// The first version of the plugins section offered one JSON textarea per plugin. It was
// honest about arbitrary schemas and wrong as an interface: an operator switching a
// plugin on had to know JSON, and a missing brace failed the save rather than the
// keystroke. The manifest already declares the shape, so the form can be derived from
// it.
//
// Six kinds, and the list is short on purpose — it covers what a `configSchema` in this
// repo can express (see `validateRow` in pluginHost/dataSchema.ts) and falls back to
// JSON for the rest rather than growing a control per JSON-Schema construct:
//
//   text · number · boolean · select (an enum) · strings (an array of them) ·
//   map (a string-valued object with data keys) · json (anything else)
//
// DOM-free and unit-tested, like the rules beside it: which control a schema deserves
// is a decision, and a decision made inside a render function is one nobody can test.

/** One editable key of a plugin's config. */
export type ConfigControl = {
  key: string;
  /** Which control to draw. */
  kind: 'text' | 'number' | 'boolean' | 'select' | 'strings' | 'map' | 'json';
  /** The declared type, for the hint beside the label. */
  type: string;
  required: boolean;
  /** The allowed values, for `select`. */
  options?: string[];
  /** The schema's own `description`, when it carries one. */
  description?: string;
};

/**
 * The form for a whole config bag.
 *
 * `freeform` is the case a form cannot be derived from: a schema that declares no keys
 * at all. It keeps the JSON escape hatch for exactly that plugin instead of making its
 * config uneditable.
 */
export type ConfigForm =
  | { kind: 'fields'; controls: ConfigControl[] }
  | { kind: 'freeform' };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The declared type, ignoring a `null` alternative: `['string','null']` is a string. */
function declaredType(schema: Record<string, unknown>): string {
  const t = schema.type;
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) {
    const first = t.find((v) => typeof v === 'string' && v !== 'null');
    return typeof first === 'string' ? first : '?';
  }
  return '?';
}

function stringEnum(schema: Record<string, unknown>): string[] | null {
  if (!Array.isArray(schema.enum)) return null;
  const values = schema.enum.filter((v): v is string => typeof v === 'string');
  return values.length === schema.enum.length && values.length ? values : null;
}

/** Which control one property deserves. */
export function controlFor(key: string, raw: unknown, required: boolean): ConfigControl {
  const schema = isPlainObject(raw) ? raw : {};
  const type = declaredType(schema);
  const base: ConfigControl = { key, kind: 'json', type, required };
  if (typeof schema.description === 'string' && schema.description) {
    base.description = schema.description;
  }

  // An enum first, whatever the type says: „one of these" is the stronger statement
  // about what may be typed, and a free-text field beside a closed list is how an
  // invalid value gets entered.
  const options = stringEnum(schema);
  if (options) return { ...base, kind: 'select', options };

  if (type === 'boolean') return { ...base, kind: 'boolean' };
  if (type === 'number' || type === 'integer') return { ...base, kind: 'number' };
  if (type === 'string') return { ...base, kind: 'text' };
  if (type === 'array') {
    const items = isPlainObject(schema.items) ? schema.items : null;
    // Only a list of plain strings gets the row editor. A list of objects is a table,
    // and a plugin that needs one is asking for a view of its own.
    if (items && declaredType(items) === 'string' && !stringEnum(items)) {
      return { ...base, kind: 'strings' };
    }
    return base;
  }
  if (type === 'object') {
    // `additionalProperties: {type: string}` is JSON Schema for „a string-valued map
    // with arbitrary keys", which is a key/value editor. A declared `properties` block
    // is a nested object instead, and nesting the form would need a schema walker.
    const additional = isPlainObject(schema.additionalProperties) ? schema.additionalProperties : null;
    if (additional && declaredType(additional) === 'string' && !isPlainObject(schema.properties)) {
      return { ...base, kind: 'map' };
    }
    return base;
  }
  return base;
}

/** The form a `configSchema` implies, or null when the manifest declares none. */
export function configForm(schema: unknown): ConfigForm | null {
  if (!isPlainObject(schema)) return null;
  const props = schema.properties;
  if (!isPlainObject(props) || !Object.keys(props).length) return { kind: 'freeform' };
  const required = new Set(
    Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : [],
  );
  return {
    kind: 'fields',
    controls: Object.entries(props).map(([key, value]) => controlFor(key, value, required.has(key))),
  };
}

/**
 * A stored value as a list of strings. Anything else reads as empty rather than
 * throwing: a config written by hand may carry a string where a list belongs, and an
 * uneditable card is worse than an empty one — the save is what refuses.
 */
export function stringsValue(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map((v) => (typeof v === 'string' ? v : String(v))) : [];
}

/** A stored value as key/value rows, in the object's own order. */
export function mapEntries(raw: unknown): [string, string][] {
  if (!isPlainObject(raw)) return [];
  return Object.entries(raw).map(([k, v]) => [k, typeof v === 'string' ? v : String(v)]);
}

/** Rows back into an object, dropping rows whose key is still empty. */
export function entriesToMap(rows: readonly (readonly [string, string])[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of rows) {
    const k = key.trim();
    if (k) out[k] = value;
  }
  return out;
}

/**
 * Keys the bag carries that the schema does not declare.
 *
 * They are kept through a save rather than normalised away. A form that writes back only
 * what it drew is how a stored value disappears because the manifest moved on — the same
 * destructive normalisation a `select` once did to a metadata value whose option had
 * been removed. Naming them beats dropping them silently.
 */
export function undeclaredKeys(config: Record<string, unknown>, form: ConfigForm | null): string[] {
  if (!form || form.kind !== 'fields') return [];
  const declared = new Set(form.controls.map((c) => c.key));
  return Object.keys(config).filter((k) => !declared.has(k));
}

/**
 * Drop what the form represents as „not set": an empty text field, an empty list, an
 * empty map. A key written as `""` would be a value the plugin then has to defend
 * against, where an absent key is what „I did not set this" already means everywhere
 * else in this codebase.
 *
 * `keys` narrows it to the keys the form actually drew. A key nobody edited is passed
 * through as it was stored, because emptiness is only a statement where somebody could
 * have emptied it — see `undeclaredKeys`.
 */
export function pruneEmpty(
  config: Record<string, unknown>,
  keys?: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (keys && !keys.has(key)) {
      out[key] = value;
      continue;
    }
    if (value === '' || value == null) continue;
    if (Array.isArray(value) && !value.length) continue;
    if (isPlainObject(value) && !Object.keys(value).length) continue;
    out[key] = value;
  }
  return out;
}
