/** An outstanding lifecycle write prevents a curation decision until its correction commits. */
export const V699_STATEMENTS: readonly string[] = [
  'ALTER TABLE spore_curation_work ADD COLUMN write_refusal TEXT CHECK(write_refusal IS NULL OR json_valid(write_refusal))',
];
