/** Committed repository inventories and revision-bound curation currency. */
export const V697_STATEMENTS: readonly string[] = [
  `ALTER TABLE agent_runs ADD COLUMN repository_files TEXT CHECK(repository_files IS NULL OR json_valid(repository_files))`,
  `ALTER TABLE spore_curation_candidates ADD COLUMN currency TEXT CHECK(currency IS NULL OR json_valid(currency))`,
];
