import { reaching, type Reach } from './schema-step.js';
/** Sessions still waiting for conversion to documents, so finding the next one reads only those. */
export const V112_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_session_documents_convert ON session_documents (project_id, session_id) WHERE state = 'convert'`,
];

/** Why the step reaches tables earlier steps created. */
export const V112_REACHES: readonly Reach[] = reaching(['session_documents'], 'Conversion finds the sessions still waiting for it without reading the converted ones.');
