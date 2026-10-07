import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { bootstrapOwnership } from '@myco-server-worker/core/ownership.js';
import { sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { wrappingKeyFromText } from '@myco-server-worker/platform/wrapping-key.js';
import { runTimeoutForTask } from '@myco-server-worker/core/task-catalogue.js';
import { BACKUP_FORMAT } from '@myco-server-worker/core/backup.js';

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
    headers: { cookie: await ownerCookie(f.db, Date.now(), sub), origin: 'https://s', 'cf-connecting-ip': '1.2.3.4', 'content-type': 'application/json' },
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
  for (const operation of ['owner bootstrap', 'member revoke'] as const) {
    it(`${operation}: late admin demotion preserves its writer's refusal`, async () => {
      let armed = false;
      let fired = false;
      const f = await setup((sql, sqlite) => {
        const write = operation === 'owner bootstrap' ? /UPDATE deployment_ownership SET member_id/ : /UPDATE members SET revoked_at =/;
        if (!armed || !write.test(sql)) return;
        armed = false;
        fired = true;
        sqlite.run("UPDATE members SET role='member' WHERE id=?", [ADMIN]);
      });
      try {
        if (operation === 'owner bootstrap') f.sqlite.run('UPDATE deployment_ownership SET member_id=NULL, revision=0 WHERE id=1');
        const before = snapshot(f);
        const ownership = f.sqlite.query('SELECT * FROM deployment_ownership').all();
        const audit = f.sqlite.query('SELECT * FROM deployment_ownership_audit').all();
        armed = true;
        const response = await send(f, {
          name: operation, method: 'POST', sql: /unused/,
          path: operation === 'owner bootstrap' ? '/api/ownership' : `/api/members/${MEMBER}/revoke`,
          body: operation === 'owner bootstrap' ? { revision: '0', ownerMemberId: OWNER } : {},
        });
        expect(fired).toBe(true);
        expect(response.status).toBe(409);
        expect(await response.json() as Record<string, unknown>).toEqual({ error: operation === 'owner bootstrap' ? 'revision_conflict' : 'last_admin' });
        expect(snapshot(f)).toEqual(before);
        expect(f.sqlite.query('SELECT * FROM deployment_ownership').all()).toEqual(ownership);
        expect(f.sqlite.query('SELECT * FROM deployment_ownership_audit').all()).toEqual(audit);
        expect(f.sqlite.query('SELECT revoked_at FROM members WHERE id=?').get(MEMBER)).toEqual({ revoked_at: null });
      } finally { f.sqlite.close(); }
    });
  }
  for (const operation of ['stored restore', 'restore upload'] as const) {
    it(`${operation}: late owner revocation preserves the restore refusal`, async () => {
      let armed = false;
      let fired = false;
      const f = await setup((sql, sqlite) => {
        if (!armed || !/INSERT INTO restore_reference_guard/.test(sql)) return;
        armed = false;
        fired = true;
        sqlite.run('UPDATE members SET revoked_at=1 WHERE id=?', [OWNER]);
      });
      try {
        const lineage = (f.sqlite.query("SELECT value FROM schema_meta WHERE key='deployment_id'").get() as { value: string }).value;
        const artifact = [
          { format: BACKUP_FORMAT, deploymentId: lineage, schemaVersion: 74, createdAt: 1, producer: OWNER, counts: { members: 1 } },
          { t: 'members', r: { id: 'mem_restore_refusal', role: 'admin', github_id: '9004', created_at: 1 } },
        ].map(row => JSON.stringify(row)).join('\n');
        if (operation === 'stored restore') {
          const key = 'backups/refusal.jsonl';
          const bytes = new TextEncoder().encode(artifact);
          await f.bucket.put(key, new Response(bytes).body!);
          f.sqlite.run(`INSERT INTO backups (id,key,created_at,size_bytes,counts_json,schema_version,producer) VALUES ('backup_refusal', ?, 1, ?, '{"members":1}', 74, ?)`, [key, bytes.length, OWNER]);
        }
        const before = snapshot(f);
        armed = true;
        const response = await send(f, {
          name: operation, method: 'POST', sql: /unused/,
          path: operation === 'stored restore' ? '/api/backups/backup_refusal/restore' : '/api/backups/restore-upload',
          body: operation === 'stored restore' ? {} : { artifact },
        }, '583231');
        expect(fired).toBe(true);
        expect(response.status).toBe(403);
        expect(await response.json() as Record<string, unknown>).toEqual({ error: 'not_owner' });
        expect(snapshot(f)).toEqual(before);
      } finally { f.sqlite.close(); }
    });
  }
  for (const operation of ['ownership transfer', 'member role'] as const) {
    it(`${operation}: a late owner revocation preserves its writer's refusal`, async () => {
      let armed = false;
      let fired = false;
      const f = await setup((sql, sqlite) => {
        const write = operation === 'ownership transfer' ? /UPDATE deployment_ownership SET member_id/ : /UPDATE members SET role/;
        if (!armed || !write.test(sql)) return;
        armed = false;
        fired = true;
        sqlite.run('UPDATE members SET revoked_at=1 WHERE id=?', [OWNER]);
      });
      try {
        const before = snapshot(f);
        const ownership = f.sqlite.query('SELECT * FROM deployment_ownership').all();
        const audit = f.sqlite.query('SELECT * FROM deployment_ownership_audit').all();
        const roles = f.sqlite.query('SELECT * FROM member_role_audit').all();
        const member = f.sqlite.query('SELECT role, role_revision FROM members WHERE id=?').get(ADMIN);
        const revision = operation === 'ownership transfer'
          ? String((f.sqlite.query('SELECT revision FROM deployment_ownership').get() as { revision: number }).revision)
          : '0';
        armed = true;
        const response = await send(f, {
          method: 'POST', sql: /unused/, name: operation,
          path: operation === 'ownership transfer' ? '/api/ownership/transfer' : `/api/members/${ADMIN}/role`,
          body: { member_id: ADMIN, expected_revision: revision, ...(operation === 'member role' ? { role: 'member' } : {}) },
        }, '583231');
        expect(fired).toBe(true);
        expect(response.status).toBe(409);
        expect(await response.json() as Record<string, unknown>).toEqual({ error: 'revision_conflict' });
        expect(snapshot(f)).toEqual(before);
        expect(f.sqlite.query('SELECT * FROM deployment_ownership').all()).toEqual(ownership);
        expect(f.sqlite.query('SELECT * FROM deployment_ownership_audit').all()).toEqual(audit);
        expect(f.sqlite.query('SELECT * FROM member_role_audit').all()).toEqual(roles);
        expect(f.sqlite.query('SELECT role, role_revision FROM members WHERE id=?').get(ADMIN)).toEqual(member);
      } finally { f.sqlite.close(); }
    });
  }
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

  for (const fault of ['read', 'delete'] as const) {
    it(`backup cleanup ${fault} failure preserves the terminal admin refusal and surfaces cleanup failure`, async () => {
      let armed = false;
      let demoted = false;
      const f = await setup((sql, sqlite) => {
        if (armed && /INSERT INTO backups/.test(sql)) {
          armed = false;
          demoted = true;
          sqlite.run("UPDATE members SET role='member' WHERE id=?", [ADMIN]);
        }
        if (demoted && fault === 'read' && /SELECT 1 FROM backups WHERE key/.test(sql)) throw new Error('fixture cleanup read failure');
      });
      const log = console.log;
      const events: string[] = [];
      try {
        if (fault === 'delete') f.bucket.delete = async () => { throw new Error('fixture cleanup delete failure'); };
        console.log = line => { events.push(String(line)); };
        armed = true;
        const response = await send(f, operations.find(operation => operation.name === 'backup')!);
        expect(demoted).toBe(true);
        expect(response.status).toBe(403);
        expect(await response.json() as Record<string, unknown>).toEqual({ error: 'not_admin', reason: 'this action is for an admin' });
        expect(f.sqlite.query('SELECT * FROM backups').all()).toEqual([]);
        expect(events.map(line => JSON.parse(line) as { kind: string })).toContainEqual(expect.objectContaining({ kind: 'backup_publication_cleanup_failed' }));
      } finally { console.log = log; f.sqlite.close(); }
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
