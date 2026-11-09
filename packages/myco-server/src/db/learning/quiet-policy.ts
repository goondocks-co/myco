import type { RelationalStore } from '../../core/adapters.js';
import { commitNamed, read, readSet, refusalCode, refused, write, assertion, type Bound } from '../index.js';
import { jsonKeys } from '../ddl.js';
import type { CatchupFamily } from '../projections/family.js';
import { FRESH_LEARNING_MS } from '../runs/learning-policy.js';

/** Fresh sessions keep an hour of their source freshness window ahead of an idle close running past it. */
const ADMISSION_MARGIN_MS = 3_600_000;
const POLICY_PAGE = 100;
const POLICY_MINUTES = '(SELECT minutes FROM learning_quiet_policy WHERE id=1)';
const PAGE_KEYS = jsonKeys(['project_id', 'session_id']);

/**
 * The idle-close policy generation: a settings writer names a generation and its minutes, the shared catch-up rewrites
 * each session's quiet deadline for that generation in keyed pages, and the generation activates when the walk completes.
 * While a generation builds the deadlines already held keep working; a session not yet visited stays on the previous
 * value and is rewritten when the walk reaches it. An older generation than the held one is refused, so a retried
 * accept cannot overwrite a newer intent.
 */
export const QUIET_POLICY_STALE = refusalCode('learning_quiet_policy_stale');

const newer = assertion<[generation: number]>({ name: 'learningQuietPolicy.newer', when: 'NOT EXISTS(SELECT 1 FROM learning_quiet_policy WHERE id=1 AND generation>=?1)', refusal: QUIET_POLICY_STALE });
const record = write<[generation: number, minutes: number, now: number], { generation: number }>({
  name: 'learningQuietPolicy.record', sql: `INSERT INTO learning_quiet_policy(id,generation,minutes,state,updated_at) VALUES(1,?1,?2,'building',?3)
    ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,minutes=excluded.minutes,state='building',updated_at=excluded.updated_at RETURNING generation` });
const restart = write<[]>({ name: 'learningQuietPolicy.restart', sql: "UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL,generation=generation+1 WHERE projection='learning_quiet_policy' AND phase='learningQuietPolicy'" });

/**
 * Accept a policy generation and start its rebuild. Returns `recorded` for a new generation; `current` when this
 * generation is already held; `stale` for an older one, which changes nothing.
 */
export async function acceptQuietPolicy(db: RelationalStore, input: { generation: number; minutes: number; now: number }): Promise<'recorded' | 'current' | 'stale'> {
  const [held] = await readSet(db, policy.bind());
  if (held[0] !== undefined && held[0].generation === input.generation) return 'current';
  try {
    const { accepted } = await commitNamed(db, { admitted: newer.bind(input.generation), accepted: record.bind(input.generation, input.minutes, input.now), restart: restart.bind() });
    return accepted.results.length > 0 ? 'recorded' : 'stale';
  } catch (error) {
    if (refused(error, QUIET_POLICY_STALE)) return 'stale';
    throw error;
  }
}

const quietAt = `CASE WHEN s.ended_at IS NOT NULL THEN 0
  WHEN learning_sessions.source_activity_at+${FRESH_LEARNING_MS}>s.last_received_at THEN MIN(s.last_received_at+60000*${POLICY_MINUTES},learning_sessions.source_activity_at+${FRESH_LEARNING_MS - ADMISSION_MARGIN_MS})
  ELSE s.last_received_at+60000*${POLICY_MINUTES} END`;
const rebuild = write<[keys: string]>({ name: 'learningQuietPolicy.rebuildPage', sql: `WITH keys AS (${PAGE_KEYS}) UPDATE learning_sessions SET
    quiet_at=COALESCE((SELECT ${quietAt} FROM sessions s WHERE s.project_id=learning_sessions.project_id AND s.session_id=learning_sessions.session_id),0),
    quiet_generation=(SELECT generation FROM learning_quiet_policy WHERE id=1)
  WHERE (project_id,session_id) IN (SELECT project_id,session_id FROM keys)
    AND quiet_generation IS NOT (SELECT generation FROM learning_quiet_policy WHERE id=1)` });
const activate = write<[now: number, walkGeneration: number]>({ name: 'learningQuietPolicy.activate', sql: `UPDATE learning_quiet_policy SET state='active',effective_minutes=minutes,updated_at=?1
  WHERE id=1 AND state='building' AND EXISTS(SELECT 1 FROM projection_catchup WHERE projection='learning_quiet_policy' AND phase='learningQuietPolicy' AND generation=?2)` });

export const LEARNING_QUIET_POLICY_CATCHUP = {
  projection: 'learning_quiet_policy',
  phases: { learningQuietPolicy: {
    source: { table: 'learning_sessions', columns: ['project_id', 'session_id'], unique: true, pageSize: POLICY_PAGE },
    reconcile: [{ bind: (keys: string) => rebuild.bind(keys) }],
    // The page holding the walk's last key activates in the commit that advances the cursor, only for the walk it read.
    page: async ({ keys, now, generation }) => ({ statements: keys.length < POLICY_PAGE ? [activate.bind(now, generation) as Bound] : [], complete: true }),
  } },
} as const satisfies CatchupFamily;

const policy = read<[], { generation: number; minutes: number; effective_minutes: number | null; state: 'building' | 'active' }>({
  name: 'learningQuietPolicy.read', sql: 'SELECT generation,minutes,effective_minutes,state FROM learning_quiet_policy WHERE id=1' });

/** The policy a settings surface shows: what is pending, and what is effective. Null before any generation is accepted. */
export async function readQuietPolicy(db: RelationalStore): Promise<{ generation: number; pendingMinutes: number | null; effectiveMinutes: number | null; state: 'building' | 'active' } | null> {
  const [rows] = await readSet(db, policy.bind());
  const row = rows[0];
  if (row === undefined) return null;
  return { generation: row.generation, pendingMinutes: row.state === 'building' ? row.minutes : null, effectiveMinutes: row.state === 'active' ? row.minutes : row.effective_minutes, state: row.state };
}
