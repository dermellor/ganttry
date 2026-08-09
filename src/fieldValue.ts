// What a custom field's stored value becomes when one option is picked from the
// item context menu.
//
// Split out of itemForm.ts and kept free of any DOM or app-state reference for the
// same reason menuPosition.ts is: this is the rule-bearing part (toggle vs.
// replace, the scalar/array shape, and when the key disappears entirely), and
// itemForm.ts can't be pulled into a `node --test` run because it reaches
// `state`, which touches `document` at module load.
//
// The shapes match what the *form* writes, so a value set from the menu and one
// set from the form are indistinguishable in `metadata[key]`: a `select` stores a
// string, a `multi-select` an array.

export type FieldPick = {
  // The values the field carries afterwards — what the menu re-marks its rows from.
  values: string[];
  // What to write to `metadata[key]`, or `undefined` to remove the key. Removal
  // rather than an empty string/array matters: an emptied field must vanish, so
  // the persist diff can send it as an explicit null (see buildItemPatch).
  stored: string | string[] | undefined;
};

/**
 * Resolve picking `value` on a field that currently holds `current`.
 *
 * `multi` toggles membership (order-preserving, appending new values at the end
 * like the form's chip editor); a single-select replaces, and an empty `value`
 * clears it — that is the „kein Wert" row, the menu's equivalent of the empty
 * option the form's `<select>` carries.
 */
export function applyFieldPick(current: string[], value: string, multi: boolean): FieldPick {
  if (multi) {
    // An empty value is not a real option on a multi-select (it clears by
    // untoggling, so it has no „kein Wert" row) — treat it as a no-op rather than
    // storing a blank member.
    const values = !value
      ? current
      : current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
    return { values, stored: values.length ? values : undefined };
  }
  const values = value ? [value] : [];
  return { values, stored: values[0] };
}

/**
 * Write a list-valued `metadata` key (dependsOn, jira, tags, a multi-select),
 * where "no entries" is normally spelled by *removing* the key — see FieldPick
 * above for why removal rather than an empty array.
 *
 * The exception this function exists for: an item that arrived carrying an
 * already-empty array keeps it exactly as stored. Both spellings mean the same
 * thing, so rewriting one into the other is not an edit — but it does change the
 * file, and the form applies these on every commit including the one that merely
 * opening an item triggers. `"dependsOn": []` in a source file therefore came
 * back as a diff every time someone clicked that item, which is the same defect
 * as a defaulted status being written back (see statusToStore).
 *
 * A list that *had* entries and no longer does still loses its key: that is a
 * real edit, and the persist diff needs the removal to send an explicit null.
 */
export function writeListMeta(
  meta: Record<string, unknown>,
  key: string,
  values: readonly unknown[],
): void {
  if (values.length) {
    meta[key] = [...values];
    return;
  }
  const before = meta[key];
  if (Array.isArray(before) && before.length === 0) return;
  delete meta[key];
}
