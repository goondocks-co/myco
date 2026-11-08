import type { RelationalStore } from '../../core/adapters.js';
import { commit, write } from '../index.js';
import { PUBLISH_BACKOFF_MIN_MS, PUBLISH_BACKOFF_MAX_MS } from './publication.js';

export interface DocumentReadObservation {
  project_id: string;
  session_id: string;
  generation: number | null;
  publication_input_revision: number | null;
  turnKey?: string;
  changes?: number;
}

type Params = [string, string, number | null, number | null, number, string, string | null, number | null];
const current = `project_id=?1 AND session_id=?2 AND generation=?3 AND publication_input_revision=?4 AND state='live'
  AND NOT EXISTS (SELECT 1 FROM session_tombstones WHERE project_id=?1 AND session_id=?2)
  AND (?7 IS NULL OR EXISTS (SELECT 1 FROM turn_cards WHERE project_id=?1 AND session_id=?2 AND turn_key=?7 AND changes=?8 AND state='pending'))`;
const backoff = `?5+CASE WHEN rollup_failure IS NULL THEN ${PUBLISH_BACKOFF_MIN_MS}
  ELSE MIN(MAX(rollup_due-rollup_checked,${PUBLISH_BACKOFF_MIN_MS})*2,${PUBLISH_BACKOFF_MAX_MS}) END`;
const card = write<Params>({ name: 'publication.deferReadCard', sql: `UPDATE turn_cards SET settle_at=(SELECT ${backoff} FROM session_documents WHERE ${current})
  WHERE project_id=?1 AND session_id=?2 AND turn_key=?7 AND changes=?8 AND state='pending'
    AND EXISTS (SELECT 1 FROM session_documents WHERE ${current}) AND ?6 IS NOT NULL` });
const document = write<Params, { session_id: string }>({ name: 'publication.deferReadDocument', sql: `UPDATE session_documents SET rollup_due=${backoff},
  rollup_failure=?6,rollup_checked=MAX(rollup_checked+1,?5) WHERE ${current} RETURNING session_id` });

const cardWithoutDocument = write<Params, { turn_key: string }>({ name: 'publication.deferReadCardWithoutDocument', sql: `UPDATE turn_cards
  SET settle_at=?5+${PUBLISH_BACKOFF_MIN_MS}
  WHERE project_id=?1 AND session_id=?2 AND turn_key=?7 AND changes=?8 AND state='pending' AND ?3 IS NULL AND ?4 IS NULL AND ?6 IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM session_documents WHERE project_id=?1 AND session_id=?2 AND state='live')
    AND NOT EXISTS (SELECT 1 FROM session_tombstones WHERE project_id=?1 AND session_id=?2) RETURNING turn_key` });

/** The document and card wait only while the failed read still describes both. */
export async function deferObservedDocumentRead(db: RelationalStore, observed: DocumentReadObservation, detail: string, now: number): Promise<boolean> {
  if (observed.turnKey !== undefined && observed.changes === undefined) throw new Error('document_read_card_observation_required');
  const params: Params = [observed.project_id, observed.session_id, observed.generation, observed.publication_input_revision,
    now, detail, observed.turnKey ?? null, observed.changes ?? null];
  if (observed.generation === null && observed.turnKey !== undefined) {
    const [result] = await commit(db, cardWithoutDocument.bind(...params));
    return result.results.length > 0;
  }
  const results = await commit(db, ...(observed.turnKey === undefined ? [] : [card.bind(...params)]), document.bind(...params));
  return results.at(-1)!.results.length > 0;
}
