import { describe, expect, it } from 'bun:test';
import { cancelRun, RUN_CANCELLED } from '@myco-server-worker/core/runs.js';
import { sqliteEnv } from './helpers/fixtures.js';
import worker from '@myco-server-worker/index.js';
import { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';

const ADMIN = 'mem_machine_1';
const REQUESTER = 'mem_machine_2';
const OTHER = 'mem_machine_3';
const NOW = Date.now();

function rig() {
  const { db, sqlite, env } = sqliteEnv();
  sqlite.run(`UPDATE members SET role = 'member' WHERE id IN (?, ?)`, [REQUESTER, OTHER]);
  sqlite.run(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('agent_cancel', 'Cancel test', 'built-in', 1, ?)`, [NOW]);
  const add = (projectId: string, id: string, actor: string | null, status: string, credential: string | null = null) => {
    sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, dispatch_spec, dispatched_by, started_at)
      VALUES (?, ?, 'agent_cancel', 'title-summary', ?, ?, ?, ?)`, [projectId, id, status, actor === null ? null : JSON.stringify({ actor }), credential, NOW]);
  };
  const row = (id: string) => sqlite.query(`SELECT status, error_code AS errorCode, completed_at AS completedAt FROM agent_runs WHERE id = ?`).get(id);
  return { db, sqlite, env, add, row };
}

describe('cancelRun writer', () => {
  it('lets a member cancel only a live run they requested, and ends it once', async () => {
    const r = rig();
    r.add('proj_1', 'mine', REQUESTER, 'running');
    r.add('proj_1', 'theirs', OTHER, 'queued');
    const scope = { projectId: 'proj_1' };
    expect(await cancelRun(r.db, scope, 'theirs', { memberId: REQUESTER, admin: false }, NOW)).toBeNull();
    expect(r.row('theirs')).toMatchObject({ status: 'queued', errorCode: null });
    expect(await cancelRun(r.db, scope, 'mine', { memberId: REQUESTER, admin: false }, NOW)).toEqual({ displaced: null });
    expect(r.row('mine')).toMatchObject({ status: 'failed', errorCode: RUN_CANCELLED, completedAt: NOW });
    expect(await cancelRun(r.db, scope, 'mine', { memberId: REQUESTER, admin: false }, NOW)).toBeNull();
    expect(await cancelRun(r.db, { projectId: 'proj_2' }, 'theirs', { memberId: OTHER, admin: false }, NOW)).toBeNull();
  });

  it('allows a live administrator to cancel any request, including one without a human requester', async () => {
    const r = rig();
    r.add('proj_1', 'automated', null, 'queued');
    expect(await cancelRun(r.db, { projectId: 'proj_1' }, 'automated', { memberId: ADMIN, admin: true }, NOW)).toEqual({ displaced: null });
    expect(r.row('automated')).toMatchObject({ status: 'failed', errorCode: RUN_CANCELLED });
  });

  it('checks the live actor and admin role in the update, including a forged admin flag', async () => {
    const r = rig();
    r.add('proj_1', 'a', OTHER, 'pending');
    const scope = { projectId: 'proj_1' };
    expect(await cancelRun(r.db, scope, 'a', { memberId: REQUESTER, admin: true }, NOW)).toBeNull();
    r.sqlite.run(`UPDATE members SET revoked_at = ? WHERE id = ?`, [NOW, OTHER]);
    expect(await cancelRun(r.db, scope, 'a', { memberId: OTHER, admin: false }, NOW)).toBeNull();
    expect(r.row('a')).toMatchObject({ status: 'pending', errorCode: null });
  });

  it('leaves terminal runs and another Project unchanged', async () => {
    const r = rig();
    r.add('proj_1', 'completed', REQUESTER, 'completed');
    r.add('proj_2', 'sibling', REQUESTER, 'running');
    expect(await cancelRun(r.db, { projectId: 'proj_1' }, 'completed', { memberId: REQUESTER, admin: false }, NOW)).toBeNull();
    expect(await cancelRun(r.db, { projectId: 'proj_1' }, 'sibling', { memberId: REQUESTER, admin: false }, NOW)).toBeNull();
    expect(r.row('completed')).toMatchObject({ status: 'completed', errorCode: null });
    expect(r.row('sibling')).toMatchObject({ status: 'running', errorCode: null });
  });
});

describe('POST /api/projects/{projectId}/runs/{runId}/cancel', () => {
  it('projects the authorization engine decision for each run and the live actor role', async () => {
    const r = rig();
    seedMemberRoleAccount(r.sqlite);
    r.add('proj_1', 'own', REQUESTER, 'queued');
    r.add('proj_1', 'sibling', OTHER, 'queued');
    r.add('proj_1', 'scheduled', null, 'pending');
    const env = { ...r.env, ...OWNER_ENV };
    const detail = async (runId: string, sub: string) => {
      const response = await worker.fetch(new Request(`https://s/api/projects/proj_1/runs/${runId}`, {
        headers: { cookie: await ownerCookie(r.db, Date.now(), sub), 'cf-connecting-ip': '1.2.3.4' },
      }), env);
      expect(response.status).toBe(200);
      return (await response.json() as { run: { canCancel: boolean; cancelReason: string | null } }).run;
    };
    expect(await detail('own', MEMBER_SUB)).toMatchObject({ canCancel: true, cancelReason: null });
    for (const runId of ['sibling', 'scheduled']) {
      expect(await detail(runId, MEMBER_SUB)).toMatchObject({ canCancel: false,
        cancelReason: 'Only the member who requested this run or an administrator can cancel it.' });
      expect(await detail(runId, '583231')).toMatchObject({ canCancel: true, cancelReason: null });
    }
    r.sqlite.run("UPDATE members SET role = 'member' WHERE id = ?", [ADMIN]);
    expect(await detail('sibling', '583231')).toMatchObject({ canCancel: false });
  });

  it('uses the signed-in member, refusing a sibling request and allowing the requester and admin', async () => {
    const r = rig();
    seedMemberRoleAccount(r.sqlite);
    r.add('proj_1', 'own', REQUESTER, 'queued');
    r.add('proj_1', 'sibling', OTHER, 'queued');
    const env = { ...r.env, ...OWNER_ENV };
    const cancel = async (runId: string, sub: string) => {
      const response = await worker.fetch(new Request(`https://s/api/projects/proj_1/runs/${runId}/cancel`, {
        method: 'POST',
        headers: { cookie: await ownerCookie(r.db, Date.now(), sub), 'cf-connecting-ip': '1.2.3.4', origin: 'https://s' },
      }), env);
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    expect((await cancel('sibling', MEMBER_SUB)).status).toBe(404);
    expect(r.row('sibling')).toMatchObject({ status: 'queued', errorCode: null });
    expect(await cancel('own', MEMBER_SUB)).toEqual({ status: 200, body: { cancelled: true, runId: 'own' } });
    expect(await cancel('sibling', '583231')).toEqual({ status: 200, body: { cancelled: true, runId: 'sibling' } });
  });
});
