import { reaching, type Reach } from './schema-step.js';
/** Prompt identity diagnostics use the transcript receipt-time window. */
export const V704_STATEMENTS: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_transcripts_received ON transcripts(project_id,first_received_at)",
];

/** Why the step reaches tables earlier steps created. */
export const V704_REACHES: readonly Reach[] = reaching(['transcripts'], 'Prompt identity diagnostics seek transcript receipts in the selected time window.');
