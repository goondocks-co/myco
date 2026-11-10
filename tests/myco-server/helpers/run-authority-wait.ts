import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { runWriteStore, RunWriteExpired } from '@myco-server-worker/core/run-write-store.js';
import { applyRunUpdate } from '@myco-server-worker/db/runs/change.js';

/**
 * A batch waits past each authority bound before the real adapter executes it. `db` holds the current schema; each
 * bound gets its own running run, dispatched by its own credential, so the bounds never share a row.
 */
export async function runAuthorityWait(db: RelationalStore): Promise<{ bound: string; refused: boolean; rows: number; applied: number }[]> {
  const seededAt = Date.now();
  await db.batch([
    db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('p','p',?)").bind(seededAt),
    db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('authority-agent','authority-agent','built-in',1,?)").bind(seededAt),
    db.prepare("INSERT INTO members(id,created_at) VALUES('m',?)").bind(seededAt),
    db.prepare('CREATE TABLE wait_rows(id TEXT PRIMARY KEY)'),
  ]);
  const answers = [];
  for (const bound of ['lease', 'attempt', 'credential']) {
    const now = Date.now(), expiry = now + 100;
    const credential = `credential-${bound}`, run = `run-${bound}`;
    await db.batch([
      db.prepare(`INSERT INTO member_credentials(id,member_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
        VALUES(?1,'m',?1,?2,?3,?1,?2)`).bind(credential, now, bound === 'credential' ? expiry : now + 600_000),
      db.prepare(`INSERT INTO agent_runs(project_id,id,agent_id,dispatched_by,status,lease_expires_at,started_at,run_context)
        VALUES('p',?1,'authority-agent',?2,'running',?3,?4,'{"timeoutSeconds":300}')`)
        .bind(run, credential, bound === 'lease' ? expiry : null, bound === 'attempt' ? expiry - 420_000 : now),
    ]);
    const delayed = { prepare: db.prepare.bind(db), batch: async (statements: Parameters<RelationalStore['batch']>[0]) => {
      await new Promise(resolve => setTimeout(resolve, 180));
      return db.batch(statements);
    } };
    const caller = { tokenId: credential, now, deadline: bound === 'attempt' ? expiry : now + 420_000 };
    const guarded = runWriteStore(delayed, 'p', run, caller);
    let refused = false;
    try { await guarded.prepare('INSERT INTO wait_rows VALUES(?)').bind(bound).run(); }
    catch (error) { if (!(error instanceof RunWriteExpired)) throw error; refused = true; }
    const applied = await applyRunUpdate(db, { projectId: 'p' }, run, { tokens_used: 1 }, undefined, undefined, undefined, caller);
    const rows = await db.prepare('SELECT COUNT(*) AS n FROM wait_rows').first<{ n: number }>();
    answers.push({ bound, refused, applied, rows: rows!.n });
  }
  return answers;
}
