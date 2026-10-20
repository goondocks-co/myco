/** Accepted event identities, settings revisions and reporter-issued orders. */
export const V92_STATEMENTS: readonly string[] = [
  `ALTER TABLE knowledge_git_provenance ADD COLUMN event_id TEXT`,
  `ALTER TABLE deployment_settings ADD COLUMN write_id TEXT`,
  `ALTER TABLE worker_model_catalogs ADD COLUMN observed_order INTEGER`,
  `ALTER TABLE runner_model_catalogs ADD COLUMN observed_order INTEGER`,
  `ALTER TABLE runner_update_reports ADD COLUMN observed_order INTEGER`,
];
