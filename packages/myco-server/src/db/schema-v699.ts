/** Curation assignments retain an outstanding lifecycle write refusal. */
export const V699_STATEMENTS: readonly string[] = [
  'ALTER TABLE spore_curation_work ADD COLUMN write_refusal TEXT CHECK(write_refusal IS NULL OR json_valid(write_refusal))',
];
