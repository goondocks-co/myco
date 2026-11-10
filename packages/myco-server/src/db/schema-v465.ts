import { reaching, type Reach, changing } from './schema-step.js';
/** Structured card fields are independent of searchable authored text. */
export const V465_STATEMENTS = ['ALTER TABLE turn_cards ADD COLUMN fields TEXT'] as const;

/** Why the step reaches tables earlier steps created. */
export const V465_REACHES: readonly Reach[] = changing(['turn_cards'], 'Cards retain their structured fields in a nullable column added without rewriting rows or rebuilding search.');
