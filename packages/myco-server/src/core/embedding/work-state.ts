import type { RelationalStore } from '../adapters.js';

export const WORK_SWEEP_PAGE = 256;
export const WORK_PREDICATE_VERSION = 1;
export const WORK_SWEEP_CONTINUE_MS = 30_000;
export const WORK_SWEEP_MIN_MS = 5 * 60_000;
export const WORK_SWEEP_MAX_MS = 30 * 60_000;

export interface WorkSweep {
  pending: boolean;
  /** Null completes this bounded sweep cycle. */
  cursor: string | null;
}

interface WorkState {
  revision: number;
  checked_revision: number;
  pending: number;
  wake_at: number | null;
  sweep_at: number;
  sweep_cursor: string | null;
  idle_rounds: number;
}

/**
 * Source and journal triggers dirty these rows in their own transaction. A scan only acknowledges the revision it
 * read; a concurrent writer leaves work pending. Clean rows receive bounded, cursor-driven safety sweeps with idle
 * backoff. Missing rows and a changed model scope require a fresh check.
 */
export async function recordedWork(
  db: RelationalStore, projectId: string, model: string, kind: 'embedding' | 'hubness', scope: string, now: number,
  probe: () => Promise<{ pending: boolean; wakeAt?: number | null }>,
  sweep: (cursor: string | null) => Promise<WorkSweep>,
): Promise<boolean> {
  const identity = [projectId, model, kind] as const;
  let row = await db.prepare(`SELECT revision, checked_revision, pending, wake_at, sweep_at, sweep_cursor, idle_rounds, scope
    FROM embedding_work_state WHERE project_id = ? AND model_key = ? AND kind = ?`).bind(...identity).first<WorkState & { scope: string }>();
  if (row === null || row.scope !== scope) {
    await db.prepare(`INSERT INTO embedding_work_state(project_id,model_key,kind,scope) VALUES(?,?,?,?)
      ON CONFLICT(project_id,model_key,kind) DO UPDATE SET scope=excluded.scope,revision=revision+1,
        checked_revision=-1,pending=1,wake_at=NULL,sweep_at=0,sweep_cursor=NULL,idle_rounds=0
      WHERE scope <> excluded.scope`).bind(...identity, scope).run();
    row = await db.prepare(`SELECT revision, checked_revision, pending, wake_at, sweep_at, sweep_cursor, idle_rounds, scope
      FROM embedding_work_state WHERE project_id = ? AND model_key = ? AND kind = ?`).bind(...identity).first<WorkState & { scope: string }>();
    if (row === null || row.scope !== scope) return true;
  }
  const dirty = row.revision !== row.checked_revision;
  const due = row.wake_at !== null && row.wake_at <= now;
  if (!dirty && !due && row.pending === 0 && row.sweep_at > now) return false;

  const scanning = !dirty && !due && row.pending === 0;
  const result: { pending: boolean; wakeAt?: number | null; cursor?: string | null } = scanning ? await sweep(row.sweep_cursor) : await probe();
  const cursor = result.cursor ?? null;
  const rounds = result.pending || dirty ? 0 : cursor === null ? Math.min(row.idle_rounds + 1, 4) : row.idle_rounds;
  const interval = cursor === null ? Math.min(WORK_SWEEP_MAX_MS, WORK_SWEEP_MIN_MS * 2 ** rounds) : WORK_SWEEP_CONTINUE_MS;
  const wakeAt = 'wakeAt' in result ? result.wakeAt ?? null : row.wake_at;
  const committed = await db.prepare(`UPDATE embedding_work_state SET revision=revision+1,checked_revision=revision+1,
    pending=?,wake_at=?,sweep_at=?,sweep_cursor=?,idle_rounds=?
    WHERE project_id=? AND model_key=? AND kind=? AND scope=? AND revision=?`)
    .bind(result.pending ? 1 : 0, wakeAt, now + interval, cursor, rounds, ...identity, scope, row.revision).run();
  return committed.meta.changes !== 1 || result.pending;
}
