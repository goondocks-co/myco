/**
 * Spores and their supersession lineage, server-side.
 *
 * Three properties the 1.4 vault encodes and a translation drops silently:
 *
 * **The terminal-session gate.** An intelligence task must not read a spore
 * from a session still in flight — the session's own conclusions are not
 * settled yet. 1.4 expresses this as `sessions.status != 'active'`; here the
 * session facts carry `ended_at`, so a session is terminal once it has one.
 * Callers that are not intelligence tasks leave the gate off and see
 * everything, and a direct `sessionId` lookup always bypasses it.
 *
 * **Supersession lineage reads resolution events alone.** 1.4 also reads
 * `graph_edges` of type `SUPERSEDED_BY`, but that table retires with the
 * semantic graph, and the supersede path writes both inside one transaction
 * (`packages/myco/src/spores/write.ts`) — every edge has a resolution event
 * committed beside it, so the events are the complete record.
 *
 * **A status change and its resolution event are one write.** A status moved
 * without its event leaves a spore superseded by nothing, which no reader can
 * repair; a batch is atomic by contract, so the pair commits or neither does.
 */
import type { RelationalStore } from './adapters.js';
import type { ReadScope } from '../read/scope.js';

export const SPORE_STATUSES = ['active', 'superseded', 'consolidated', 'obsolete'] as const;
export type SporeStatus = (typeof SPORE_STATUSES)[number];

export const RESOLUTION_ACTIONS = ['supersede', 'consolidate', 'obsolete'] as const;
export type ResolutionAction = (typeof RESOLUTION_ACTIONS)[number];

/** The largest spore body any writer accepts, bounding one row against a caller that would grow it without limit. */
export const MAX_SPORE_CONTENT_BYTES = 256 * 1024;

export const DEFAULT_SPORE_LIMIT = 50;
export const MAX_SPORE_LIMIT = 200;

export interface SporeInsert {
  id: string;
  agentId: string;
  sessionId: string | null;
  promptId: string | null;
  observationType: string;
  status?: SporeStatus;
  content: string;
  context: string | null;
  importance?: number;
  filePath: string | null;
  tags: string | null;
  contentHash: string | null;
  properties: string | null;
  createdAt: number;
}

export interface SporeRow {
  id: string;
  agentId: string;
  sessionId: string | null;
  promptId: string | null;
  observationType: string;
  status: string;
  content: string;
  context: string | null;
  importance: number;
  filePath: string | null;
  tags: string | null;
  contentHash: string | null;
  properties: string | null;
  createdAt: number;
  updatedAt: number | null;
  embedded: number;
}

export interface ListSporesOptions {
  agentId?: string;
  observationType?: string;
  status?: string;
  sessionId?: string;
  search?: string;
  since?: number;
  /** False excludes spores whose session has not ended. A direct `sessionId` lookup is never gated. */
  includeActive?: boolean;
  limit?: number;
  offset?: number;
}

const COLUMNS = `id, agent_id AS agentId, session_id AS sessionId, prompt_id AS promptId,
  observation_type AS observationType, status, content, context, importance,
  file_path AS filePath, tags, content_hash AS contentHash, properties,
  created_at AS createdAt, updated_at AS updatedAt, embedded`;

/**
 * Writes one spore and returns it.
 *
 * `RETURNING` rather than a read-back: 1.4 selects the row again after
 * inserting it, which is free against a local file and a second round trip
 * against a Deployment.
 */
export async function insertSpore(db: RelationalStore, scope: ReadScope, row: SporeInsert): Promise<SporeRow | null> {
  return db.prepare(`INSERT INTO spores
      (project_id, id, agent_id, session_id, prompt_id, observation_type, status, content, context,
       importance, file_path, tags, content_hash, properties, created_at, embedded)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      RETURNING ${COLUMNS}`)
    .bind(scope.projectId, row.id, row.agentId, row.sessionId, row.promptId, row.observationType,
      row.status ?? 'active', row.content, row.context, row.importance ?? 5, row.filePath,
      row.tags, row.contentHash, row.properties, row.createdAt)
    .first<SporeRow>();
}

export async function getSpore(db: RelationalStore, scope: ReadScope, id: string): Promise<SporeRow | null> {
  return db.prepare(`SELECT ${COLUMNS} FROM spores WHERE project_id = ? AND id = ?`)
    .bind(scope.projectId, id).first<SporeRow>();
}

function filters(scope: ReadScope, o: ListSporesOptions): { where: string; params: unknown[] } {
  const conditions = ['project_id = ?'];
  const params: unknown[] = [scope.projectId];
  const add = (sql: string, value: unknown): void => { conditions.push(sql); params.push(value); };

  if (o.agentId !== undefined) add('agent_id = ?', o.agentId);
  if (o.observationType !== undefined) add('observation_type = ?', o.observationType);
  if (o.status !== undefined) add('status = ?', o.status);
  if (o.sessionId !== undefined) add('session_id = ?', o.sessionId);
  if (o.since !== undefined) add('created_at > ?', o.since);
  if (o.search !== undefined && o.search.length > 0) {
    conditions.push('(content LIKE ? OR observation_type LIKE ?)');
    params.push(`%${o.search}%`, `%${o.search}%`);
  }
  // A spore from a session still in flight is not settled. Asked for explicitly
  // by intelligence tasks; a direct session lookup is never gated.
  if (o.includeActive === false && o.sessionId === undefined) {
    conditions.push(`(session_id IS NULL OR EXISTS (
      SELECT 1 FROM sessions s WHERE s.project_id = spores.project_id
        AND s.session_id = spores.session_id AND s.ended_at IS NOT NULL))`);
  }
  return { where: `WHERE ${conditions.join(' AND ')}`, params };
}

/** The id breaks a tie on the instant, so two spores written in the same millisecond hold one order across every page of an offset walk. */
export async function listSpores(db: RelationalStore, scope: ReadScope, o: ListSporesOptions = {}): Promise<SporeRow[]> {
  const { where, params } = filters(scope, o);
  const limit = Math.min(o.limit ?? DEFAULT_SPORE_LIMIT, MAX_SPORE_LIMIT);
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM spores ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
    .bind(...params, limit, o.offset ?? 0).all<SporeRow>();
  return results;
}

/**
 * The named spores of this Project, in the store's own order. Ids the Project
 * does not hold are absent from the answer rather than an error: a reader
 * hydrating a record kept past a spore is told what is still there.
 */
export async function listSporesByIds(db: RelationalStore, scope: ReadScope, ids: readonly string[]): Promise<SporeRow[]> {
  const wanted = [...new Set(ids)].slice(0, MAX_SPORE_LIMIT);
  if (wanted.length === 0) return [];
  const { results } = await db
    .prepare(`SELECT ${COLUMNS} FROM spores WHERE project_id = ? AND id IN (${wanted.map(() => '?').join(', ')})`)
    .bind(scope.projectId, ...wanted).all<SporeRow>();
  return results;
}

export async function countSpores(db: RelationalStore, scope: ReadScope, o: ListSporesOptions = {}): Promise<number> {
  const { where, params } = filters(scope, o);
  const row = await db.prepare(`SELECT COUNT(*) AS c FROM spores ${where}`).bind(...params).first<{ c: number }>();
  return row?.c ?? 0;
}

export interface ResolutionEventInsert {
  id: string;
  agentId: string;
  sporeId: string;
  action: ResolutionAction;
  newSporeId: string | null;
  reason: string | null;
  sessionId: string | null;
  createdAt: number;
}

/**
 * Move a spore's status and record why, as one atomic write.
 *
 * Returns false when the spore is not in this scope — the batch changed
 * nothing, and a caller must not read that as a resolution it did not make.
 */
export async function resolveSpore(
  db: RelationalStore,
  scope: ReadScope,
  status: SporeStatus,
  event: ResolutionEventInsert,
  now: number,
): Promise<boolean> {
  const [moved] = await db.batch([
    db.prepare(`UPDATE spores SET status = ?, updated_at = ? WHERE project_id = ? AND id = ?`)
      .bind(status, now, scope.projectId, event.sporeId),
    db.prepare(`INSERT INTO resolution_events
        (project_id, id, agent_id, spore_id, action, new_spore_id, reason, session_id, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM spores WHERE project_id = ? AND id = ?)`)
      .bind(scope.projectId, event.id, event.agentId, event.sporeId, event.action,
        event.newSporeId, event.reason, event.sessionId, event.createdAt,
        scope.projectId, event.sporeId),
  ]);
  return moved.meta.changes === 1;
}

/**
 * Every spore recorded as superseding this one, newest first.
 *
 * Reads resolution events alone. The `graph_edges` half of 1.4's answer retires
 * with the semantic graph and carries nothing the events do not.
 */
export async function listSupersedingSporeIds(
  db: RelationalStore,
  scope: ReadScope,
  sporeId: string,
  limit = 10,
): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT DISTINCT new_spore_id AS id FROM resolution_events
       WHERE project_id = ? AND spore_id = ? AND action = 'supersede' AND new_spore_id IS NOT NULL
       ORDER BY created_at DESC LIMIT ?`)
    .bind(scope.projectId, sporeId, limit).all<{ id: string }>();
  return results.map((r) => r.id);
}

/**
 * Every spore this one replaced, newest first.
 *
 * The same events read from the other end: a supersede names one predecessor
 * and a consolidate names every source it merged, so a reader arriving at a
 * replacement sees what it grew out of rather than only where it leads.
 */
export async function listSupersededSporeIds(
  db: RelationalStore,
  scope: ReadScope,
  sporeId: string,
  limit = 10,
): Promise<string[]> {
  const { results } = await db
    .prepare(`SELECT DISTINCT spore_id AS id FROM resolution_events
       WHERE project_id = ? AND new_spore_id = ? AND action IN ('supersede', 'consolidate')
       ORDER BY created_at DESC LIMIT ?`)
    .bind(scope.projectId, sporeId, limit).all<{ id: string }>();
  return results.map((r) => r.id);
}

/**
 * Consolidate sources into one wisdom spore: the wisdom row and, for every
 * source, its status move and its resolution event, in one batch — a caller
 * cannot leave a wisdom spore with half its sources still active, and a
 * source already moved by another writer is left as it is.
 */
export async function consolidateSpores(
  db: RelationalStore,
  scope: ReadScope,
  wisdom: SporeInsert,
  sources: readonly string[],
  event: Omit<ResolutionEventInsert, 'id' | 'sporeId' | 'action' | 'newSporeId'>,
  now: number,
): Promise<{ wisdom: SporeRow | null; consolidated: number }> {
  const insert = db.prepare(`INSERT INTO spores
      (project_id, id, agent_id, session_id, prompt_id, observation_type, status, content, context,
       importance, file_path, tags, content_hash, properties, created_at, embedded)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      RETURNING ${COLUMNS}`)
    .bind(scope.projectId, wisdom.id, wisdom.agentId, wisdom.sessionId, wisdom.promptId, wisdom.observationType,
      wisdom.status ?? 'active', wisdom.content, wisdom.context, wisdom.importance ?? 5, wisdom.filePath,
      wisdom.tags, wisdom.contentHash, wisdom.properties, wisdom.createdAt);
  const moves = sources.flatMap((sporeId) => [
    db.prepare(`UPDATE spores SET status = 'consolidated', updated_at = ? WHERE project_id = ? AND id = ? AND status = 'active'`)
      .bind(now, scope.projectId, sporeId),
    db.prepare(`INSERT INTO resolution_events
        (project_id, id, agent_id, spore_id, action, new_spore_id, reason, session_id, created_at)
        SELECT ?, ?, ?, ?, 'consolidate', ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM spores WHERE project_id = ? AND id = ? AND status = 'consolidated' AND updated_at = ?)`)
      .bind(scope.projectId, crypto.randomUUID(), event.agentId, sporeId, wisdom.id, event.reason, event.sessionId, event.createdAt,
        scope.projectId, sporeId, now),
  ]);
  const results = await db.batch([insert, ...moves]);
  const consolidated = moves.filter((_, i) => i % 2 === 0 && results[1 + i].meta.changes === 1).length;
  return { wisdom: (results[0].results[0] as SporeRow | undefined) ?? null, consolidated };
}
