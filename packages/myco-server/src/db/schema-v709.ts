import { retiring, type Retirement } from './schema-step.js';
/** Knowledge curation carries no repository file inventory or per-member anchor facts. */
export const V709_STATEMENTS: readonly string[] = [
  'DROP TRIGGER IF EXISTS curation_inventory_map_move',
  'DROP TRIGGER IF EXISTS curation_inventory_map_delete',
  'DROP TRIGGER IF EXISTS curation_inventory_run_end',
  'ALTER TABLE agent_runs DROP COLUMN repository_files',
  'ALTER TABLE spore_curation_candidates DROP COLUMN currency',
];

export const V709_RETIRES: readonly Retirement[] = [
  ...retiring('trigger', ['curation_inventory_map_move', 'curation_inventory_map_delete', 'curation_inventory_run_end'],
    'Knowledge curation carries no repository file inventory, so nothing releases one.'),
  ...retiring('column', ['agent_runs.repository_files', 'spore_curation_candidates.currency'],
    'Knowledge curation carries no repository file inventory or per-member anchor facts.'),
];
