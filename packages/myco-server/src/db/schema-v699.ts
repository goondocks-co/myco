import { reaching, type Reach, changing } from './schema-step.js';
/** Curation assignments retain an outstanding lifecycle write refusal. */
export const V699_STATEMENTS: readonly string[] = [
  'ALTER TABLE spore_curation_work ADD COLUMN write_refusal TEXT CHECK(write_refusal IS NULL OR json_valid(write_refusal))',
];

/** Why the step reaches tables earlier steps created. */
export const V699_REACHES: readonly Reach[] = changing(['spore_curation_work'], 'The assignment retains its outstanding lifecycle refusal until a corrected write commits.');
