/** Knowledge curation carries no repository file inventory or per-member anchor facts. */
export const V709_STATEMENTS: readonly string[] = [
  'DROP TRIGGER IF EXISTS curation_inventory_map_move',
  'DROP TRIGGER IF EXISTS curation_inventory_map_delete',
  'DROP TRIGGER IF EXISTS curation_inventory_run_end',
  'ALTER TABLE agent_runs DROP COLUMN repository_files',
  'ALTER TABLE spore_curation_candidates DROP COLUMN currency',
];
