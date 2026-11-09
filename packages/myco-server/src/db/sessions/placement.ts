import type { RelationalStore } from '../../core/adapters.js';
import { jsonKeys } from '../ddl.js';
import { read, readSet, write, type Bound } from '../index.js';
import type { CatchupFamily } from '../projections/family.js';
import {
  CONTEXT_PLACEMENT_ANSWER_PHASE,
  CONTEXT_PLACEMENT_DAY_MS,
  CONTEXT_PLACEMENT_PROJECTION,
  CONTEXT_PLACEMENT_RECEIPT_PHASE,
  reconcileAnswerPlacements,
  reconcileReceiptPlacements,
} from './placement-schema.js';

/** The UTC days a placement status counts: today and the six before it. */
export const CONTEXT_PLACEMENT_STATUS_DAYS = 7;

const pageKeys = jsonKeys(['project_id', 'session_id', 'id']);
const pageStatements = (name: string, sql: readonly string[]) => sql.map((text, i) => write<[string]>({ name: `contextPlacement.${name}${i}`, sql: text }));

const clearRows = write<[]>({ name: 'contextPlacement.clearRows', sql: 'DELETE FROM context_placements' });
const clearDays = write<[]>({ name: 'contextPlacement.clearDays', sql: 'DELETE FROM context_placement_days' });

export const CONTEXT_PLACEMENT_CATCHUP = {
  projection: CONTEXT_PLACEMENT_PROJECTION,
  phases: {
    [CONTEXT_PLACEMENT_RECEIPT_PHASE]: { source: { table: 'spore_injections', columns: ['project_id', 'session_id', 'id'], unique: true }, reconcile: pageStatements('receiptPage', reconcileReceiptPlacements(pageKeys)) },
    [CONTEXT_PLACEMENT_ANSWER_PHASE]: { source: { table: 'prompt_context_answers', columns: ['project_id', 'session_id', 'id'], unique: true }, reconcile: pageStatements('answerPage', reconcileAnswerPlacements(pageKeys)) },
  },
  reset: (): Bound[] => [clearRows.bind(), clearDays.bind()],
} as const satisfies CatchupFamily;

const phases = read<[], { done: number }>({ name: 'contextPlacement.phases', sql: `SELECT done FROM projection_catchup WHERE projection='${CONTEXT_PLACEMENT_PROJECTION}'` });
const recentUnplaced = read<[from: number], { state: 'unnamed' | 'unavailable'; n: number }>({ name: 'contextPlacement.recentUnplaced',
  sql: `SELECT state,SUM(n) AS n FROM context_placement_days WHERE day>=?1 AND state IN ('unnamed','unavailable') GROUP BY state` });

/** Deliveries of the last seven UTC days on no turn: those naming no prompt, and those naming a prompt the live document does not hold. */
export type DeliveriesNotPlaced = { state: 'building' } | { state: 'ready'; unnamed: number; unavailable: number };

/** The Deployment's undelivered-placement status, from the day counters; `building` until existing deliveries have been walked. */
export async function deliveriesNotPlaced(db: RelationalStore, nowMs: number): Promise<DeliveriesNotPlaced> {
  const today = Math.floor(nowMs / CONTEXT_PLACEMENT_DAY_MS);
  const [done, rows] = await readSet(db, phases.bind(), recentUnplaced.bind(today - CONTEXT_PLACEMENT_STATUS_DAYS + 1));
  if (done.length !== Object.keys(CONTEXT_PLACEMENT_CATCHUP.phases).length || done.some(phase => phase.done !== 1)) return { state: 'building' };
  const of = (state: 'unnamed' | 'unavailable') => Number(rows.find(row => row.state === state)?.n ?? 0);
  return { state: 'ready', unnamed: of('unnamed'), unavailable: of('unavailable') };
}
