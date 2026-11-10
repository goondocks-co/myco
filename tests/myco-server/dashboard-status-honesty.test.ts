import { jsonBody } from '../helpers/json-body.js';
import { recordProvisionedHarnessReport } from '@myco-server-worker/core/harness-health.js';
import { describe, expect, it } from 'bun:test';
import { handleStatus } from '@myco-server-worker/api/status.js';
import { handleTaskDescriptions } from '@myco-server-worker/api/task-descriptions.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import type { OwnerContext } from '@myco-server-worker/context.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { sqliteEnv } from './helpers/fixtures';
import { PRINCIPAL, MEMBER_PRINCIPAL } from './helpers/owner';
import type { StatusResponse } from '../../packages/myco-server/ui/src/lib/api';
import type { TaskDescription } from '@myco-server-worker/read/task-descriptions.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { deploymentIdentity } from '@myco-server-worker/auth/authorization.js';
import { counting, failingAt } from './helpers/store-faults.js';

const context = (aud: string, role: 'admin' | 'member' = 'admin'): OwnerContext => ({
  source: '127.0.0.1',
  member: role === 'admin' ? PRINCIPAL : MEMBER_PRINCIPAL,
  now: Date.now(), url: new URL('https://s/api/status'), params: {},
  request: new Request('https://s/api/status'),
  session: { aud, sub: 'test', login: 'test', iat: 0, exp: Number.MAX_SAFE_INTEGER },
  config: { clientId: 'fixture', clientSecret: 'fixture', sessionSecret: 'fixture' },
});

describe('dashboard status and scope honesty on both store adapters', () => {
  for (const target of ['native', 'hosted-contract'] as const) {
    it(`finding 6: ${target} keeps every fact a failed read does not name, wherever one read fails`, async () => {
      const f = sqliteEnv();
      try {
        const inner = target === 'native' ? sqliteRelationalStore(f.sqlite) : f.db;
        const aud = await deploymentIdentity(f.db);
        const read = async (db: RelationalStore) => jsonBody<StatusResponse>(await handleStatus({ ...f.serverEnv, db }, context(aud)));
        const healthy = await read(inner);
        expect(healthy.unavailable).toEqual([]);
        const counter = counting(inner);
        await read(counter.store);
        expect(counter.calls()).toBeGreaterThan(4);
        const named = new Set<string>();
        for (let at = 1; at <= counter.calls(); at++) {
          const body = await read(failingAt(inner, at, 'before').store);
          const unavailable = body.unavailable ?? [];
          for (const fact of unavailable) named.add(fact);
          const kept = (fact: string) => !unavailable.includes(fact);
          if (kept('schema')) expect({ at, schema: body.schema }).toEqual({ at, schema: { expected: SERVER_SCHEMA_VERSION, found: SERVER_SCHEMA_VERSION, matches: true } });
          if (kept('projects')) expect({ at, projects: body.projects }).toEqual({ at, projects: healthy.projects });
          if (kept('transcriptBacklog')) expect({ at, backlog: body.transcriptBacklog }).toEqual({ at, backlog: healthy.transcriptBacklog });
          if (kept('workers')) expect({ at, workers: body.workers.available }).toEqual({ at, workers: true });
          if (kept('capture')) expect({ at, capture: body.capture }).toEqual({ at, capture: healthy.capture });
        }
        expect([...named]).toEqual(expect.arrayContaining(['schema', 'transcriptBacklog', 'projects', 'workers', 'capture']));
      } finally { f.sqlite.close(); }
    });
    it(`finding 7: ${target} member all-project read evaluates mixed switches and excludes archived projects`, async () => {
      const f = sqliteEnv();
      try {
        const db = target === 'native' ? sqliteRelationalStore(f.sqlite) : f.db;
        f.sqlite.run(`INSERT INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'canopy', 0, 0, 'test'), ('proj_2', 'canopy', 1, 0, 'test')`);
        const read = async () => {
          const ctx = context(await deploymentIdentity(f.db), 'member'); ctx.url = new URL('https://s/api/tasks');
          const response = await handleTaskDescriptions({ ...f.serverEnv, db }, ctx);
          expect(response.status).toBe(200);
          const data = await response.json() as { tasks: TaskDescription[] };
          const map = data.tasks.find((task) => task.task === 'canopy-map');
          if (map === undefined) throw new Error('Missing code map description');
          return map;
        };
        expect((await read()).availabilityNote).toBe('Switched off for 1 of 2 selected projects');
        f.sqlite.run(`UPDATE projects SET archived_at = 1 WHERE project_id = 'proj_1'`);
        expect((await read()).availabilityNote).toBeNull();
      } finally { f.sqlite.close(); }
    });
    it(`finding 6: ${target} never widens a member's machine scope, wherever one read fails`, async () => {
      const f = sqliteEnv();
      try {
        const inner = target === 'native' ? sqliteRelationalStore(f.sqlite) : f.db;
        const aud = await deploymentIdentity(f.db);
        const read = async (db: RelationalStore) => jsonBody<StatusResponse>(await handleStatus({ ...f.serverEnv, db }, context(aud, 'member')));
        const healthy = await read(inner);
        const counter = counting(inner);
        await read(counter.store);
        let ownershipFailed = false;
        for (let at = 1; at <= counter.calls(); at++) {
          const body = await read(failingAt(inner, at, 'before').store);
          const unavailable = body.unavailable ?? [];
          expect({ at, schema: body.schema.matches }).toEqual({ at, schema: !unavailable.includes('schema') });
          expect({ at, capture: body.capture, harnesses: body.harnesses }).toEqual({
            at, capture: unavailable.includes('capture') ? [] : healthy.capture, harnesses: unavailable.includes('installedAgents') ? [] : healthy.harnesses,
          });
          if (!unavailable.includes('machines')) continue;
          // Without the member's own machines, nothing scoped to them can be shown.
          ownershipFailed = true;
          expect({ at, unavailable }).toEqual({ at, unavailable: expect.arrayContaining(['machines', 'workers', 'capture', 'installedAgents']) });
          expect({ at, available: body.workers.available, fleet: body.workers.fleet }).toEqual({ at, available: false, fleet: null });
        }
        expect(ownershipFailed).toBe(true);
      } finally { f.sqlite.close(); }
    });
    it(`${target} reveals held tools' address only to the machine owner, including admin views`, async () => {
      const f = sqliteEnv();
      try {
        const db = target === 'native' ? sqliteRelationalStore(f.sqlite) : f.db;
        const aud = await deploymentIdentity(f.db);
        const owner = context(aud, 'member');
        const admin = context(aud);
        f.sqlite.run("INSERT INTO machine_claims (machine_id, member_id, claimed_at, label) VALUES ('held-machine', ?, ?, 'Personal laptop')", [owner.member.id, owner.now]);
        await recordProvisionedHarnessReport(db, 'held-machine', { harnesses: [{ id: 'claude-code', provisioned: true, state: 'held_elsewhere', toolsDeployment: 'https://personal.example' }] }, owner.now);
        const read = async (ctx: OwnerContext) => (await handleStatus({ ...f.serverEnv, db }, ctx)).json() as Promise<StatusResponse>;
        const own = await read(owner);
        expect(own.harnesses).toContainEqual(expect.objectContaining({ machineId: 'held-machine', toolsDeployment: 'https://personal.example' }));
        const other = await read(admin);
        expect(other.harnesses).toContainEqual(expect.objectContaining({ machineId: 'held-machine', state: 'held_elsewhere' }));
        expect(other.harnesses?.find(row => row.machineId === 'held-machine')?.toolsDeployment).toBeUndefined();
        expect(JSON.stringify(other)).not.toContain('personal.example');
        const counter = counting(db);
        await handleStatus({ ...f.serverEnv, db: counter.store }, admin);
        for (let at = 1; at <= counter.calls(); at++) {
          const unread = await (await handleStatus({ ...f.serverEnv, db: failingAt(db, at, 'before').store }, admin)).json() as StatusResponse;
          expect({ at, revealed: JSON.stringify(unread).includes('personal.example') }).toEqual({ at, revealed: false });
        }
      } finally { f.sqlite.close(); }
    });
    it(`finding 9: ${target} returns the final receipt timestamp of an ended session`, async () => {
      const f = sqliteEnv();
      try {
        const db = target === 'native' ? sqliteRelationalStore(f.sqlite) : f.db;
        const ctx = context(await deploymentIdentity(f.db));
        const receivedAt = ctx.now - 14 * 60_000;
        f.sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES ('ended-machine', ?, ?)`, [ctx.member.id, receivedAt]);
        f.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, ended_at, agent)
          VALUES ('proj_1', 'ended-session', 'ended-machine', 'tok', ?, ?, ?, 'codex')`, [receivedAt, receivedAt, receivedAt]);
        const body = await (await handleStatus({ ...f.serverEnv, db }, ctx)).json() as StatusResponse;
        expect(body.capture?.find((row) => row.machineId === 'ended-machine')).toMatchObject({ lastEventAt: receivedAt, agent: 'codex', projectId: 'proj_1' });
        expect(body.unavailable).not.toContain('capture');
      } finally { f.sqlite.close(); }
    });
  }
});

it('reports readable storage and identifies worker and learning query failures without exposing their text', async () => {
  const f = sqliteEnv();
  try {
    const aud = await deploymentIdentity(f.db);
    const db: RelationalStore = { ...f.db, prepare: query => {
      if (query.includes('FROM deployment_settings')) throw new Error('D1_ERROR: no such table: private-settings-detail');
      return f.db.prepare(query);
    } };
    const body = await jsonBody<StatusResponse & { readFailures: Record<string, { read_failure: string }> }>(await handleStatus({ ...f.serverEnv, db }, context(aud)));
    expect(body.database).toEqual({ readable: true });
    expect(body.schema.matches).toBe(true);
    expect(body.unavailable).toEqual(expect.arrayContaining(['workers', 'learning']));
    expect(body.readFailures.workers).toMatchObject({ read_failure: 'query_invalid' });
    expect(body.readFailures.learning).toMatchObject({ read_failure: 'query_invalid' });
    expect(body.workers.available).toBe(false);
    expect(body.learning).toBeNull();
    expect(JSON.stringify(body)).not.toContain('private-settings-detail');
  } finally { f.sqlite.close(); }
});
