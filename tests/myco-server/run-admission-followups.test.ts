import { describe, expect, it } from 'bun:test';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { recordDispatch } from '@myco-server-worker/core/runs.js';
import { runWriteStore, RunWriteExpired } from '@myco-server-worker/core/run-write-store.js';
import { serverEnvFromBunConfig } from '@myco-server-worker/platform/bun/env.js';
import { memberHeaders, sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';

async function setup(onSql?: Parameters<typeof sqliteEnv>[0]) {
  const f = sqliteEnv(onSql);
  const now = Date.now();
  await ensureMember(f.db, HARNESS_MEMBER_ID, now, 'member', 'harness');
  const holder = await issueMemberToken(f.db, { memberId: HARNESS_MEMBER_ID, machineId: 'machine_1' }, now);
  f.sqlite.run("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Myco','built-in',1,0)");
  await recordDispatch(f.db, { projectId: 'proj_1' }, { id: 'target', agentId: 'myco-agent', task: 'extract-curate', provider: null, model: null,
    runContext: JSON.stringify({ timeoutSeconds: 300 }), startedAt: now, dispatchedBy: holder.tokenId });
  f.sqlite.run("UPDATE agent_runs SET status = 'running' WHERE id = 'target'");
  return { ...f, holder, now };
}

for (const target of ['cloudflare', 'native'] as const) describe(`${target}: MCP mutation authority`, () => {
  for (const op of ['state_set', 'report'] as const) for (const bound of ['lease', 'deadline', 'credential', 'revocation', 'terminal'] as const) {
    it(`${op} refuses ${bound} lost between admission and mutation`, async () => {
      let armed = false;
      let now = Date.now();
      const f = await setup({ onSql: (sql, sqlite) => {
        const trigger = bound === 'deadline'
          ? sql.startsWith('SELECT key, value') || sql.startsWith('SELECT id, harness')
          : sql.startsWith('INSERT INTO agent_state') || sql.startsWith('INSERT INTO agent_reports');
        if (!armed || !trigger) return;
        armed = false;
        if (bound === 'lease') sqlite.run("UPDATE agent_runs SET lease_expires_at = 1 WHERE id = 'target'");
        if (bound === 'deadline') sqlite.run("UPDATE agent_runs SET started_at = 1 WHERE id = 'target'");
        if (bound === 'credential') sqlite.run("UPDATE agent_runs SET dispatched_by = NULL WHERE id = 'target'");
        if (bound === 'terminal') sqlite.run("UPDATE agent_runs SET status = 'failed' WHERE id = 'target'");
        if (bound === 'revocation') sqlite.run('UPDATE member_credentials SET revoked_at = 1 WHERE id = ?', [f.holder.tokenId]);
      } });
      now = f.now;
      if (op === 'state_set') f.sqlite.run("UPDATE agent_runs SET task = 'extract-curate' WHERE id = 'target'");
      const env = target === 'native' ? { ...serverEnvFromBunConfig({ sqlite: f.sqlite, blobDir: '/unused' }), db: f.db } : f.serverEnv;
      const pipeline = createServer({ now: () => now, sourceOf: () => '127.0.0.1', fetchImpl: fetch });
      try {
        const args = op === 'state_set' ? { op, key: 'k', value: 'v' } : { op, action: 'extract', summary: 'done' };
        armed = true;
        const response = await pipeline.handleRequest(new Request('https://s/mcp', { method: 'POST', headers: memberHeaders(f.holder.token),
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_run', arguments: args } }),
        }), env);
        const body = await response.json() as { error?: { message: string; data: { code: string } } };
        expect(body.error).toMatchObject({ message: expect.stringContaining('credential holds no live run'), data: { code: 'tool_call_failed' } });
        expect(f.sqlite.query('SELECT COUNT(*) AS n FROM agent_state').get()).toEqual({ n: 0 });
        expect(f.sqlite.query('SELECT COUNT(*) AS n FROM agent_reports').get()).toEqual({ n: 0 });
      } finally { f.sqlite.close(); }
    });
  }
  it('rolls back an entire editorial batch when it loses run authority', async () => {
    const f = await setup();
    try {
      const db = runWriteStore(f.db, 'proj_1', 'target', { tokenId: f.holder.tokenId, now: f.now, deadline: f.now + 420_000 });
      await expect(db.batch([
        db.prepare("INSERT INTO agent_state(project_id,agent_id,key,value,updated_at) VALUES('proj_1','myco-agent','k','v',0)"),
        db.prepare("UPDATE agent_runs SET lease_expires_at = 1 WHERE id = 'target'"),
      ])).rejects.toBeInstanceOf(RunWriteExpired);
      expect(f.sqlite.query('SELECT COUNT(*) AS n FROM agent_state').get()).toEqual({ n: 0 });
      expect(f.sqlite.query("SELECT lease_expires_at AS lease FROM agent_runs WHERE id = 'target'").get()).toEqual({ lease: null });
    } finally { f.sqlite.close(); }
  });
});
