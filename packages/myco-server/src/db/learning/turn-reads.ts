import type { RelationalStore } from '../../core/adapters.js';
import type { TurnSourceRead } from '../../core/turn-source.js';
import { first, write } from '../index.js';
import { RUN_CONTEXT_OBJECT_SQL } from '../runs/queue.js';

const record = write<[path: string, receipt: string, project: string, run: string, token: string,
  session: string, generation: number, revision: number, previous: string | null], { id: string }>({
  name: 'turnReads.record', sql: `UPDATE agent_runs SET run_context=json_set(${RUN_CONTEXT_OBJECT_SQL},?1,json(?2))
    WHERE project_id=?3 AND id=?4 AND dispatched_by=?5 AND status='running'
      AND json_extract(run_context,?1) IS ?9
      AND EXISTS (SELECT 1 FROM session_documents d WHERE d.project_id=?3 AND d.session_id=?6
        AND d.state='live' AND d.generation=?7 AND d.publication_input_revision=?8)
    RETURNING id`,
});

/** Credit a source answer only while its document and its preceding receipt still stand. */
export async function recordTurnSourceRead(db: RelationalStore, options: {
  project: string; run: string; session: string; turn: string; generation: number; documentRevision: number;
  receipt: TurnSourceRead; previous: TurnSourceRead | null;
}): Promise<boolean> {
  const o = options;
  return await first(db, record.bind(`$.turnSourceReads.${JSON.stringify(o.turn)}`, JSON.stringify(o.receipt),
    o.project, o.run, o.receipt.tokenId, o.session, o.generation, o.documentRevision,
    o.previous === null ? null : JSON.stringify(o.previous))) !== null;
}
