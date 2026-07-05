/**
 * Single source of truth for the vault tool-group name sets.
 *
 * This module has zero runtime dependencies on purpose — schemas.ts needs
 * `ALL_VAULT_TOOL_NAMES` for a Zod refine that validates task YAML at load
 * time (including codegen, which loads schemas.ts in plain Node via tsx),
 * and any transitive import of `bun:sqlite` (which tools.ts pulls in via
 * its tool-factory dependencies) breaks codegen. Keeping the name sets in
 * a leaf module lets both schemas.ts (validation) and tools.ts (the actual
 * factory) import them without dragging in the DB layer.
 *
 * tools.ts imports these sets directly — it must never redeclare its own
 * copies. Adding a tool means adding its name to the appropriate set here;
 * `VAULT_TOOL_COUNT` and `ALL_VAULT_TOOL_NAMES` (both derived, in tools.ts
 * and here respectively) pick up the change automatically.
 */

export const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  'vault_unprocessed', 'vault_batches', 'vault_session_summary_material', 'vault_spores',
  'vault_sessions', 'vault_search_fts', 'vault_search_semantic', 'vault_search_canopy',
  'vault_release_state', 'vault_state', 'vault_edges',
]);

export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'vault_create_spore', 'vault_resolve_spore', 'vault_update_session', 'vault_set_state',
  'vault_read_digest', 'vault_write_digest', 'vault_mark_processed',
]);

export const OBSERVABILITY_TOOL_NAMES: ReadonlySet<string> = new Set(['vault_report', 'vault_run_health']);

export const SKILL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'vault_skill_survey_prepare', 'vault_skill_survey_bundle_decisions',
  'vault_skill_survey_reconciliation_plan',
  'vault_skill_survey_apply_reconciliation',
  'vault_skill_candidates', 'vault_skill_records', 'vault_scan_skill_contamination',
  'vault_write_skill', 'vault_stage_skill', 'vault_finalize_skill',
  'vault_edit_skill',
]);

export const EXPLORATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  'fs_read', 'fs_list', 'fs_tree', 'code_grep',
]);

export const CANOPY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'canopy_describe_next', 'canopy_describe_write', 'canopy_list',
  'canopy_describe_charge',
]);

export const OKF_TOOL_NAMES: ReadonlySet<string> = new Set([
  'okf_read_bundle', 'okf_list_changes', 'okf_write_concept', 'okf_report',
]);

/**
 * Duplicated literal, not a re-export, of `PHASE_METADATA_TOOL_NAMES` from
 * `tools/phase-metadata-tools.ts` — that module imports
 * `@anthropic-ai/claude-agent-sdk` to build the actual tool, so importing
 * it here would break this module's zero-dep contract. Keep this literal
 * in sync by hand if `phase-metadata-tools.ts` ever registers a second
 * tool; `tools.ts` itself still sources the real tuple from that module
 * for the tool factory and for `VAULT_TOOL_COUNT`.
 */
const PHASE_METADATA_TOOL_NAME = 'phase_emit_metadata';

/**
 * Union of every vault tool name across all groups, including the phase-
 * metadata tool. Sized to match `VAULT_TOOL_COUNT` (tools.ts) exactly — a
 * bidirectional-drift test in tests/agent/tools.test.ts asserts this union
 * carries every name the real tool registry produces, and vice versa.
 */
export const ALL_VAULT_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...READ_TOOL_NAMES,
  ...WRITE_TOOL_NAMES,
  ...OBSERVABILITY_TOOL_NAMES,
  ...SKILL_TOOL_NAMES,
  ...EXPLORATION_TOOL_NAMES,
  ...CANOPY_TOOL_NAMES,
  ...OKF_TOOL_NAMES,
  PHASE_METADATA_TOOL_NAME,
]);
