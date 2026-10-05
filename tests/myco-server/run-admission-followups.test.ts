import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from '../support/fenced-fs.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSupervisor, RUNTIME_DIED_ERROR, RUNTIME_RECLAIMED_ERROR } from '@myco/agent/runtime/supervisor.js';
import { RUNTIME_EXIT } from '@myco/agent/runtime/process-signals.js';
import { CHILD_CLOSE_RESERVE_MS } from '@myco/agent/runtime/supervisor-policy.js';
import { shapeRunError } from '@goondocks/myco-shared/run-text';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
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
  await recordDispatch(f.db, { projectId: 'proj_1' }, { id: 'target', agentId: 'myco-agent', task: 'container-smoke', provider: null, model: null,
    runContext: JSON.stringify({ timeoutSeconds: 300 }), startedAt: now, dispatchedBy: holder.tokenId });
  f.sqlite.run("UPDATE agent_runs SET status = 'running' WHERE id = 'target'");
  return { ...f, holder, now };
}

it('a healthy child finishing near its granted timer bound is not killed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'myco-admission-'));
  let killed = false;
  let finish: (code: number) => void = () => {};
  const exited = new Promise<number>(resolve => { finish = resolve; });
  const supervisor = startSupervisor({ token: 'launch', entry: '/unused', workDir: root, port: 0, hostname: '127.0.0.1',
    events: { on: () => {} }, exit: () => {}, spawn: () => ({ pid: 0, exited, kill: () => { killed = true; finish(-1); } }),
  });
  try {
    const answer = await fetch(`http://127.0.0.1:${supervisor.port}/launch`, { method: 'POST', headers: { authorization: 'Bearer launch' },
      body: JSON.stringify({ runId: 'healthy', timeoutSeconds: 300, envVars: { MYCO_RUN_REMAINING_MS: String(CHILD_CLOSE_RESERVE_MS + 300) } }) });
    expect(answer.status).toBe(202);
    await new Promise(resolve => setTimeout(resolve, 200));
    finish(RUNTIME_EXIT.ran);
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(killed).toBe(false);
  } finally { finish(RUNTIME_EXIT.ran); await supervisor.stop(); rmSync(root, { recursive: true, force: true }); }
});

for (const replaced of [false, true]) it(`an overrunning child closes before server expiry and preserves replaced=${replaced}`, async () => {
  const f = await setup();
  const root = mkdtempSync(join(tmpdir(), 'myco-admission-'));
  turnOnGatedCapabilities(f.sqlite);
  const deadline = f.now + CHILD_CLOSE_RESERVE_MS + 300;
  f.sqlite.run("UPDATE agent_runs SET started_at = ? WHERE id = 'target'", [deadline - 420_000]);
  const wrappingKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  const env = serverEnvFromBindings({ ...f.env, HARNESS_LAUNCH_MODE: 'record', SECRET_WRAP_KEY: { get: async () => wrappingKey } });
  await deploymentSecretStore(f.db, env.wrappingKey).put('anthropic', 'sk-ant-oat-replacement-test', 'test', f.now);
  const pipeline = createServer({ now: Date.now, sourceOf: () => '127.0.0.1', fetchImpl: fetch });
  const closes: Record<string, unknown>[] = [];
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async request => {
    const answer = await pipeline.handleRequest(request, env);
    closes.push(await answer.clone().json() as Record<string, unknown>);
    return answer;
  } });
  let finish: (code: number) => void = () => {};
  const exited = new Promise<number>(resolve => { finish = resolve; });
  const events = new Map<string, () => void>();
  const supervisor = startSupervisor({ token: 'launch', entry: '/unused', workDir: root, port: 0, hostname: '127.0.0.1',
    events: { on: (name, fn) => { events.set(name, fn); } }, exit: () => {},
    spawn: () => ({ pid: 0, exited, kill: signal => { if (signal === 'SIGKILL') finish(replaced ? RUNTIME_EXIT.unclaimed : -1); } }),
  });
  try {
    const launch = await fetch(`http://127.0.0.1:${supervisor.port}/launch`, { method: 'POST', headers: { authorization: 'Bearer launch' },
      body: JSON.stringify({ runId: 'target', timeoutSeconds: 300, envVars: { MYCO_SERVER_URL: `http://127.0.0.1:${server.port}`,
        MYCO_MEMBER_TOKEN: f.holder.token, MYCO_PROJECT: 'proj_1', MYCO_TASK: 'container-smoke', MYCO_RUN_REMAINING_MS: String(deadline - Date.now()) } }),
    });
    expect(launch.status).toBe(202);
    if (replaced) events.get('SIGTERM')!();
    const waitUntil = Date.now() + 5_000;
    while (closes.length === 0 && Date.now() < waitUntil) await new Promise(resolve => setTimeout(resolve, 20));
    expect(closes[0]).toMatchObject({ persisted: true, applied: true });
    expect(f.sqlite.query("SELECT status,error FROM agent_runs WHERE id = 'target'").get()).toEqual({ status: 'failed',
      error: shapeRunError(replaced ? RUNTIME_RECLAIMED_ERROR : `${RUNTIME_DIED_ERROR} (-1)`, null) });
    const successors = f.sqlite.query("SELECT run_context AS context FROM agent_runs WHERE id != 'target'").all() as { context: string }[];
    expect(successors.length).toBe(replaced ? 1 : 0);
    if (replaced) expect(JSON.parse(successors[0]!.context)).toMatchObject({ replaces: 'target' });
  } finally { finish(-1); await supervisor.stop(); server.stop(true); f.sqlite.close(); rmSync(root, { recursive: true, force: true }); }
});

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
        const args = op === 'state_set' ? { op, key: 'k', value: 'v' } : { op, action: 'container-smoke', summary: 'done' };
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
