import { reaching, type Reach, changing } from './schema-step.js';
/** The completing run identifies the dependent writes of one learning revision. */
export const V545_STATEMENTS: readonly string[] = [
  'ALTER TABLE learning_sessions ADD COLUMN last_completed_run TEXT',
];

/** Why the step reaches tables earlier steps created. */
export const V545_REACHES: readonly Reach[] = changing(['learning_sessions'], 'Dependent learning writes belong to the run that completed the guarded revision.');
