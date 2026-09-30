/**
 * Capture recency on `/api/status`: when each machine's agents last sent anything, across every Project.
 *
 * One row per machine and agent, its latest receipt and the Project that receipt landed in, over the last thirty
 * days, most recent first. A machine is named to the member it belongs to alone, by its claim's label or else the label
 * its newest live credential carries; anyone else is shown the member. A member who is not an admin reads their own
 * machines' capture; an admin reads every machine's.
 */
import { describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { seedCredential } from './helpers/d1.js';
import { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';
import worker from '@myco-server-worker/index.js';
import { CAPTURE_WINDOW_MS } from '@myco-server-worker/read/capture.js';

/** The member-role account the tests act as, as the capture rows name it. */
const LAPTOP_MEMBER = { id: 'mem_machine_2', label: 'machine_2' };

describe('capture recency', () => {
  it('answers the latest receipt per machine and agent over the window, with its Project and the machine\'s name, a member their own machines alone', async () => {
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
    session('proj_1', 's6', 'admin-box', 'codex', now - 5_000);
    sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES ('laptop', 'mem_machine_2', 0), ('desktop', 'mem_machine_2', 0), ('admin-box', 'mem_machine_1', 0)`);
    seedCredential(sqlite, { id: 'mt_old', machineId: 'laptop', memberId: 'mem_machine_2', issuedAt: 1, expiresAt: now + 60_000 });
    seedCredential(sqlite, { id: 'mt_new', machineId: 'laptop', memberId: 'mem_machine_2', issuedAt: 2, expiresAt: now + 60_000 });
    seedCredential(sqlite, { id: 'mt_gone', machineId: 'desktop', memberId: 'mem_machine_2', issuedAt: 3, expiresAt: now + 60_000, revokedAt: 4 });
    seedCredential(sqlite, { id: 'mt_lapsed', machineId: 'desktop', memberId: 'mem_machine_2', issuedAt: 5, expiresAt: now - 1 });
    sqlite.run(`UPDATE member_credentials SET runtime_label = CASE id WHEN 'mt_old' THEN 'old-name' WHEN 'mt_new' THEN 'studio' ELSE 'gone' END`);
    // A session no machine is recorded for names no machine to report.
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent) VALUES ('proj_1', 's_nomachine', NULL, 'tok_1', ?, ?, 'codex')`, [now, now]);

    const res = await worker.fetch(new Request('https://s/api/status', { headers: { cookie: await ownerCookie(Date.now(), MEMBER_SUB), 'cf-connecting-ip': '1.2.3.4' } }), env);
    expect(res.status).toBe(200);
    const body = await res.json() as { capture: unknown[] };
    expect(body.capture).toEqual([
      { machineId: 'laptop', machineName: 'studio', member: LAPTOP_MEMBER, agent: 'claude-code', lastEventAt: now - 10_000, projectId: 'proj_2' },
      { machineId: 'laptop', machineName: 'studio', member: LAPTOP_MEMBER, agent: 'codex', lastEventAt: now - 3_600_000, projectId: 'proj_1' },
      { machineId: 'desktop', machineName: null, member: LAPTOP_MEMBER, agent: 'cursor', lastEventAt: now - 7_200_000, projectId: 'proj_2' },
    ]);
    // The admin reads every machine's capture, another member's included, named only where the machine is the admin's.
    sqlite.run(`UPDATE machine_claims SET label = 'Admin box' WHERE machine_id = 'admin-box'`);
    const all = await worker.fetch(new Request('https://s/api/status', { headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4' } }), env);
    const seen = ((await all.json()) as { capture: Array<{ machineId: string; machineName: string | null; member: unknown }> }).capture;
    expect(seen.map((row) => [row.machineId, row.machineName, row.member])).toEqual([
      ['admin-box', 'Admin box', { id: 'mem_machine_1', label: 'machine_1' }],
      ['laptop', null, LAPTOP_MEMBER], ['laptop', null, LAPTOP_MEMBER], ['desktop', null, LAPTOP_MEMBER],
    ]);
    expect(JSON.stringify(seen)).not.toContain('studio');
  });

  it('keeps every other status fact when capture recency cannot be read, and names it as unavailable', async () => {
    const fixture = sqliteEnv();
    const inner = fixture.env.MYCO_DB;
    const env = { ...fixture.env, ...OWNER_ENV, MYCO_DB: { ...inner, prepare: (sql: string) => { if (/MAX\(last_received_at\)/.test(sql)) throw new Error('unreadable'); return inner.prepare(sql); }, batch: inner.batch.bind(inner) } };
    const res = await worker.fetch(new Request('https://s/api/status', { headers: { cookie: await ownerCookie(), 'cf-connecting-ip': '1.2.3.4' } }), env);
    const body = await res.json() as { schema: { matches: boolean }; projects: unknown[]; workers: { available: boolean }; capture: unknown[]; unavailable: string[] };
    expect({ status: res.status, matches: body.schema.matches, projects: body.projects.length, workers: body.workers.available, capture: body.capture, unavailable: body.unavailable })
      .toEqual({ status: 200, matches: true, projects: 2, workers: true, capture: [], unavailable: ['capture'] });
  });
});
