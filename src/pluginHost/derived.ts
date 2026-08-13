// Field values a plugin computes per item, and the boundary the host puts around
// them.
//
// A contributed field's *options* have always been derived (fields.ts in any
// plugin folder). Its **value** was not: it lived in `metadata[key]`, so it was
// something a person or an agent had typed. That is wrong for a whole class of
// field where the value follows from the item's own data plus the plugin's config.
// A sprint is the case that forced this seam: which sprint an item falls into is a
// function of its dates, so storing it per item means a moved item keeps a sprint
// it is no longer in — and nothing in the interface says so, which is the failure
// mode a stale value always has.
//
// A derived value is therefore never stored. It is computed on every build,
// merged over the item's metadata at the one place each consumer reads field
// values, and refused by the write path.
//
// Two rules the host enforces here, because a plugin cannot enforce them on the
// others' behalf:
//
//   - **A plugin may only fill keys it declared derived.** `fields(file)` is the
//     declaration; a value on any other key is dropped. Without that, one plugin
//     could write over another's field, or over a stored one — which would read as
//     the user's own value changing by itself.
//   - **A plugin that throws loses its values, not the timeline.** `derive` runs
//     once per build over every item, so an exception escaping it would blank the
//     view rather than one field.

import type { CustomFieldDef, TimelineFile, TimelineFileItem } from '../types';
import { allPlugins, type DeriveFn, type DerivedValues } from './registry';

export type { DeriveFn, DerivedValues };

/** Keys a field definition list declares as derived. */
function derivedKeysOf(defs: readonly CustomFieldDef[]): string[] {
  return defs.filter((d) => d.derived && d.key).map((d) => d.key);
}

/**
 * A value worth putting in a bucket. Empty string, null and undefined are dropped
 * so an item without a derived value lands in the „Ohne …" section rather than in
 * a bucket with no name — the same rule `toValues` applies to stored metadata.
 */
function isPresent(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.some(isPresent);
  return true;
}

/**
 * The derived-value function for this timeline, or null when no enabled plugin
 * contributes one.
 *
 * Null rather than a function returning `{}` so the callers can skip the merge
 * entirely: this runs per item on every build, and a timeline with no plugin is
 * the common case.
 */
export function derivedValuesFor(file: TimelineFile | null | undefined): DeriveFn | null {
  const sources: { keys: string[]; derive: DeriveFn }[] = [];
  // Every registered plugin is asked, not only the ones whose view applies: a
  // plugin's `fields` gates itself on enablement, and going through `activePlugins`
  // instead would tie a field to whether the plugin has enough data for a *view*.
  // That is the same reasoning `pluginFieldDefs` follows.
  const claimed = new Set<string>();
  for (const plugin of allPlugins()) {
    if (!plugin.derive) continue;
    let keys: string[];
    let derive: DeriveFn | null;
    try {
      keys = derivedKeysOf(plugin.fields(file));
      derive = keys.length ? plugin.derive(file) : null;
    } catch {
      continue;
    }
    if (!derive) continue;
    // First declaration of a key owns it. Two plugins on one key would otherwise
    // show one plugin's value under the other's label, and which one won would
    // depend on registration order — invisible from either plugin's folder.
    const own = keys.filter((k) => !claimed.has(k));
    if (!own.length) continue;
    own.forEach((k) => claimed.add(k));
    sources.push({ keys: own, derive });
  }
  if (!sources.length) return null;

  return (item: TimelineFileItem): DerivedValues => {
    const out: DerivedValues = {};
    for (const { keys, derive } of sources) {
      let values: DerivedValues;
      try {
        values = derive(item) ?? {};
      } catch {
        continue;
      }
      if (typeof values !== 'object' || Array.isArray(values)) continue;
      for (const key of keys) {
        const value = values[key];
        if (isPresent(value)) out[key] = value;
      }
    }
    return out;
  };
}

/**
 * Field values as every consumer has to read them: what the item stores, with
 * what the plugins computed on top.
 *
 * Derived wins over a stored value on the same key, and that direction is the
 * point. A stored value there is a leftover — from before the field became
 * derived, or from an import — and showing it would mean the interface disagrees
 * with the plugin about the same field, with nothing saying which is right.
 */
export function withDerived(
  stored: Record<string, unknown> | undefined,
  derived: DerivedValues | undefined,
): Record<string, unknown> | undefined {
  if (!derived || !Object.keys(derived).length) return stored;
  return { ...(stored ?? {}), ...derived };
}
