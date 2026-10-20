import { expect, it } from 'bun:test';
import { savePlan, changePlanStatus } from '@myco-server-worker/core/plans.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { seedCredential, sqliteD1 } from './helpers/d1.js';

it('a title-only save retains an administrator status written after its read', async () => {
  const f = sqliteEnv();
  try {
    seedCredential(f.sqlite, { id: 't', expiresAt: 1000 });
    const scope = { projectId: 'proj_1' };
    const member = { machineId: 'machine_1', tokenId: 't' };
    const created = await savePlan(f.serverEnv, member, scope, { sessionId: 's', planKey: 'key', content: 'body', title: 'Old' }, 100);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);
    let raced = false;
    const db = sqliteD1(f.sqlite, { onFirst(sql, row) {
      if (!raced && sql.includes('FROM plans') && row?.plan_key === created.row.planKey) {
        raced = true;
        f.sqlite.query("UPDATE plans SET status = 'completed', updated_by = 'admin', updated_at = 150 WHERE plan_key = ?").run(created.row.planKey);
      }
      return row;
    } });
    const updated = await savePlan({ ...f.serverEnv, db }, member, scope, { id: created.row.planKey, sessionId: 's', title: 'New' }, 200);
    expect(raced).toBe(true);
    expect(updated.ok && { title: updated.row.title, status: updated.row.status }).toEqual({ title: 'New', status: 'completed' });
    const explicit = await savePlan(f.serverEnv, member, scope, { id: created.row.planKey, sessionId: 's', status: 'in_progress' }, 201);
    expect(explicit.ok && explicit.row.status).toBe('in_progress');
    expect((await changePlanStatus(db, scope, created.row.planKey, 'completed', 'admin', 202))?.status).toBe('completed');
  } finally { f.sqlite.close(); }
});
