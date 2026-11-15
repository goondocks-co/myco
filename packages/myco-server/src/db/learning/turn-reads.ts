import { CARD_TASK } from '@goondocks/myco-shared/turn-card';
import type { RelationalStore } from '../../core/adapters.js';
import type { TurnSourceRead } from '../../core/turn-source.js';
import { commit, read, readSet, first, write } from '../index.js';
import { RUN_CONTEXT_OBJECT_SQL } from '../runs/queue.js';

export interface TurnSourceState { generation: number; hash: string; bytes: number | null; partial: string | null; failures: number }
const state = read<[project: string, session: string, turn: string], TurnSourceState>({ name: 'turnReads.state', sql:
  `SELECT p.generation,p.input_hash AS hash,p.source_bytes AS bytes,c.partial_reason AS partial,c.source_failures AS failures
   FROM session_prompts p JOIN session_documents d ON d.project_id=p.project_id AND d.session_id=p.session_id AND d.generation=p.generation AND d.state='live'
   JOIN turn_cards c ON c.project_id=p.project_id AND c.session_id=p.session_id AND c.turn_key=p.prompt_id
   WHERE p.project_id=?1 AND p.session_id=?2 AND p.prompt_id=?3 AND p.input_hash IS NOT NULL` });
export async function turnSourceState(db: RelationalStore, project: string, session: string, turn: string): Promise<TurnSourceState | null> {
  const [[held]] = await readSet(db, state.bind(project, session, turn));
  return held ?? null;
}

const currentHash = `(SELECT p.input_hash FROM session_prompts p JOIN session_documents d
  ON d.project_id=p.project_id AND d.session_id=p.session_id AND d.generation=p.generation AND d.state='live'
  WHERE p.project_id=turn_cards.project_id AND p.session_id=turn_cards.session_id AND p.prompt_id=turn_cards.turn_key)`;
/** Only a running, non-dry card attempt may change a turn's source disposition. */
const writableCardRun = (project: string, run: string, token: string) =>
  `r.project_id=${project} AND r.id=${run} AND r.dispatched_by=${token} AND r.status='running' AND r.task='${CARD_TASK}' AND r.dry_run=0`;
const begin = write<[run: string, project: string, session: string, turn: string, hash: string, token: string]>({ name: 'turnReads.begin', sql:
  `UPDATE turn_cards SET source_run_id=?1 WHERE project_id=?2 AND session_id=?3 AND turn_key=?4
   AND state='pending' AND partial_reason IS NULL AND ${currentHash}=?5
   AND EXISTS(SELECT 1 FROM agent_runs r WHERE ${writableCardRun('?2','?1','?6')})` });
export async function beginTurnSourceRead(db: RelationalStore, options: { project: string; session: string; turn: string; hash: string; run: string; token: string }): Promise<void> {
  const o = options;
  await commit(db, begin.bind(o.run,o.project,o.session,o.turn,o.hash,o.token));
}
const partial = write<[reason: string, project: string, session: string, turn: string, hash: string, run: string, token: string], { turn_key: string }>({ name: 'turnReads.partial', sql:
  `UPDATE turn_cards SET partial_reason=?1,source_run_id=NULL
   WHERE project_id=?2 AND session_id=?3 AND turn_key=?4 AND state='pending' AND ${currentHash}=?5
     AND EXISTS(SELECT 1 FROM agent_runs r WHERE ${writableCardRun('?2','?6','?7')}) RETURNING turn_key` });
export async function markTurnPartial(db: RelationalStore, options: { project: string; session: string; turn: string; hash: string; reason: string; run: string; token: string }): Promise<boolean> {
  const o = options;
  return await first(db, partial.bind(o.reason,o.project,o.session,o.turn,o.hash,o.run,o.token)) !== null;
}

const record = write<[path: string, receipt: string, project: string, run: string, token: string,
  session: string, turn: string, hash: string, previous: string | null], { id: string }>({
  name: 'turnReads.record', sql: `UPDATE agent_runs SET run_context=json_set(${RUN_CONTEXT_OBJECT_SQL},?1,json(?2))
    WHERE project_id=?3 AND id=?4 AND dispatched_by=?5 AND status='running' AND json_extract(run_context,?1) IS ?9
      AND EXISTS (SELECT 1 FROM session_prompts p JOIN session_documents d
        ON d.project_id=p.project_id AND d.session_id=p.session_id AND d.generation=p.generation AND d.state='live'
        WHERE p.project_id=?3 AND p.session_id=?6 AND p.prompt_id=?7 AND p.input_hash=?8)
    RETURNING id`,
});
const track = write<[complete: number, run: string, project: string, session: string, turn: string, hash: string, token: string, path: string, receipt: string]>({ name: 'turnReads.track', sql:
  `UPDATE turn_cards SET source_run_id=CASE WHEN ?1=1 THEN NULL ELSE ?2 END,source_failures=CASE WHEN ?1=1 THEN 0 ELSE source_failures END
   WHERE project_id=?3 AND session_id=?4 AND turn_key=?5 AND state='pending' AND ${currentHash}=?6
     AND EXISTS(SELECT 1 FROM agent_runs r WHERE ${writableCardRun('?3','?2','?7')} AND json_extract(r.run_context,?8)=?9)` });

/** Credit source and track outstanding work atomically under its fingerprint and attempt. */
export async function recordTurnSourceRead(db: RelationalStore, options: {
  project: string; run: string; session: string; turn: string; receipt: TurnSourceRead; previous: TurnSourceRead | null;
}): Promise<boolean> {
  const o = options, path = `$.turnSourceReads.${JSON.stringify(o.turn)}`, receipt = JSON.stringify(o.receipt);
  const [result] = await commit(db,
    record.bind(path,receipt,o.project,o.run,o.receipt.tokenId,o.session,o.turn,o.receipt.revision,o.previous === null ? null : JSON.stringify(o.previous)),
    track.bind(o.receipt.state==='complete'?1:0,o.run,o.project,o.session,o.turn,o.receipt.revision,o.receipt.tokenId,path,receipt));
  return result.results.length > 0;
}
