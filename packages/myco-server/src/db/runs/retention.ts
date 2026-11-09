import type { RelationalStore } from '../../core/adapters.js';
import { BLOB_RESERVATION_TTL_MS } from '../../constants.js';
import { emit } from '../../telemetry.js';
import { commit, read, readSet, write } from '../index.js';

export const RETENTION_CANDIDATES_SQL = `SELECT project_id AS projectId, id FROM agent_runs
  WHERE status IN ('completed', 'failed', 'skipped') AND resumable = 0 AND COALESCE(completed_at, started_at) < ?1
  ORDER BY COALESCE(completed_at, started_at) ASC, id ASC LIMIT ?2`;

/** The most child rows one retention pass deletes, so no statement of it outlives the hosted store's query bound. */
export const RETENTION_CHILD_ROWS = 10_000;

interface RunRef { projectId: string; id: string }
const eligibleRuns = read<[cutoff: number, limit: number], RunRef>({ name: 'runs.retireEligible', sql: RETENTION_CANDIDATES_SQL });
const markedRuns = read<[limit: number], RunRef>({ name: 'runs.retireMarked', sql:
  `SELECT project_id AS projectId, run_id AS id FROM run_retirements ORDER BY project_id, run_id LIMIT ?1` });

const RUNS = `SELECT value FROM json_each(?2)`;
const markRetiring = write<[project: string, runs: string, now: number]>({ name: 'runs.retireMark', sql:
  `INSERT INTO run_retirements (project_id, run_id, marked_at) SELECT ?1, value, ?3 FROM json_each(?2) WHERE true ON CONFLICT DO NOTHING` });

/** Every table holding a run's own evidence, keyed by `run_id`. */
export const RUN_CHILD_TABLES = ['agent_run_steps', 'agent_turns', 'agent_run_events', 'agent_run_write_intents', 'run_reads', 'run_served_material', 'spore_curation_candidates', 'agent_reports', 'agent_run_attempts'] as const;
const statementName = (table: string) => table.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
const childDeletes = RUN_CHILD_TABLES.map((table) => write<[project: string, runs: string, limit: number], { gone: number }>({ name: `runs.retire.${statementName(table)}`, sql:
  `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE project_id = ?1 AND run_id IN (${RUNS}) LIMIT ?3) RETURNING 1 AS gone` }));

const noChild = (run: string) => RUN_CHILD_TABLES.map((table) => `NOT EXISTS (SELECT 1 FROM ${table} c WHERE c.project_id = ?1 AND c.run_id = ${run})`).join(' AND ');
const evidenceGone = read<[project: string, runs: string], { id: string }>({ name: 'runs.retireEvidenceGone', sql:
  `SELECT j.value AS id FROM json_each(?2) j WHERE ${noChild('j.value')}` });

interface BodyRef { runId: string; kind: string; item: number; key: string }
/** A run's report bodies go ahead of its instruction, which leaves only in the commit that removes the run. */
const bodyPage = read<[project: string, runs: string, limit: number], BodyRef>({ name: 'runs.retireBodies', sql:
  `SELECT run_id AS runId, body_kind AS kind, item_id AS item, key FROM run_bodies WHERE project_id = ?1 AND run_id IN (${RUNS})
   ORDER BY body_kind = 'instruction', run_id, body_kind, item_id LIMIT ?3` });
/** Candidates come from the body rows still standing, so a stale pass records nothing; a blob inside the upload grace waits it out as `'*'`. */
const recordReleased = write<[project: string, refs: string, now: number, cutoff: number]>({ name: 'runs.retireRecordBlobs', sql:
  `INSERT INTO blob_release_candidates (project_id, key, created_at, generation)
   SELECT DISTINCT ?1, c.key, ?3, CASE WHEN b.received_at <= ?4 THEN b.generation ELSE '*' END
   FROM json_each(?2) j
   JOIN run_bodies c ON c.project_id = ?1 AND c.run_id = json_extract(j.value, '$.runId') AND c.body_kind = json_extract(j.value, '$.kind') AND c.item_id = json_extract(j.value, '$.item')
   JOIN blobs b ON b.project_id = ?1 AND b.key = c.key WHERE true
   ON CONFLICT (project_id, key) DO UPDATE SET generation = excluded.generation` });
const deleteBodies = write<[project: string, refs: string], { gone: number }>({ name: 'runs.retireDeleteBodies', sql:
  `DELETE FROM run_bodies WHERE project_id = ?1 AND EXISTS (SELECT 1 FROM json_each(?2) j
     WHERE run_bodies.run_id = json_extract(j.value, '$.runId') AND run_bodies.body_kind = json_extract(j.value, '$.kind') AND run_bodies.item_id = json_extract(j.value, '$.item'))
   RETURNING 1 AS gone` });
const deleteParents = write<[project: string, runs: string], { id: string }>({ name: 'runs.retireDeleteRuns', sql:
  `DELETE FROM agent_runs WHERE project_id = ?1 AND id IN (${RUNS}) AND ${noChild('agent_runs.id')}
     AND NOT EXISTS (SELECT 1 FROM run_bodies c WHERE c.project_id = ?1 AND c.run_id = agent_runs.id) RETURNING id` });

/** What retention takes next: runs it has started first, whatever the window now says, then the oldest eligible. */
async function retirementPage(db: RelationalStore, cutoffMs: number, limit: number): Promise<RunRef[]> {
  const [marked, eligible] = await readSet(db, markedRuns.bind(limit), eligibleRuns.bind(cutoffMs, limit));
  const seen = new Set<string>();
  return [...marked, ...eligible].filter((run) => {
    const key = JSON.stringify([run.projectId, run.id]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, limit);
}

/**
 * Retire terminal, non-resumable runs older than the cutoff, up to `limit` of them.
 *
 * Each pass marks the candidates as retiring so their readers answer not found, removes up to `childRows` of their
 * evidence page by page, and drops a run's bodies once its evidence is gone. A run's instruction leaves only in the
 * commit that removes the run, so a run that still exists never lost its body. A marked run stays selected until it is
 * gone, even when the retention window no longer selects it, and the work stops when no marked or eligible run is left.
 * Answers how many runs went.
 */
export async function pruneTerminalRuns(db: RelationalStore, cutoffMs: number, limit: number, childRows = RETENTION_CHILD_ROWS, now: number = Date.now()): Promise<number> {
  const candidates = await retirementPage(db, cutoffMs, limit);
  if (candidates.length === 0) return 0;
  const byProject = new Map<string, string[]>();
  for (const run of candidates) byProject.set(run.projectId, [...(byProject.get(run.projectId) ?? []), run.id]);
  let removed = 0;
  let budget = childRows;
  for (const [projectId, ids] of byProject) {
    const runs = JSON.stringify(ids);
    await commit(db, markRetiring.bind(projectId, runs, now));
    for (const family of childDeletes) {
      if (budget <= 0) break;
      const [outcome] = await commit(db, family.bind(projectId, runs, budget));
      budget = Math.max(0, budget - outcome.results.length);
    }
    const [emptied] = await readSet(db, evidenceGone.bind(projectId, runs));
    if (emptied.length === 0) continue;
    const finishing = JSON.stringify(emptied.map(({ id }) => id));
    const [bodies] = await readSet(db, bodyPage.bind(projectId, finishing, Math.max(1, budget)));
    const refs = JSON.stringify(bodies);
    const [, dropped, gone] = await commit(db, recordReleased.bind(projectId, refs, now, now - BLOB_RESERVATION_TTL_MS), deleteBodies.bind(projectId, refs), deleteParents.bind(projectId, finishing));
    budget = Math.max(0, budget - dropped.results.length);
    removed += gone.results.length;
  }
  if (budget === 0) emit({ kind: 'run_retention_budget_spent', pruned: removed, runs: candidates.length });
  return removed;
}
