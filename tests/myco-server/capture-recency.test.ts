/**
 * Capture recency on `/api/status`: when each machine's agents last sent anything, across every Project.
 *
 * One row per machine and agent, its latest receipt and the Project that receipt landed in, over the last thirty
 * days, most recent first. A machine is named by the label its newest live credential carries. A member who is not an
 * admin reads it.
 */
import { describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { seedCredential } from './helpers/d1.js';
import { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';
import worker from '@myco-server-worker/index.js';
import { CAPTURE_WINDOW_MS } from '@myco-server-worker/read/capture.js';

describe('capture recency', () => {
  it('answers the latest receipt per machine and agent over the window, with its Project and the machine\'s name, to a member', async () => {
    const now = Date.now();
    const fixture = sqliteEnv();
    const env = { ...fixture.env, ...OWNER_ENV };
    const { sqlite } = fixture;
    seedMemberRoleAccount(sqlite);
    const session = (project: string, id: string, machine: string, agent: string | null, at: number) =>
      sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent)
                  VALUES (?, ?, ?, 'tok_1', ?, ?, ?)`, [project, id, machine, at - 1000, at, agent]);
    session('proj_1', 's1', 'laptop', 'claude-code', now - 60_000);
    session('proj_2', 's2', 'laptop', 'claude-code', now - 10_000);
    session('proj_1', 's3', 'laptop', 'codex', now - 3_600_000);
    session('proj_2', 's4', 'desktop', 'cursor', now - 7_200_000);
    session('proj_1', 's5', 'desktop', 'pi', now - CAPTURE_WINDOW_MS - 1);
    seedCredential(sqlite, { id: 'mt_old', machineId: 'laptop', memberId: 'mem_machine_2', issuedAt: 1, expiresAt: now + 60_000 });
    seedCredential(sqlite, { id: 'mt_new', machineId: 'laptop', memberId: 'mem_machine_2', issuedAt: 2, expiresAt: now + 60_000 });
    seedCredential(sqlite, { id: 'mt_gone', machineId: 'desktop', memberId: 'mem_machine_2', issuedAt: 3, expiresAt: now + 60_000, revokedAt: 4 });
    sqlite.run(`UPDATE member_credentials SET runtime_label = CASE id WHEN 'mt_old' THEN 'old-name' WHEN 'mt_new' THEN 'studio' ELSE 'gone' END`);

    const res = await worker.fetch(new Request('https://s/api/status', { headers: { cookie: await ownerCookie(Date.now(), MEMBER_SUB), 'cf-connecting-ip': '1.2.3.4' } }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { capture: unknown[] };
    expect(body.capture).toEqual([
      { machineId: 'laptop', machineName: 'studio', agent: 'claude-code', lastEventAt: now - 10_000, projectId: 'proj_2' },
      { machineId: 'laptop', machineName: 'studio', agent: 'codex', lastEventAt: now - 3_600_000, projectId: 'proj_1' },
      { machineId: 'desktop', machineName: null, agent: 'cursor', lastEventAt: now - 7_200_000, projectId: 'proj_2' },
    ]);
  });
});
