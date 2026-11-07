/** Prompt identity diagnostics use the transcript receipt-time window. */
export const V704_STATEMENTS: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_transcripts_received ON transcripts(project_id,first_received_at)",
];
