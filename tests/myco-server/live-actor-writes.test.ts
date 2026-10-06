import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { bootstrapOwnership } from '@myco-server-worker/core/ownership.js';
import { sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { wrappingKeyFromText } from '@myco-server-worker/platform/wrapping-key.js';
import { runTimeoutForTask } from '@myco-server-worker/core/task-catalogue.js';

const OWNER = 'mem_machine_1';
const ADMIN = 'mem_machine_2';
const MEMBER = 'mem_machine_3';
const TASK = 'extract-curate';
const WRAP_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

type Operation = { name: string; method: string; path: string; body?: unknown; sql: RegExp; seed?: string };
const operations: Operation[] = [
  { name: 'setting', method: 'PUT', path: '/api/settings/agent.scheduled_tasks_enabled', body: { value: true }, sql: /INSERT INTO deployment_settings/ },
  { name: 'setting reset', method: 'DELETE', path: '/api/settings/agent.scheduled_tasks_enabled', sql: /DELETE FROM deployment_settings/, seed: `INSERT INTO deployment_settings VALUES ('agent.scheduled_tasks_enabled', 'true', 1, 'seed')` },
  { name: 'task tier', method: 'PATCH', path: '/api/settings/agent.tasks', body: { task: TASK, tier: 'high' }, sql: /INSERT INTO deployment_settings/ },
  { name: 'task repair', method: 'POST', path: '/api/settings/agent.tasks/repair', body: {}, sql: /UPDATE deployment_settings/, seed: `INSERT INTO deployment_settings VALUES ('agent.tasks', '{"retired-task":{"enabled":true}}', 1, 'seed')` },
  { name: 'capability', method: 'PUT', path: '/api/projects/proj_1/capabilities/cortex', body: { enabled: true }, sql: /INSERT INTO project_capabilities/ },
  { name: 'titling switch', method: 'PUT', path: '/api/titling-backfill', body: { enabled: true }, sql: /INSERT INTO deployment_settings/ },
  { name: 'project create', method: 'POST', path: '/api/projects', body: { name: 'new project', projectId: 'proj_new' }, sql: /INSERT.*INTO projects/ },
  { name: 'project rename', method: 'PATCH', path: '/api/projects/proj_1', body: { name: 'new name' }, sql: /UPDATE projects/ },
  { name: 'project archive', method: 'POST', path: '/api/projects/proj_1/archive', body: {}, sql: /UPDATE projects/ },
  { name: 'project unarchive', method: 'POST', path: '/api/projects/proj_1/unarchive', body: {}, sql: /UPDATE projects/, seed: `UPDATE projects SET archived_at = 1 WHERE project_id = 'proj_1'` },
  { name: 'secret', method: 'PUT', path: '/api/secrets/openai', body: { value: 'fixture-value' }, sql: /INSERT INTO deployment_secrets/ },
  { name: 'backup', method: 'POST', path: '/api/backups', body: {}, sql: /INSERT INTO backups/ },
  { name: 'recovery forget', method: 'POST', path: '/api/recovery/exports/forget-unsettled', body: {}, sql: /INSERT INTO recovery_forget_commands/ },
  { name: 'runtime dispatch', method: 'POST', path: '/api/harness/dispatch', body: { task: 'container-smoke', projectId: 'proj_1', fresh: true, timeoutSeconds: 123 }, sql: /INSERT INTO agent_runs/ },
  { name: 'dispatch', method: 'POST', path: '/api/harness/dispatch', body: { task: TASK, projectId: 'proj_1', fresh: true, timeoutSeconds: 123 }, sql: /INSERT INTO agent_runs/ },
];

function snapshot(f: ReturnType<typeof sqliteEnv>) {
  return { objects: [...f.bucket.objects.keys()], rows: Object.fromEntries(['deployment_settings', 'deployment_setting_resets', 'project_capabilities', 'projects', 'deployment_secrets', 'agent_runs', 'agents', 'member_credentials', 'members', 'backups', 'recovery_forget_commands']
    .map(table => [table, f.sqlite.query(table === 'members' ? 'SELECT COUNT(*) AS n FROM members' : `SELECT * FROM ${table} ORDER BY rowid`).all()])) };
}

async function setup(onSql?: (sql: string, sqlite: ReturnType<typeof sqliteEnv>['sqlite']) => void) {
  const f = sqliteEnv({ workerLogin: true, onSql });
  f.sqlite.run("UPDATE members SET role = 'admin', github_id = '9002' WHERE id = ?", [ADMIN]);
  f.sqlite.run("UPDATE members SET role = 'member', github_id = '9003' WHERE id = ?", [MEMBER]);
  await bootstrapOwnership(f.db, OWNER, OWNER, '0', Date.now());
  turnOnGatedCapabilities(f.sqlite);
  f.sqlite.run(`INSERT INTO deployment_settings VALUES ('agent.reasoning_map.claude-code.default', '"claude-opus-5"', 1, 'seed')`);
  await deploymentSecretStore(f.db, wrappingKeyFromText(async () => WRAP_KEY, 'test')).put('anthropic', 'synthetic-subscription', OWNER, 1);
  return f;
}

async function send(f: ReturnType<typeof sqliteEnv>, operation: Operation, sub = '9002') {
  return worker.fetch(new Request(`https://s${operation.path}`, {
    method: operation.method,
    headers: { cookie: await ownerCookie(Date.now(), sub), origin: 'https://s', 'cf-connecting-ip': '1.2.3.4', 'content-type': 'application/json' },
    ...(operation.body === undefined ? {} : { body: JSON.stringify(operation.body) }),
  }), { ...f.env, ...OWNER_ENV, HARNESS_LAUNCH_MODE: 'record', SECRET_WRAP_KEY: { get: async () => WRAP_KEY },
    RECOVERY_BUCKET: f.env.BUCKET,
    RECOVERY: { idFromName: () => 'fixture', get: () => ({ status: async () => ({ unsettledExport: null }), forgetUnsettledExport: async (id: string) => {
      expect(f.sqlite.query('SELECT id FROM recovery_forget_commands WHERE id=?').get(id)).not.toBeNull();
      return { forgotten: null };
    } }) },
  });
}

describe('live authority at administrative writes', () => {
  for (const operation of operations) {
    for (const change of ['demotion', 'revocation'] as const) {
      it(`${operation.name}: ${change} just before the write refuses without changing state`, async () => {
        let armed = false;
        let fired = false;
        const f = await setup((sql, sqlite) => {
          if (!armed || !operation.sql.test(sql)) return;
          armed = false;
          fired = true;
          sqlite.run(change === 'demotion' ? "UPDATE members SET role='member', role_revision=role_revision+1 WHERE id=?" : 'UPDATE members SET revoked_at=1 WHERE id=?', [ADMIN]);
        });
        try {
          if (operation.seed) f.sqlite.exec(operation.seed);
          const before = snapshot(f);
          armed = true;
          const response = await send(f, operation);
          expect(fired).toBe(true);
          expect(response.status).toBe(403);
          expect(await response.json() as Record<string, unknown>).toEqual(operation.path === '/api/harness/dispatch'
            ? { error: 'fresh_needs_admin' }
            : { error: 'not_admin', reason: 'this action is for an admin' });
          expect(snapshot(f)).toEqual(before);
          expect(f.sqlite.query('SELECT role, revoked_at FROM members WHERE id=?').get(ADMIN)).toMatchObject(change === 'demotion' ? { role: 'member' } : { revoked_at: 1 });
        } finally { f.sqlite.close(); }
      });
    }
    it(`${operation.name}: a rightful admin writes and an ordinary member is refused`, async () => {
      const f = await setup();
      try {
        if (operation.seed) f.sqlite.exec(operation.seed);
        const before = snapshot(f);
        const member = await send(f, operation, '9003');
        expect(member.status).toBe(403);
        expect(snapshot(f)).toEqual(before);
        const admin = await send(f, operation);
        expect(admin.status).toBe(operation.name === 'project create' ? 201 : 200);
        expect(snapshot(f)).not.toEqual(before);
      } finally { f.sqlite.close(); }
    });
  }

  for (const change of ['demotion', 'revocation'] as const) {
    it(`ordinary dispatch refuses ${change} instead of using cached admin timeout and ceiling`, async () => {
      let armed = false;
      const f = await setup((sql, sqlite) => {
        if (!armed || !/INSERT INTO agent_runs/.test(sql)) return;
        armed = false;
        sqlite.run(change === 'demotion' ? "UPDATE members SET role='member' WHERE id=?" : 'UPDATE members SET revoked_at=1 WHERE id=?', [ADMIN]);
      });
      try {
        const before = snapshot(f);
        armed = true;
        const response = await send(f, { ...operations.find(value => value.name === 'dispatch')!, body: { task: TASK, projectId: 'proj_1', timeoutSeconds: 123 } });
        expect(armed).toBe(false);
        expect(response.status).toBe(403);
        expect(await response.json() as Record<string, unknown>).toEqual({ error: 'not_admin', reason: 'this action is for an admin' });
        expect(snapshot(f)).toEqual(before);
      } finally { f.sqlite.close(); }
    });
  }

  for (const role of ['admin', 'member'] as const) {
    it(`a live ${role} dispatches with its rightful timeout and ceiling`, async () => {
      const f = await setup();
      try {
        f.sqlite.run(`INSERT INTO deployment_settings VALUES ('agent.tasks', ?, 1, 'seed')`, [JSON.stringify({ [TASK]: { schedule: { memberRunsPerDay: 1 } } })]);
        const operation = { ...operations.find(value => value.name === 'dispatch')!, body: { task: TASK, projectId: 'proj_1', timeoutSeconds: 123 } };
        const sub = role === 'admin' ? '9002' : '9003';
        const response = await send(f, operation, sub);
        expect(response.status).toBe(200);
        const run = f.sqlite.query('SELECT run_context FROM agent_runs').get() as { run_context: string };
        expect(JSON.parse(run.run_context).timeoutSeconds).toBe(role === 'admin' ? 123 : runTimeoutForTask(TASK));
        expect((await send(f, operation, sub)).status).toBe(role === 'admin' ? 200 : 429);
      } finally { f.sqlite.close(); }
    });
  }
});
