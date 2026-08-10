import { BACKGROUND_LABEL_CLASS } from './backgroundItemDisplay';

export type ItemPresenceTreatment = 'none' | 'avatar-only' | 'ring';

/**
 * A stored background is rendered twice, but presence must be rendered once.
 * Keep this decision DOM-light so the duplication regression is unit-tested
 * without booting vis-timeline.
 */
export function itemPresenceTreatment(classes: Pick<DOMTokenList, 'contains'>): ItemPresenceTreatment {
  if (classes.contains('vis-background')) return 'none';
  if (classes.contains(BACKGROUND_LABEL_CLASS)) return 'avatar-only';
  return 'ring';
}
