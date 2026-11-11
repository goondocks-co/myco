/**
 * A document commit's prompts and turns: the turn keys and sealed records a placement reads, each new prompt's row and
 * page, every settled turn's summary under the tool revision it read, and the card state of those turns.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { read, rows, write, type Bound } from '../index.js';
import { publicationProgressStatements } from '../learning/progress.js';
import { namedContentGuard } from '../storage/content-guard.js';
import type { DocumentKey } from './turn-statistics.js';

const heldTurns = read<[...DocumentKey, ids: string], { prompt_id: string; turn_key: string | null }>({ name: 'documentPrompts.heldTurnKeys', sql:
  `SELECT prompt_id,turn_key FROM session_prompts WHERE project_id=?1 AND session_id=?2 AND generation=?3
    AND prompt_id IN (SELECT value FROM json_each(?4))` });
const sealedRecords = read<[...DocumentKey, wanted: string], { owner: string; k: string; record_id: string; page: number }>({ name: 'documentPrompts.sealedRecords', sql:
  `SELECT r.owner,r.k,r.record_id,r.page FROM json_each(?4) j CROSS JOIN session_sealed_records r
    ON r.project_id=?1 AND r.session_id=?2 AND r.generation=?3 AND r.owner=json_extract(j.value,'$.o') AND r.k=json_extract(j.value,'$.k')
      AND r.record_id=json_extract(j.value,'$.i')` });
const sessionAgent = read<[project: string, session: string], { agent: string | null }>({ name: 'documentPrompts.sessionAgent', sql:
  'SELECT agent FROM sessions WHERE project_id=?1 AND session_id=?2' });
const priorStates = read<[...DocumentKey, owners: string], { prompt_id: string; tool_state: string | null; tool_revision: number }>({ name: 'documentPrompts.priorToolStates', sql:
  `SELECT p.prompt_id,p.tool_state,p.tool_revision FROM json_each(?4) j CROSS JOIN session_prompts p
    ON p.project_id=?1 AND p.session_id=?2 AND p.generation=?3 AND p.prompt_id=j.value` });

/** The turn key each of these prompts holds, for those already placed. */
export const heldTurnKeys = (db: RelationalStore, key: DocumentKey, ids: readonly string[]) => rows(db, heldTurns.bind(...key, JSON.stringify(ids)));
/** The sealed page each wanted record sits on, for those a sealed page holds. */
export const sealedRecordPages = (db: RelationalStore, key: DocumentKey, wanted: string) => rows(db, sealedRecords.bind(...key, wanted));
export const sessionAgentRow = async (db: RelationalStore, project: string, session: string): Promise<{ agent: string | null } | null> =>
  (await rows(db, sessionAgent.bind(project, session)))[0] ?? null;
/** The stored tool state and revision of each of these turns. */
export const priorToolStates = (db: RelationalStore, key: DocumentKey, owners: string) => rows(db, priorStates.bind(...key, owners));

const revisionsUnchanged = namedContentGuard<[...DocumentKey, turns: string]>('documentPrompts.revisionsUnchanged', `NOT EXISTS (
  SELECT 1 FROM json_each(?4) j CROSS JOIN session_prompts sp
    ON sp.project_id=?1 AND sp.session_id=?2 AND sp.generation=?3 AND sp.prompt_id=json_extract(j.value,'$.id')
    WHERE sp.tool_revision<>json_extract(j.value,'$.expected_revision'))`);
/** The commit fails unless every settled turn still has the tool revision its summary was read under. */
export const turnRevisionsHeld = (key: DocumentKey, turns: string): Bound[] => revisionsUnchanged(...key, turns);

const insertPrompts = write<[...DocumentKey, prompts: string]>({ name: 'documentPrompts.insertPrompts', sql: `INSERT OR IGNORE INTO session_prompts (project_id,session_id,generation,prompt_id,turn_key,parent_hint,ord,origin,
    prompt_kind,thread_label,created_at,claim,source_key,prompt_key_hash,preview,text_chars)
  SELECT ?1,?2,?3,json_extract(value,'$.id'),json_extract(value,'$.turn'),json_extract(value,'$.parent'),json_extract(value,'$.ord'),json_extract(value,'$.origin'),
    json_extract(value,'$.kind'),json_extract(value,'$.label'),json_extract(value,'$.at'),json_extract(value,'$.claim'),
    json_extract(value,'$.source'),json_extract(value,'$.hash'),json_extract(value,'$.preview'),json_extract(value,'$.chars') FROM json_each(?4)` });
const placePrompts = write<[placed: string, ...DocumentKey]>({ name: 'documentPrompts.placePrompts', sql: `WITH j(id,page) AS MATERIALIZED (SELECT json_extract(value,'$.id'),json_extract(value,'$.page') FROM json_each(?1))
  UPDATE session_prompts SET page=j.page FROM j WHERE project_id=?2 AND session_id=?3 AND generation=?4 AND prompt_id=j.id` });
const count = (field: string) => `${field}=COALESCE(json_extract(j.value,'$.${field}'),${field}+COALESCE(json_extract(j.value,'$.added.${field}'),0))`;
const kept = (field: string) => `${field}=COALESCE(json_extract(j.value,'$.${field}'),${field})`;
const settleTurns = write<[turns: string, ...DocumentKey]>({ name: 'documentPrompts.settleTurns', sql: `WITH j(id,value) AS MATERIALIZED (SELECT json_extract(value,'$.id'),value FROM json_each(?1))
  UPDATE session_prompts SET ${kept('preview')},${kept('text_chars')},${count('tools')},${count('replies')},${count('children')},
    ${count('plans')},${kept('failed_tools')},${kept('myco_calls')},${kept('files_named')},${kept('tool_rollup')},${kept('tool_state')},tool_revision=tool_revision+1,${kept('input_hash')},${kept('input_chars')}
  FROM j WHERE project_id=?2 AND session_id=?3 AND generation=?4 AND prompt_id=j.id AND prompt_id IN (SELECT id FROM j)` });

export const insertPromptsWrite = (key: DocumentKey, prompts: string): Bound => insertPrompts.bind(...key, prompts);
export const placePromptsWrite = (key: DocumentKey, placed: string): Bound => placePrompts.bind(placed, ...key);
export const settleTurnsWrite = (key: DocumentKey, turns: string): Bound => settleTurns.bind(turns, ...key);

const CARD_INSERT = `INSERT INTO turn_cards (project_id,session_id,turn_key,settle_at,created_at,source_activity_at)
  SELECT ?1,?2,json_extract(j.value,'$.id'),json_extract(j.value,'$.settle'),json_extract(j.value,'$.at'),json_extract(j.value,'$.activity') FROM json_each(?4) j
  WHERE json_extract(j.value,'$.hash') IS NOT (SELECT sp.input_hash FROM session_prompts sp WHERE sp.project_id=?1 AND sp.session_id=?2
    AND sp.generation=?3 AND sp.prompt_id=json_extract(j.value,'$.id'))
  ON CONFLICT (project_id,session_id,turn_key) DO`;
const pendCards = write<[...DocumentKey, turns: string]>({ name: 'documentPrompts.pendChangedCards', sql:
  `${CARD_INSERT} UPDATE SET state='pending',changes=changes+1,due_at=NULL,settle_at=excluded.settle_at` });
const addMissingCards = write<[...DocumentKey, turns: string]>({ name: 'documentPrompts.addMissingCards', sql: `${CARD_INSERT} NOTHING` });
const cardActivity = write<[project: string, session: string, turns: string]>({ name: 'documentPrompts.cardActivity', sql: `WITH j(id,value) AS MATERIALIZED (SELECT json_extract(value,'$.id'),value FROM json_each(?3))
  UPDATE turn_cards SET source_activity_at=MAX(COALESCE(source_activity_at,0),json_extract(j.value,'$.activity'))
  FROM j WHERE project_id=?1 AND session_id=?2 AND turn_key=j.id
    AND (source_activity_at IS NULL OR source_activity_at<json_extract(j.value,'$.activity'))` });
const pullForward = write<[now: number, project: string, session: string, openTurn: string | null]>({ name: 'documentPrompts.settlePendingBeforeOpenTurn', sql:
  `UPDATE turn_cards SET settle_at=MIN(settle_at,?1) WHERE project_id=?2 AND session_id=?3
    AND state='pending' AND settle_at IS NOT NULL AND turn_key IS NOT ?4` });

/**
 * The card state of settled turns: pending where the input hash changed or no card exists (a building generation only
 * adds the missing cards), their source activity, the pending turns before a new open turn brought forward, and the
 * session's learning progress.
 */
export function cardWrites(key: DocumentKey, turns: string, options: { building: boolean; openTurnMoved: boolean; openTurn: string | null; now: number }): Bound[] {
  const [project, session] = key;
  return [
    (options.building ? addMissingCards : pendCards).bind(...key, turns),
    cardActivity.bind(project, session, turns),
    ...(options.openTurnMoved ? [pullForward.bind(options.now, project, session, options.openTurn)] : []),
    ...publicationProgressStatements(project, session, options.now),
  ];
}
