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
    for (const [fact, sql] of [
      ['schema', /FROM schema_meta/],
      ['transcriptBacklog', /FROM transcripts WHERE/],
      ['projects', /FROM projects p/],
      ['workers', /worker_contacts w/],
      ['capture', /MAX\(last_received_at\)/],
    ] as const) {
      it(`finding 6: ${target} preserves independent facts when ${fact} fails`, async () => {
        const f = sqliteEnv();
        try {
          const inner = target === 'native' ? sqliteRelationalStore(f.sqlite) : f.db;
          const healthy = await (await handleStatus({ ...f.serverEnv, db: inner }, context(await deploymentIdentity(f.db)))).json() as StatusResponse;
          let injected = false;
          const db: RelationalStore = { ...inner, prepare: (query) => {
            if (sql.test(query)) { injected = true; throw new Error('fixture subread failure'); }
            return inner.prepare(query);
          } };
          const body = await (await handleStatus({ ...f.serverEnv, db }, context(await deploymentIdentity(f.db)))).json() as StatusResponse;
          expect(injected).toBe(true);
          expect(body.unavailable).toContain(fact);
          if (fact !== 'schema') expect(body.schema).toEqual({ expected: SERVER_SCHEMA_VERSION, found: SERVER_SCHEMA_VERSION, matches: true });
          if (fact !== 'projects') expect(body.projects).toEqual(healthy.projects);
          if (fact !== 'transcriptBacklog') expect(body.transcriptBacklog).toEqual(healthy.transcriptBacklog);
          if (fact !== 'workers') expect(body.workers.available).toBe(true);
        } finally { f.sqlite.close(); }
      });
    }
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
    it(`finding 6: ${target} preserves facts without widening a member's unread machine scope`, async () => {
      const f = sqliteEnv();
      try {
        const inner = target === 'native' ? sqliteRelationalStore(f.sqlite) : f.db;
        const db: RelationalStore = { ...inner, prepare: (query) => {
          if (/SELECT machine_id FROM machine_claims WHERE member_id/.test(query)) throw new Error('fixture ownership failure');
          return inner.prepare(query);
        } };
        const body = await (await handleStatus({ ...f.serverEnv, db }, context(await deploymentIdentity(f.db), 'member'))).json() as StatusResponse;
        expect(body.unavailable).toEqual(expect.arrayContaining(['machines', 'workers', 'capture']));
        expect(body.schema.matches).toBe(true);
        expect(body.workers.available).toBe(false);
        expect(body.workers.fleet).toEqual([]);
        expect(body.capture).toEqual([]);
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
