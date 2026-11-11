/**
 * How many distinct prompts Myco served a run, counted on `run_head.prompts` as `run_served_material` records each
 * serving, so the run panel reads one keyed row however much the run was served. The count starts when the schema step
 * that added it ran (`SERVED_PROMPTS_COUNTED_FROM`): a run queued before then reads as not recorded, never as none.
 */
import type { RelationalStore } from '../../core/adapters.js';
import type { ReadScope } from '../../read/scope.js';
import { trigger } from '../ddl.js';
import { first, read } from '../index.js';

/** The `schema_meta` key holding the instant the served-prompt count began. */
export const SERVED_PROMPTS_COUNTED_FROM = 'served_prompts_counted_from';

/** A prompt served again to the same run is counted once. */
const countPrompt = trigger('run_head_prompt_insert', 'run_served_material', 'INSERT',
  `INSERT INTO run_head(project_id,run_id,prompts) VALUES(NEW.project_id,NEW.run_id,1)
       ON CONFLICT(project_id,run_id) DO UPDATE SET prompts=run_head.prompts+1`,
  `NOT EXISTS (SELECT 1 FROM run_served_material m WHERE m.project_id=NEW.project_id AND m.run_id=NEW.run_id
       AND m.record_id=NEW.record_id AND m.served_id<>NEW.served_id)`);

/** The counter's trigger and the instant counting began. */
export function servedPromptSchemaStatements(): string[] {
  return [
    countPrompt.sql,
    `INSERT OR IGNORE INTO schema_meta (key, value)
     VALUES ('${SERVED_PROMPTS_COUNTED_FROM}', CAST(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS TEXT))`,
  ];
}

const promptsRead = read<[project: string, run: string, key: string], { prompts: number | null }>({ name: 'runs.servedPrompts', sql:
  `SELECT CASE WHEN COALESCE(r.queued_at, r.started_at) >= CAST(m.value AS INTEGER) THEN COALESCE(h.prompts, 0) END AS prompts
   FROM agent_runs r CROSS JOIN schema_meta m ON m.key = ?3
   LEFT JOIN run_head h ON h.project_id = r.project_id AND h.run_id = r.id
   WHERE r.project_id = ?1 AND r.id = ?2` });

/** The distinct prompts Myco served the run; null for a run queued before the count began, or one the scope does not hold. */
export async function servedPromptCount(db: RelationalStore, scope: ReadScope, runId: string): Promise<number | null> {
  const row = await first(db, promptsRead.bind(scope.projectId, runId, SERVED_PROMPTS_COUNTED_FROM));
  return row === null || row.prompts === null ? null : Number(row.prompts);
}
