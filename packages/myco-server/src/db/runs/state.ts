import type { PreparedStatement, RelationalStore } from '../../core/adapters.js';
import type { ReadScope } from '../../read/scope.js';
import { commit, read, readSet, write } from '../index.js';
import { ensureAgentStatement } from './claim.js';

/** How many times a refused compare-and-swap is recomputed before the write is reported as contended. */
export const MUTATE_ATTEMPTS = 5;

/** The state row a read returns, or null when the key is unset. */
export interface StateRow {
  key: string;
  value: string;
  updatedAt: number;
}

const stateRead = read<[project: string, agent: string, key: string], StateRow>({ name: 'runs.stateRead', sql:
  `SELECT key, value, updated_at AS updatedAt FROM agent_state WHERE project_id = ?1 AND agent_id = ?2 AND key = ?3` });

/** First write for a key. A row another writer inserted between the read and here returns nothing, which the caller reads as contention. */
const stateInsert = write<[project: string, agent: string, key: string, value: string, now: number], { landed: number }>({ name: 'runs.stateInsert', sql:
  `INSERT INTO agent_state (project_id, agent_id, key, value, updated_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING RETURNING 1 AS landed` });

/**
 * Subsequent writes, guarded by the value the caller computed against.
 *
 * `value IS ?` rather than `=`: comparing to NULL with `=` yields NULL, never
 * true, so `=` cannot match a key whose prior value is absent.
 */
const stateUpdate = write<[value: string, now: number, project: string, agent: string, key: string, current: string], { landed: number }>({ name: 'runs.stateUpdate', sql:
  `UPDATE agent_state SET value = ?1, updated_at = ?2 WHERE project_id = ?3 AND agent_id = ?4 AND key = ?5 AND value IS ?6 RETURNING 1 AS landed` });

/** An admitted owner publishes state only while its coordinating write still names its revision. */
export function guardedStateStatement(db:RelationalStore,scope:ReadScope,agentId:string,key:string,value:string,now:number,guard:{sql:string;params:unknown[]}):PreparedStatement {
  return db.prepare(`INSERT INTO agent_state(project_id,agent_id,key,value,updated_at) SELECT ?,?,?,?,? WHERE ${guard.sql}
    ON CONFLICT(project_id,agent_id,key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .bind(scope.projectId,agentId,key,value,now,...guard.params);
}

export async function getState(db: RelationalStore, scope: ReadScope, agentId: string, key: string): Promise<StateRow | null> {
  const [rows] = await readSet(db, stateRead.bind(scope.projectId, agentId, key));
  return rows[0] ?? null;
}

/**
 * Atomic read-modify-write over one state key.
 *
 * Returns false when every attempt is refused, which reports contention rather than
 * failure: the value another writer left stands, and the caller is told the
 * mutation did not land rather than being allowed to believe it did.
 */
export async function mutateState(
  db: RelationalStore,
  scope: ReadScope,
  agentId: string,
  key: string,
  mutate: (current: string | null) => string | null,
  now: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < MUTATE_ATTEMPTS; attempt += 1) {
    const row = await getState(db, scope, agentId, key);
    const current = row?.value ?? null;
    const next = mutate(current);
    if (next === null) return true;

    const [result] = await commit(db, current === null
      ? stateInsert.bind(scope.projectId, agentId, key, next, now)
      : stateUpdate.bind(next, now, scope.projectId, agentId, key, current));
    if (result.results.length === 1) return true;
  }
  return false;
}

export interface AgentIdentity {
  id: string;
  name: string;
  provider: string | null;
  model: string | null;
  enabled: boolean;
}

/**
 * Declare an agent identity, idempotently.
 *
 * Deployment-scoped: one agent configuration serves every Project the Deployment
 * holds, so this takes no scope. `created_at` is preserved on a re-declaration —
 * the row's identity outlives any one edit of its configuration.
 */
const agentUpsert = write<[id: string, name: string, provider: string | null, model: string | null, enabled: number, now: number]>({ name: 'runs.agentUpsert', sql:
  `INSERT INTO agents (id, name, provider, model, source, enabled, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'built-in', ?5, ?6, ?6)
   ON CONFLICT (id) DO UPDATE SET name = excluded.name, provider = excluded.provider, model = excluded.model, enabled = excluded.enabled, updated_at = excluded.updated_at` });
export async function upsertAgent(db: RelationalStore, agent: AgentIdentity, now: number): Promise<void> {
  await commit(db, agentUpsert.bind(agent.id, agent.name, agent.provider, agent.model, agent.enabled ? 1 : 0, now));
}

export async function ensureAgent(db: RelationalStore, agent: AgentIdentity, now: number): Promise<void> {
  await ensureAgentStatement(db, agent, now).run();
}

const agentsList = read<[], { id: string; name: string; provider: string | null; model: string | null; enabled: number }>({ name: 'runs.agentsList', sql:
  `SELECT id, name, provider, model, enabled FROM agents ORDER BY id` });
export async function listAgents(db: RelationalStore): Promise<AgentIdentity[]> {
  const [rows] = await readSet(db, agentsList.bind());
  return rows.map((r) => ({ ...r, enabled: r.enabled === 1 }));
}
