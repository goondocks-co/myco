import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { runWriteStore, RunWriteExpired } from '@myco-server-worker/core/run-write-store.js';
import { applyRunUpdate } from '@myco-server-worker/core/runs.js';

/** A batch waits past each authority bound before the real adapter executes it. */
export async function runAuthorityWait(db: RelationalStore): Promise<{ bound: string; refused: boolean; rows: number; applied: number }[]> {
  await db.batch([
    db.prepare('CREATE TABLE members(id TEXT PRIMARY KEY, revoked_at INTEGER)'),
    db.prepare('CREATE TABLE member_credentials(id TEXT PRIMARY KEY, member_id TEXT, revoked_at INTEGER, expires_at INTEGER)'),
    db.prepare('CREATE TABLE agent_runs(project_id TEXT, id TEXT, dispatched_by TEXT, status TEXT, lease_expires_at INTEGER, started_at INTEGER, resumed_at INTEGER, run_context TEXT, tokens_used INTEGER)'),
    db.prepare('CREATE TABLE wait_rows(id TEXT PRIMARY KEY)'),
    db.prepare("INSERT INTO members VALUES('m', NULL)"),
  ]);
  const answers = [];
  for (const bound of ['lease', 'attempt', 'credential']) {
    const now = Date.now(), expiry = now + 100;
    await db.batch([
      db.prepare('DELETE FROM agent_runs'), db.prepare('DELETE FROM member_credentials'),
      db.prepare("INSERT INTO member_credentials VALUES('credential','m',NULL,?)").bind(bound === 'credential' ? expiry : now + 600_000),
      db.prepare("INSERT INTO agent_runs VALUES('p','r','credential','running',?,?,NULL,'{\"timeoutSeconds\":300}',NULL)")
        .bind(bound === 'lease' ? expiry : null, bound === 'attempt' ? expiry - 420_000 : now),
    ]);
    const delayed = { prepare: db.prepare.bind(db), batch: async (statements: Parameters<RelationalStore['batch']>[0]) => {
      await new Promise(resolve => setTimeout(resolve, 180));
      return db.batch(statements);
    } };
    const caller = { tokenId: 'credential', now, deadline: bound === 'attempt' ? expiry : now + 420_000 };
    const guarded = runWriteStore(delayed, 'p', 'r', caller);
    let refused = false;
    try { await guarded.prepare('INSERT INTO wait_rows VALUES(?)').bind(bound).run(); }
    catch (error) { if (!(error instanceof RunWriteExpired)) throw error; refused = true; }
    const applied = await applyRunUpdate(db, { projectId: 'p' }, 'r', { tokens_used: 1 }, undefined, undefined, undefined, caller);
    const rows = await db.prepare('SELECT COUNT(*) AS n FROM wait_rows').first<{ n: number }>();
    answers.push({ bound, refused, applied, rows: rows!.n });
  }
  return answers;
}
