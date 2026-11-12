import { DEFAULT_DISPATCH_TIMEOUT_SECONDS } from '@myco-server-worker/core/run-deadline.js';
import { indexFixture } from './helpers/vector-index.js';
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { bootstrapOwnership } from '@myco-server-worker/db/identity/ownership.js';
import { sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie, settingsRevisionHeaders } from './helpers/owner.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { wrappingKeyFromText } from '@myco-server-worker/platform/wrapping-key.js';
import { runTimeoutForTask } from '@myco-server-worker/core/task-catalogue.js';
import { BACKUP_FORMAT } from '@myco-server-worker/core/backup.js';
import { changingAt, failingStatement, storingCall } from './helpers/store-faults.js';

const OWNER = 'mem_machine_1';
const ADMIN = 'mem_machine_2';
const MEMBER = 'mem_machine_3';
const TASK = 'title-summary';
const WRAP_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

type Operation = { name: string; method: string; path: string; body?: unknown; seed?: string };
const operations: Operation[] = [
  { name: 'setting', method: 'PUT', path: '/api/settings/agent.scheduled_tasks_enabled', body: { value: true } },
  { name: 'setting reset', method: 'DELETE', path: '/api/settings/agent.scheduled_tasks_enabled', seed: `INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.scheduled_tasks_enabled', 'true', 1, 'seed')` },
  { name: 'task tier', method: 'PATCH', path: '/api/settings/agent.tasks', body: { task: TASK, tier: 'high' } },
  { name: 'task repair', method: 'POST', path: '/api/settings/agent.tasks/repair', body: {}, seed: `INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.tasks', '{"retired-task":{"enabled":true}}', 1, 'seed')` },
  { name: 'capability', method: 'PUT', path: '/api/projects/proj_1/capabilities/cortex', body: { enabled: true } },
  { name: 'titling switch', method: 'PUT', path: '/api/titling-backfill', body: { enabled: true } },
  { name: 'project create', method: 'POST', path: '/api/projects', body: { name: 'new project', projectId: 'proj_new' } },
  { name: 'project rename', method: 'PATCH', path: '/api/projects/proj_1', body: { name: 'new name' } },
  { name: 'project archive', method: 'POST', path: '/api/projects/proj_1/archive', body: {} },
  { name: 'project unarchive', method: 'POST', path: '/api/projects/proj_1/unarchive', body: {}, seed: `UPDATE projects SET archived_at = 1 WHERE project_id = 'proj_1'` },
  { name: 'secret', method: 'PUT', path: '/api/secrets/openai', body: { value: 'fixture-value' } },
  { name: 'backup', method: 'POST', path: '/api/backups', body: {} },
  { name: 'recovery forget', method: 'POST', path: '/api/recovery/exports/forget-unsettled', body: {} },
  { name: 'runtime dispatch', method: 'POST', path: '/api/harness/dispatch', body: { task: 'embedding-reconcile', projectId: 'proj_1', fresh: true, timeoutSeconds: 123 } },
  { name: 'dispatch', method: 'POST', path: '/api/harness/dispatch', body: { task: TASK, projectId: 'proj_1', fresh: true, timeoutSeconds: 123 } },
];

function snapshot(f: ReturnType<typeof sqliteEnv>) {
  return { objects: [...f.bucket.objects.keys()], rows: Object.fromEntries(['deployment_settings', 'deployment_setting_resets', 'project_capabilities', 'projects', 'deployment_secrets', 'agent_runs', 'agents', 'member_credentials', 'members', 'backups', 'recovery_forget_commands']
    .map(table => [table, f.sqlite.query(table === 'members' ? 'SELECT COUNT(*) AS n FROM members' : `SELECT * FROM ${table} ORDER BY rowid`).all()])) };
}

/** A Deployment with an owner, an admin and a member; `owned: false` leaves the owner to be chosen. */
async function setup(owned = true) {
  const f = sqliteEnv({ workerLogin: true });
  f.sqlite.run("UPDATE members SET role = 'admin', github_id = '9002' WHERE id = ?", [ADMIN]);
  f.sqlite.run("UPDATE members SET role = 'member', github_id = '9003' WHERE id = ?", [MEMBER]);
  if (owned) await bootstrapOwnership(f.db, OWNER, OWNER, '0', Date.now());
  turnOnGatedCapabilities(f.sqlite);
  f.sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.reasoning_map.claude-code.default', '"claude-opus-5"', 1, 'seed')`);
  await deploymentSecretStore(f.db, wrappingKeyFromText(async () => WRAP_KEY, 'test')).put('anthropic', 'synthetic-subscription', OWNER, 1);
  return f;
}

async function send(f: ReturnType<typeof sqliteEnv>, operation: Operation, sub = '9002') {
  return worker.fetch(new Request(`https://s${operation.path}`, {
    method: operation.method,
    headers: { cookie: await ownerCookie(f.db, Date.now(), sub), origin: 'https://s', 'cf-connecting-ip': '1.2.3.4', 'content-type': 'application/json', ...await settingsRevisionHeaders(f.db, operation.path, operation.body) },
    ...(operation.body === undefined ? {} : { body: JSON.stringify(operation.body) }),
  }), { ...f.env, ...OWNER_ENV, VECTORIZE: indexFixture(), AI: { run: async () => ({ data: [[1, 0]] }) }, HARNESS_LAUNCH_MODE: 'record', SECRET_WRAP_KEY: { get: async () => WRAP_KEY },
    RECOVERY_BUCKET: f.env.BUCKET,
    RECOVERY: { idFromName: () => 'fixture', get: () => ({ status: async () => ({ unsettledExport: null }), forgetUnsettledExport: async (id: string) => {
      expect(f.sqlite.query('SELECT id FROM recovery_forget_commands WHERE id=?').get(id)).not.toBeNull();
      return { forgotten: null };
    } }) },
  });
}

type Fixture = Awaited<ReturnType<typeof setup>>;

/** Every row these writes touch, in full: what a refused write leaves as it was. */
function stored(f: Fixture) {
  return {
    ...snapshot(f).rows,
    ...Object.fromEntries(['members', 'deployment_ownership', 'deployment_ownership_audit', 'member_role_audit', 'restore_jobs'].map(table => [table, f.sqlite.query(`SELECT * FROM ${table} ORDER BY rowid`).all()])),
  };
}

/**
 * A request sent on a fresh Deployment with `change` landing just before the call that stores its write: the call is
 * found on another fresh Deployment by what the uninterrupted request stores, never by the SQL it sends. `fault` wraps
 * the store under the change, for a second failure after it.
 */
async function raced(options: {
  prepare?: (f: Fixture) => unknown; request: (f: Fixture) => Promise<Response>; change: (f: Fixture) => void;
  fault?: (f: Fixture) => void; owned?: boolean;
}): Promise<{ f: Fixture; response: Response; unchanged: () => void; landed: boolean }> {
  const observed = await setup(options.owned);
  let at = 0;
  try {
    await options.prepare?.(observed);
    at = await storingCall(observed.env.MYCO_DB, async (store) => { observed.env.MYCO_DB = store; await options.request(observed); }, () => stored(observed));
  } finally { observed.sqlite.close(); }
  expect(at).toBeGreaterThan(0);
  const f = await setup(options.owned);
  await options.prepare?.(f);
  const kept = (fixture: Fixture) => {
    const { members, ...rows } = stored(fixture);
    return { rows, members: members.length, objects: snapshot(fixture).objects };
  };
  const before = kept(f);
  options.fault?.(f);
  const landing = changingAt(f.env.MYCO_DB, at, () => options.change(f));
  f.env.MYCO_DB = landing.store;
  return { f, response: await options.request(f), unchanged: () => expect(kept(f)).toEqual(before), landed: landing.landed() };
}

describe('live authority at administrative writes', () => {
  for (const operation of ['owner bootstrap', 'member revoke'] as const) {
    it(`${operation}: late admin demotion preserves its writer's refusal`, async () => {
      const { f, response, unchanged, landed } = await raced({
        owned: operation !== 'owner bootstrap',
        request: f => send(f, {
          name: operation, method: 'POST',
          path: operation === 'owner bootstrap' ? '/api/ownership' : `/api/members/${MEMBER}/revoke`,
          body: operation === 'owner bootstrap' ? { revision: '0', ownerMemberId: OWNER } : {},
        }),
        change: f => f.sqlite.run("UPDATE members SET role='member' WHERE id=?", [ADMIN]),
      });
      try {
        expect(landed).toBe(true);
        expect(response.status).toBe(409);
        expect(await response.json() as Record<string, unknown>).toEqual({ error: operation === 'owner bootstrap' ? 'revision_conflict' : 'last_admin' });
        unchanged();
        expect(f.sqlite.query('SELECT revoked_at FROM members WHERE id=?').get(MEMBER)).toEqual({ revoked_at: null });
      } finally { f.sqlite.close(); }
    });
  }
  for (const operation of ['stored restore', 'restore upload'] as const) {
    it(`${operation}: late owner revocation preserves the restore refusal`, async () => {
      const artifactOf = (f: Fixture) => {
        const lineage = (f.sqlite.query("SELECT value FROM schema_meta WHERE key='deployment_id'").get() as { value: string }).value;
        return [
          { format: BACKUP_FORMAT, deploymentId: lineage, schemaVersion: 74, createdAt: 1, producer: OWNER, counts: { members: 1 } },
          { t: 'members', r: { id: 'mem_restore_refusal', role: 'admin', github_id: '9004', created_at: 1 } },
        ].map(row => JSON.stringify(row)).join('\n');
      };
      const { f, response, unchanged, landed } = await raced({
        prepare: async f => {
          if (operation !== 'stored restore') return;
          const key = 'backups/refusal.jsonl';
          const bytes = new TextEncoder().encode(artifactOf(f));
          await f.bucket.put(key, new Response(bytes).body!);
          f.sqlite.run(`INSERT INTO backups (id,key,created_at,size_bytes,counts_json,schema_version,producer) VALUES ('backup_refusal', ?, 1, ?, '{"members":1}', 74, ?)`, [key, bytes.length, OWNER]);
        },
        request: f => send(f, {
          name: operation, method: 'POST',
          path: operation === 'stored restore' ? '/api/backups/backup_refusal/restore' : '/api/backups/restore-upload',
          body: operation === 'stored restore' ? {} : { artifact: artifactOf(f) },
        }, '583231'),
        change: f => f.sqlite.run('UPDATE members SET revoked_at=1 WHERE id=?', [OWNER]),
      });
      try {
        expect(landed).toBe(true);
        expect(response.status).toBe(403);
        // The job's commit rechecks the requester as an admin; an earlier check refuses the revoked owner as not the owner.
        expect(['not_owner', 'not_admin']).toContain((await response.json() as { error: string }).error);
        unchanged();
      } finally { f.sqlite.close(); }
    });
  }
  for (const operation of ['ownership transfer', 'member role'] as const) {
    it(`${operation}: a late owner revocation preserves its writer's refusal`, async () => {
      const { f, response, unchanged, landed } = await raced({
        request: f => send(f, {
          method: 'POST', name: operation,
          path: operation === 'ownership transfer' ? '/api/ownership/transfer' : `/api/members/${ADMIN}/role`,
          body: {
            member_id: ADMIN, ...(operation === 'member role' ? { role: 'member' } : {}),
            expected_revision: operation === 'ownership transfer' ? String((f.sqlite.query('SELECT revision FROM deployment_ownership').get() as { revision: number }).revision) : '0',
          },
        }, '583231'),
        change: f => f.sqlite.run('UPDATE members SET revoked_at=1 WHERE id=?', [OWNER]),
      });
      try {
        expect(landed).toBe(true);
        expect(response.status).toBe(409);
        expect(await response.json() as Record<string, unknown>).toEqual({ error: 'revision_conflict' });
        unchanged();
        expect(f.sqlite.query('SELECT role FROM members WHERE id=?').get(ADMIN)).toEqual({ role: 'admin' });
      } finally { f.sqlite.close(); }
    });
  }
  for (const operation of operations) {
    for (const change of ['demotion', 'revocation'] as const) {
      it(`${operation.name}: ${change} just before the write refuses without changing state`, async () => {
        const { f, response, unchanged, landed } = await raced({
          prepare: f => { if (operation.seed) f.sqlite.exec(operation.seed); },
          request: f => send(f, operation),
          change: f => f.sqlite.run(change === 'demotion' ? "UPDATE members SET role='member', role_revision=role_revision+1 WHERE id=?" : 'UPDATE members SET revoked_at=1 WHERE id=?', [ADMIN]),
        });
        try {
          expect(landed).toBe(true);
          expect(response.status).toBe(403);
          expect(await response.json() as Record<string, unknown>).toEqual(operation.path === '/api/harness/dispatch'
            ? { error: 'fresh_needs_admin' }
            : { error: 'not_admin', reason: 'this action is for an admin' });
          unchanged();
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
      let readFailures: (() => number) | undefined;
      const log = console.log;
      const events: string[] = [];
      console.log = line => { events.push(String(line)); };
      try {
        const { f, response, landed } = await raced({
          request: f => send(f, operations.find(operation => operation.name === 'backup')!),
          change: f => f.sqlite.run("UPDATE members SET role='member' WHERE id=?", [ADMIN]),
          fault: f => {
            if (fault === 'read') {
              const failing = failingStatement(f.env.MYCO_DB, 'storage.backupObjectRegistered');
              readFailures = failing.failures;
              f.env.MYCO_DB = failing.store;
            } else f.bucket.delete = async () => { throw new Error('fixture cleanup delete failure'); };
          },
        });
        try {
          expect(landed).toBe(true);
          if (fault === 'read') expect(readFailures!()).toBeGreaterThan(0);
          expect(response.status).toBe(403);
          expect(await response.json() as Record<string, unknown>).toEqual({ error: 'not_admin', reason: 'this action is for an admin' });
          expect(f.sqlite.query('SELECT * FROM backups').all()).toEqual([]);
          expect(events.map(line => JSON.parse(line) as { kind: string })).toContainEqual(expect.objectContaining({ kind: 'backup_publication_cleanup_failed' }));
        } finally { f.sqlite.close(); }
      } finally { console.log = log; }
    });
  }

  for (const change of ['demotion', 'revocation'] as const) {
    it(`ordinary dispatch refuses ${change} instead of using cached admin timeout and ceiling`, async () => {
      const { f, response, unchanged, landed } = await raced({
        request: f => send(f, { ...operations.find(value => value.name === 'dispatch')!, body: { task: TASK, projectId: 'proj_1', timeoutSeconds: 123 } }),
        change: f => f.sqlite.run(change === 'demotion' ? "UPDATE members SET role='member' WHERE id=?" : 'UPDATE members SET revoked_at=1 WHERE id=?', [ADMIN]),
      });
      try {
        expect(landed).toBe(true);
        expect(response.status).toBe(403);
        expect(await response.json() as Record<string, unknown>).toEqual({ error: 'not_admin', reason: 'this action is for an admin' });
        unchanged();
      } finally { f.sqlite.close(); }
    });
  }

  for (const role of ['admin', 'member'] as const) {
    it(`a live ${role} dispatches with its rightful timeout and ceiling`, async () => {
      const f = await setup();
      try {
        f.sqlite.run(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.tasks', ?, 1, 'seed')`, [JSON.stringify({ [TASK]: { schedule: { memberRunsPerDay: 1 } } })]);
        const operation = { ...operations.find(value => value.name === 'dispatch')!, body: { task: TASK, projectId: 'proj_1', timeoutSeconds: 123 } };
        const sub = role === 'admin' ? '9002' : '9003';
        const response = await send(f, operation, sub);
        expect(response.status).toBe(200);
        const run = f.sqlite.query('SELECT run_context FROM agent_runs').get() as { run_context: string };
        expect(JSON.parse(run.run_context).timeoutSeconds).toBe(role === 'admin' ? 123 : runTimeoutForTask(TASK) ?? DEFAULT_DISPATCH_TIMEOUT_SECONDS);
        expect((await send(f, operation, sub)).status).toBe(role === 'admin' ? 200 : 429);
      } finally { f.sqlite.close(); }
    });
  }
});
