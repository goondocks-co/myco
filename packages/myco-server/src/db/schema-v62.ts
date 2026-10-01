/** A failure code is recorded with its reason; older rows retain a null code. */
export const V62_STATEMENTS: readonly string[] = [
  `ALTER TABLE agent_runs ADD COLUMN error_code TEXT`,
];
