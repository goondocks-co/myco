import { reaching, type Reach } from './schema-step.js';
/** Exact source-range acknowledgement path over view prompts; small enough to build on populated storage. */
export const V107_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS idx_view_prompts_source_range ON view_prompts(project_id,instance_id,source_transcript_id,source_offset,source_end,prompt_id)`,
];

/** Why the step reaches tables earlier steps created. */
export const V107_REACHES: readonly Reach[] = reaching(['view_prompts'], 'Source-range acknowledgement indexes prompt storage of at most one row per captured prompt.');
