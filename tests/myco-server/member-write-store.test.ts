import { expect, it } from 'bun:test';
import { memberWriteStore, MemberWriteRefused } from '@myco-server-worker/auth/member-write-store.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { changingAt } from './helpers/store-faults.js';

for (const method of ['run', 'first', 'all', 'batch'] as const) {
  for (const authority of ['admin', 'member'] as const) {
    it(`${authority} ${method}: revocation before an atomic mutation is refused`, async () => {
      const f = sqliteEnv();
      const raced = changingAt(f.db, 1, () => f.sqlite.run("UPDATE members SET revoked_at=1 WHERE id='mem_machine_2'"));
      try {
        const db = memberWriteStore(raced.store, 'mem_machine_2', authority);
        const statement = db.prepare("/* attributed write */ WITH leaf AS (SELECT 'agent.tasks' AS name) INSERT INTO deployment_settings (leaf,value,updated_at,updated_by) SELECT name,'{}',1,'mem_machine_2' FROM leaf RETURNING leaf");
        const write = method === 'batch' ? db.batch([statement]) : statement[method]();
        await expect(write).rejects.toBeInstanceOf(MemberWriteRefused);
        expect(raced.landed()).toBe(true);
        expect(f.sqlite.query('SELECT * FROM deployment_settings').all()).toEqual([]);
      } finally { f.sqlite.close(); }
    });
    it(`${authority} ${method}: a live actor receives the original RETURNING rows`, async () => {
      const f = sqliteEnv();
      try {
        f.sqlite.run("UPDATE members SET role=? WHERE id='mem_machine_2'", [authority]);
        const db = memberWriteStore(f.db, 'mem_machine_2', authority);
        const statement = db.prepare("INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.tasks','{}',1,'mem_machine_2') RETURNING leaf");
        const answer = method === 'batch' ? (await db.batch([statement]))[0] : await statement[method]();
        expect(method === 'first' ? answer : (answer as { results: unknown[] }).results).toEqual(method === 'first' ? { leaf: 'agent.tasks' } : [{ leaf: 'agent.tasks' }]);
      } finally { f.sqlite.close(); }
    });
  }
}

it('an admin batch refuses before every row when demotion commits before its last statement', async () => {
  const f = sqliteEnv();
  const raced = changingAt(f.db, 1, () => f.sqlite.run("UPDATE members SET role='member' WHERE id='mem_machine_2'"));
  try {
    const db = memberWriteStore(raced.store, 'mem_machine_2', 'admin');
    await expect(db.batch([
      db.prepare("INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.tasks','{}',1,'mem_machine_2')"),
      db.prepare("DELETE FROM deployment_settings WHERE leaf='agent.tasks'"),
    ])).rejects.toBeInstanceOf(MemberWriteRefused);
    expect(raced.landed()).toBe(true);
    expect(f.sqlite.query('SELECT * FROM deployment_settings').all()).toEqual([]);
    expect(f.sqlite.query("SELECT role FROM members WHERE id='mem_machine_2'").get()).toEqual({ role: 'member' });
  } finally { f.sqlite.close(); }
});
