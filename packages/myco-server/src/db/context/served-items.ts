import type { RelationalStore } from '../../core/adapters.js';
import { jsonKeys, trigger } from '../ddl.js';
import { read, readSet, write } from '../index.js';
import { everyPhaseDone, type CatchupFamily } from '../projections/family.js';
import { notTombstonedSql } from '../session-read-model.js';

/** Keyed candidate exclusions for delivered items and pending selections. */
export const SERVED_ITEMS_PROJECTION = 'session_served_items';
export const SERVED_ITEMS_PHASE = 'servedItems';

type ServedKind = 'spore' | 'plan';

/** A receipt's id array, or none where the column holds no valid JSON array. */
const jsonArray = (column: string) => `CASE WHEN json_valid(${column}) AND json_type(${column})='array' THEN ${column} ELSE '[]' END`;

/** The membership one receipt contributes, from the receipt row the same statement names: its spores, then its plans. */
const receiptItems = (receipts: string) => `INSERT OR IGNORE INTO session_served_items(project_id,session_id,kind,item_id)
  SELECT r.project_id,r.session_id,'spore',j.value FROM (${receipts}) k CROSS JOIN spore_injections r
    ON r.project_id=k.project_id AND r.session_id=k.session_id AND r.id=k.id CROSS JOIN json_each(${jsonArray('r.spore_ids')}) j
    WHERE j.type='text' AND ${notTombstonedSql('r')}
  UNION ALL
  SELECT r.project_id,r.session_id,'plan',j.value FROM (${receipts}) k CROSS JOIN spore_injections r
    ON r.project_id=k.project_id AND r.session_id=k.session_id AND r.id=k.id CROSS JOIN json_each(${jsonArray('r.plan_ids')}) j
    WHERE j.type='text' AND ${notTombstonedSql('r')}`;

/** Insert-only membership trigger used by its schema step. */
export const SERVED_ITEMS_TRIGGER = trigger('session_served_items_receipt', 'spore_injections', 'INSERT',
  receiptItems('SELECT NEW.project_id AS project_id,NEW.session_id AS session_id,NEW.id AS id'));

/** A selection reserves candidates briefly while the member renders and reports delivery. */
export const CONTEXT_RESERVATION_MS = 8_000;

/** Candidate membership is permanent only for delivered receipts; pending selections expire. */
export const receiptExclusions = (receipts: string): string => `INSERT INTO session_served_items(project_id,session_id,kind,item_id,reservation_expires_at)
  ${(['spore', 'plan'] as const).map(kind => `SELECT r.project_id,r.session_id,'${kind}',j.value,
    CASE WHEN r.delivered_at IS NOT NULL THEN 0 ELSE r.created_at+${CONTEXT_RESERVATION_MS} END
    FROM (${receipts}) k CROSS JOIN spore_injections r
    ON r.project_id=k.project_id AND r.session_id=k.session_id AND r.id=k.id CROSS JOIN json_each(${jsonArray(`r.${kind}_ids`)}) j
    WHERE j.type='text' AND ${notTombstonedSql('r')}`).join(' UNION ALL ')}
  ON CONFLICT(project_id,session_id,kind,item_id) DO UPDATE SET reservation_expires_at=CASE
    WHEN session_served_items.reservation_expires_at=0 OR excluded.reservation_expires_at=0 THEN 0
    ELSE MAX(session_served_items.reservation_expires_at,excluded.reservation_expires_at) END`;

const newReceipt = 'SELECT NEW.project_id AS project_id,NEW.session_id AS session_id,NEW.id AS id';
export const RECEIPT_EXCLUSION_TRIGGERS = [
  trigger('session_served_items_receipt', 'spore_injections', 'INSERT', receiptExclusions(newReceipt)),
  trigger('session_served_items_delivery', 'spore_injections', 'UPDATE OF delivered_at', receiptExclusions(newReceipt), 'NEW.delivered_at IS NOT NULL'),
];

/** A keyed exclusion predicate shared by selection and the receipt's atomic admission. */
export const excludedCandidate = (slots: { project: string; session: string; candidates: string; now: string }): string =>
  `SELECT s.kind,s.item_id FROM json_each(${slots.candidates}) c CROSS JOIN session_served_items s
    ON s.project_id=${slots.project} AND s.session_id=${slots.session} AND s.kind=json_extract(c.value,'$[0]') AND s.item_id=json_extract(c.value,'$[1]')
    WHERE s.reservation_expires_at=0 OR s.reservation_expires_at>${slots.now}`;

/** Candidate exclusions read by key: cost follows the candidates, never the session's history. */
const servedAmongCandidates = read<[project: string, session: string, candidates: string, now: number], { kind: ServedKind; item_id: string }>({ name: 'servedItems.among',
  sql: excludedCandidate({ project: '?1', session: '?2', candidates: '?3', now: '?4' }) });

const membershipPhases = read<[], { phase: string; done: number }>({ name: 'servedItems.phases',
  sql: `SELECT phase,done FROM projection_catchup WHERE projection='${SERVED_ITEMS_PROJECTION}'` });

/** Every receipt array of the session: read only while the membership is still being built from receipts written before it. */
const sessionReceiptArrays = read<[project: string, session: string, since: number], { spore_ids: string | null; plan_ids: string | null }>({ name: 'servedItems.receiptArrays',
  sql: 'SELECT spore_ids,plan_ids FROM spore_injections WHERE project_id=?1 AND session_id=?2 AND (delivered_at IS NOT NULL OR created_at>?3)' });

const ids = (raw: string | null): string[] => {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
};

interface Served { spores: Set<string>; plans: Set<string> }

/**
 * Which of `candidates` the session has already been served. Until the membership holds every receipt written before
 * it, a missing row does not mean "not served", so the session's receipts are read as well.
 */
export async function servedAmong(
  db: RelationalStore,
  input: { project: string; session: string; now?: number; candidates: ReadonlyArray<readonly [ServedKind, string]> },
): Promise<Served> {
  const served: Served = { spores: new Set(), plans: new Set() };
  const [rows, phases] = await readSet(db, servedAmongCandidates.bind(input.project, input.session, JSON.stringify(input.candidates), input.now ?? Date.now()), membershipPhases.bind());
  for (const row of rows) (row.kind === 'spore' ? served.spores : served.plans).add(row.item_id);
  if (everyPhaseDone(SERVED_ITEMS_CATCHUP, phases)) return served;
  const [receipts] = await readSet(db, sessionReceiptArrays.bind(input.project, input.session, (input.now ?? Date.now()) - CONTEXT_RESERVATION_MS));
  const wanted = new Set(input.candidates.map(([kind, id]) => `${kind}:${id}`));
  for (const receipt of receipts) {
    for (const id of ids(receipt.spore_ids)) if (wanted.has(`spore:${id}`)) served.spores.add(id);
    for (const id of ids(receipt.plan_ids)) if (wanted.has(`plan:${id}`)) served.plans.add(id);
  }
  return served;
}

/** Fills the membership from the receipts written before the trigger; a receipt already counted adds nothing, so a replay is harmless. */
export const SERVED_ITEMS_CATCHUP = {
  projection: SERVED_ITEMS_PROJECTION,
  phases: {
    [SERVED_ITEMS_PHASE]: {
      source: { table: 'spore_injections', columns: ['project_id', 'session_id', 'id'], unique: true },
      reconcile: [write<[keys: string]>({ name: 'servedItems.receiptPage', sql: receiptExclusions(jsonKeys(['project_id', 'session_id', 'id'])) })],
    },
  },
} as const satisfies CatchupFamily;
