/** Committed inventory, revision-bound currency and map-owned evidence retention. */
export const V697_STATEMENTS: readonly string[] = [
  `ALTER TABLE agent_runs ADD COLUMN repository_files TEXT CHECK(repository_files IS NULL OR json_valid(repository_files))`,
  `ALTER TABLE spore_curation_candidates ADD COLUMN currency TEXT CHECK(currency IS NULL OR json_valid(currency))`,
  'DROP TRIGGER IF EXISTS curation_inventory_map_move',
  `CREATE TRIGGER IF NOT EXISTS curation_inventory_map_move AFTER UPDATE OF source_run_id ON canopy_maps
    WHEN OLD.source_run_id<>NEW.source_run_id BEGIN
      UPDATE agent_runs SET repository_files=NULL WHERE project_id=OLD.project_id AND id=OLD.source_run_id AND repository_files IS NOT NULL;
    END`,
  'DROP TRIGGER IF EXISTS curation_inventory_map_delete',
  `CREATE TRIGGER IF NOT EXISTS curation_inventory_map_delete AFTER DELETE ON canopy_maps BEGIN
      UPDATE agent_runs SET repository_files=NULL WHERE project_id=OLD.project_id AND id=OLD.source_run_id AND repository_files IS NOT NULL;
    END`,
  'DROP TRIGGER IF EXISTS curation_inventory_run_end',
  `CREATE TRIGGER IF NOT EXISTS curation_inventory_run_end AFTER UPDATE OF status ON agent_runs
    WHEN NEW.status IN ('completed','failed','skipped') AND NEW.task='canopy-map' AND NEW.repository_files IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM canopy_maps WHERE project_id=NEW.project_id AND source_run_id=NEW.id) BEGIN
      UPDATE agent_runs SET repository_files=NULL WHERE project_id=NEW.project_id AND id=NEW.id;
    END`,
];
