/** Sessions still waiting for conversion to documents, so finding the next one reads only those. */
export const V112_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_session_documents_convert ON session_documents (project_id, session_id) WHERE state = 'convert'`,
];
