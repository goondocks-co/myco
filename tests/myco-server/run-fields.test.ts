/**
 * What the run list and a run's detail say about a run beyond its status (`/api/projects/{p}/runs`, `…/runs/{r}`):
 * the machine that ran it by name, who started it, the session its dispatch named, why a skipped run did not run, and
 * on the list, what it came to — the spores it wrote and the sessions it read, counted as the detail's `read` and
 * `produced` count them. Every count is the Project's own. And `author=` on a Project's spores lists what one run wrote.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';

const NOW = Date.now();
const DAY = 86_400_000;

function harness() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  const { sqlite } = fixture;
  seedMemberRoleAccount(sqlite);
  sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1', 'a', 'built-in', 1, 0)`);
  sqlite.run(`INSERT INTO members (id, label, created_at) VALUES ('mem_worker', 'worker', 0)`);
  const credential = (id: string, machine: string, label: string | null, issuedAt: number, opts: { revoked?: boolean; expired?: boolean; member?: string } = {}) =>
    sqlite.run(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, runtime_label, issued_at, expires_at, revoked_at, lineage_root, lineage_started_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`, [id, opts.member ?? 'mem_worker', `h_${id}`, machine, label, issuedAt, opts.expired ? NOW - 1 : NOW + DAY, opts.revoked ? NOW - 1 : null, id]);
  const run = (project: string, id: string, opts: { status?: string; context?: unknown; actor?: string; leasedBy?: string; at?: number } = {}) =>
    sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, queued_at, run_context, dispatch_spec, leased_by)
                VALUES (?, ?, 'agent_1', 'extract-curate', ?, ?, ?, ?, ?, ?)`,
    [project, id, opts.status ?? 'completed', opts.at ?? NOW, opts.at ?? NOW, opts.context === undefined ? null : JSON.stringify(opts.context),
      opts.actor === undefined ? null : JSON.stringify({ actor: opts.actor }), opts.leasedBy ?? null]);
  const session = (project: string, id: string) =>
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, title) VALUES (?, ?, 'm1', 't', 1, 1, ?)`, [project, id, `title ${id}`]);
  const spore = (project: string, id: string, author: string | null, sessionId: string | null) =>
    sqlite.run(`INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, author, session_id, created_at) VALUES (?, ?, 'agent_1', 'gotcha', 'active', 'x', ?, ?, ?)`, [project, id, author, sessionId, NOW]);
  const read = (project: string, runId: string, sessionId: string) =>
    sqlite.run(`INSERT INTO run_reads (project_id, run_id, session_id, token_id, received_at) VALUES (?, ?, ?, 't', ?)`, [project, runId, sessionId, NOW]);
  const get = async (path: string, sub?: string) => {
    const res = await worker.fetch(new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(Date.now(), sub), 'cf-connecting-ip': '1.2.3.4' } }), env);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const listed = async (project = 'proj_1', sub?: string) => {
    const { status, body } = await get(`/api/projects/${project}/runs`, sub);
    expect(status).toBe(200);
    return Object.fromEntries((body.rows as any[]).map((r) => [r.id, r]));
  };
  return { sqlite, credential, run, session, spore, read, get, listed };
}

describe('the fields a run carries beyond its status', () => {
  it('names the machine that ran it to the member it belongs to alone, and shows anyone else that member, on the list and the detail', async () => {
    const h = harness();
    h.sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES ('machine_a', 'mem_worker', 0), ('machine_b', 'mem_worker', 0), ('machine_own', 'mem_machine_1', 0)`);
    h.credential('mt_lease', 'machine_a', 'old-name', NOW - 3 * DAY);
    h.credential('mt_newer', 'machine_a', 'laptop', NOW - DAY);
    h.credential('mt_revoked', 'machine_own', 'revoked-name', NOW, { revoked: true, member: 'mem_machine_1' });
    h.credential('mt_expired', 'machine_own', 'expired-name', NOW, { expired: true, member: 'mem_machine_1' });
    h.credential('mt_own', 'machine_own', 'studio', NOW - DAY, { member: 'mem_machine_1' });
    h.credential('mt_bare', 'machine_b', null, NOW);
    h.run('proj_1', 'run_other', { leasedBy: 'mt_lease' });
    h.run('proj_1', 'run_own', { leasedBy: 'mt_own' });
    h.run('proj_1', 'run_unnamed', { leasedBy: 'mt_bare' });
    h.run('proj_1', 'run_unleased');
    h.sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at) VALUES ('mem_harness', 'harness runtime', 0)`);
    h.credential('mt_harness', 'harness', null, NOW, { member: 'mem_harness' });
    h.run('proj_1', 'run_myco', { leasedBy: 'mt_harness' });
    const rows = await h.listed();
    // Another member's machine: that member, and no name.
    expect(rows.run_other.worker).toEqual({ credentialId: 'mt_lease', machineId: 'machine_a', machineName: null, member: { id: 'mem_worker', label: 'worker' } });
    // The viewer's own machine, named by its newest live credential while its claim holds no name.
    expect(rows.run_own.worker).toEqual({ credentialId: 'mt_own', machineId: 'machine_own', machineName: 'studio', member: { id: 'mem_machine_1', label: 'machine_1' } });
    expect(rows.run_unnamed.worker).toMatchObject({ machineName: null, member: { id: 'mem_worker', label: 'worker' } });
    // A run Myco's own runtime ran names Myco.
    expect(rows.run_myco.worker).toMatchObject({ machineName: null, member: { id: 'mem_harness', label: 'Myco' } });
    expect(rows.run_unleased.worker).toBeNull();
    expect((await h.get('/api/projects/proj_1/runs/run_other')).body.run.worker).toMatchObject({ machineName: null, member: { id: 'mem_worker', label: 'worker' } });
    // The claim's name wins over any credential's.
    h.sqlite.run(`UPDATE machine_claims SET label = 'Studio Mac' WHERE machine_id = 'machine_own'`);
    expect((await h.get('/api/projects/proj_1/runs/run_own')).body.run.worker.machineName).toBe('Studio Mac');
    // Another member reads the viewer's machine as the viewer, never by its name.
    const asMember = await h.listed('proj_1', MEMBER_SUB);
    expect(asMember.run_own.worker).toMatchObject({ machineName: null, member: { id: 'mem_machine_1', label: 'machine_1' } });
    const detail = await h.get('/api/projects/proj_1/runs/run_own', MEMBER_SUB);
    expect(detail.body.run.worker).toMatchObject({ machineName: null, member: { id: 'mem_machine_1', label: 'machine_1' } });
    for (const body of [asMember, detail.body]) expect(JSON.stringify(body)).not.toMatch(/Studio Mac|studio|laptop/);
  });

  it('says who started it, the session its dispatch named, and why a skipped run did not run', async () => {
    const h = harness();
    h.run('proj_1', 'run_title', { context: { session_id: 's_target', mode: 'claim' }, actor: 'mem_machine_2' });
    h.run('proj_1', 'run_skipped', { status: 'skipped', context: { reason: 'max_runs_per_day' } });
    h.run('proj_1', 'run_reason_not_skipped', { context: { reason: 'stray' }, actor: 'clock' });
    h.run('proj_1', 'run_blank_actor', { actor: '' });
    const rows = await h.listed();
    expect(rows.run_title).toMatchObject({ startedBy: 'mem_machine_2', targetSessionId: 's_target', skipReason: null });
    expect(rows.run_skipped).toMatchObject({ startedBy: null, targetSessionId: null, skipReason: 'max_runs_per_day' });
    expect(rows.run_reason_not_skipped).toMatchObject({ startedBy: 'clock', skipReason: null });
    expect(rows.run_blank_actor.startedBy).toBeNull();
    expect((await h.get('/api/projects/proj_1/runs/run_title')).body.run).toMatchObject({ startedBy: 'mem_machine_2', targetSessionId: 's_target' });
  });

  it('counts what a run came to as its detail counts it: recorded reads, or the sessions it worked from', async () => {
    const h = harness();
    for (const s of ['s1', 's2', 's3', 's_gone']) h.session('proj_1', s);
    h.run('proj_1', 'run_read', {});
    h.read('proj_1', 'run_read', 's1');
    h.read('proj_1', 'run_read', 's2');
    h.read('proj_1', 'run_read', 's_gone');
    h.spore('proj_1', 'sp_1', 'run_read', 's1');
    h.run('proj_1', 'run_unrecorded', { context: { session_id: 's3' } });
    h.spore('proj_1', 'sp_2', 'run_unrecorded', 's1');
    h.spore('proj_1', 'sp_3', 'run_unrecorded', 's2');
    h.spore('proj_1', 'sp_4', 'run_unrecorded', 's2');
    h.run('proj_1', 'run_nothing');
    h.sqlite.run(`INSERT INTO session_tombstones (project_id, session_id, created_at, created_by) VALUES ('proj_1', 's_gone', 1, 'mem_machine_1')`);
    const rows = await h.listed();
    expect(rows.run_read.outcome).toEqual({ spores: 1, sessions: 2, readsRecorded: true });
    expect(rows.run_unrecorded.outcome).toEqual({ spores: 3, sessions: 3, readsRecorded: false });
    expect(rows.run_nothing.outcome).toEqual({ spores: 0, sessions: 0, readsRecorded: false });
    for (const id of ['run_read', 'run_unrecorded', 'run_nothing']) {
      const detail = (await h.get(`/api/projects/proj_1/runs/${id}`)).body;
      expect({ id, sessions: detail.read.total, recorded: detail.read.recorded, spores: detail.produced.spores.total })
        .toEqual({ id, sessions: rows[id].outcome.sessions, recorded: rows[id].outcome.readsRecorded, spores: rows[id].outcome.spores });
    }
  });

  it('counts only the Project\'s own: the same run id in another Project adds nothing', async () => {
    const h = harness();
    h.session('proj_1', 's1');
    h.session('proj_2', 's1');
    h.session('proj_2', 's2');
    h.run('proj_1', 'run_x');
    h.run('proj_2', 'run_x', { context: { session_id: 's2' } });
    h.read('proj_2', 'run_x', 's1');
    h.spore('proj_2', 'sp_other', 'run_x', 's1');
    h.spore('proj_1', 'sp_mine', 'run_x', 's1');
    expect((await h.listed('proj_1')).run_x.outcome).toEqual({ spores: 1, sessions: 1, readsRecorded: false });
    expect((await h.listed('proj_2')).run_x.outcome).toEqual({ spores: 1, sessions: 1, readsRecorded: true });
  });

  it('is read by a member who is not an admin', async () => {
    const h = harness();
    h.run('proj_1', 'run_a', { actor: 'clock' });
    expect((await h.listed('proj_1', MEMBER_SUB)).run_a).toMatchObject({ startedBy: 'clock', outcome: { spores: 0, sessions: 0, readsRecorded: false } });
  });
});

describe('the spores one run wrote', () => {
  it('lists and counts a Project\'s spores by author, and nothing of another Project', async () => {
    const h = harness();
    h.spore('proj_1', 'sp_a', 'run_1', null);
    h.spore('proj_1', 'sp_b', 'run_1', null);
    h.spore('proj_1', 'sp_c', 'run_2', null);
    h.spore('proj_2', 'sp_d', 'run_1', null);
    const { status, body } = await h.get('/api/projects/proj_1/spores?author=run_1', MEMBER_SUB);
    expect(status).toBe(200);
    expect({ ids: body.spores.map((s: any) => s.id).sort(), total: body.total }).toEqual({ ids: ['sp_a', 'sp_b'], total: 2 });
    expect((await h.get('/api/projects/proj_1/spores?author=nobody')).body.total).toBe(0);
  });
});
