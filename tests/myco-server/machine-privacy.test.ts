/**
 * A machine's name is its member's alone.
 *
 * Every read that carries a machine to a viewer names the viewer's own machines and shows anyone else's as the member
 * it belongs to, the admin included: sessions, runs, Today's capture and Myco's work. Only the admin pages that manage
 * machines (`/api/machines`, the credentials behind People & machines) read every name.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';

const ADA = '583231';
const ADA_NAMES = ['Ada’s studio Mac', 'ada-host'];
const LIN_NAMES = ['Lin’s build box', 'lin-host'];

/** Ada (the admin) and Lin (a member), each with a named machine, a session from it, and Ada's worker running a run. */
function rig() {
  const fixture = sqliteEnv();
  const env = { ...fixture.env, ...OWNER_ENV };
  const { sqlite } = fixture;
  seedMemberRoleAccount(sqlite);
  const now = Date.now();
  sqlite.run(`UPDATE members SET label = 'Ada' WHERE id = 'mem_machine_1'`);
  sqlite.run(`UPDATE members SET label = 'Lin' WHERE id = 'mem_machine_2'`);
  sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at, label) VALUES ('ada_box', 'mem_machine_1', 0, 'Ada’s studio Mac'), ('lin_box', 'mem_machine_2', 0, 'Lin’s build box')`);
  for (const [id, member, machine, label] of [['mt_ada', 'mem_machine_1', 'ada_box', 'ada-host'], ['mt_lin', 'mem_machine_2', 'lin_box', 'lin-host']] as const) {
    sqlite.run(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, runtime_label, runtime_kind, issued_at, expires_at, lineage_root, lineage_started_at)
                VALUES (?, ?, ?, ?, ?, 'persistent', ?, ?, ?, ?)`, [id, member, `h_${id}`, machine, label, now - 1000, now + 86_400_000, id, now - 1000]);
  }
  for (const [id, machine, token] of [['s_ada', 'ada_box', 'mt_ada'], ['s_lin', 'lin_box', 'mt_lin']] as const) {
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, started_at)
                VALUES ('proj_1', ?, ?, ?, ?, ?, 'claude-code', ?)`, [id, machine, token, now - 5000, now - 5000, now - 5000]);
  }
  sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1', 'a', 'built-in', 1, 0)`);
  sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, queued_at, leased_by)
              VALUES ('proj_1', 'run_ada', 'agent_1', 'extract-curate', 'completed', ?, ?, ?, 'mt_ada')`, [now - 4000, now - 3000, now - 4000]);
  sqlite.run(`INSERT INTO worker_contacts (credential_id, machine_id, offers, last_seen_at, updated_at) VALUES ('mt_ada', 'ada_box', '[]', ?, ?)`, [now - 1000, now - 1000]);
  const get = async (sub: string, path: string): Promise<{ status: number; body: any; text: string }> => {
    const res = await worker.fetch(new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(Date.now(), sub), 'cf-connecting-ip': '1.2.3.4' } }), env);
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text), text };
  };
  return { get };
}

const names = (text: string, of: readonly string[]): string[] => of.filter((name) => text.includes(name));
const row = (rows: any[], key: string, id: string): any => rows.find((r) => r[key] === id);

describe('a machine named only to its member', () => {
  it('shows another member\'s sessions as that member, on the lists and the detail, and the viewer\'s own by machine', async () => {
    const { get } = rig();
    for (const [viewer, own, other, otherLabel, ownName, hidden] of [
      [MEMBER_SUB, 's_lin', 's_ada', 'Ada', 'Lin’s build box', ADA_NAMES], [ADA, 's_ada', 's_lin', 'Lin', 'Ada’s studio Mac', LIN_NAMES],
    ] as const) {
      for (const path of ['/api/sessions', '/api/projects/proj_1/sessions']) {
        const { status, body, text } = await get(viewer, path);
        expect(status).toBe(200);
        expect(row(body.rows, 'sessionId', other)).toMatchObject({ memberLabel: otherLabel, runtimeLabel: null });
        expect(row(body.rows, 'sessionId', own).runtimeLabel).toBe(ownName);
        expect({ path, viewer, names: names(text, hidden) }).toEqual({ path, viewer, names: [] });
      }
      const detail = await get(viewer, `/api/projects/proj_1/sessions/${other}`);
      expect(detail.body.session).toMatchObject({ memberLabel: otherLabel, runtimeLabel: null });
      expect(names(detail.text, hidden)).toEqual([]);
      expect((await get(viewer, `/api/projects/proj_1/sessions/${own}`)).body.session.runtimeLabel).toBe(ownName);
    }
  });

  it('shows a run another member\'s machine ran as that member, on the list and the detail, to members and admins alike', async () => {
    const { get } = rig();
    for (const path of ['/api/projects/proj_1/runs', '/api/projects/proj_1/runs/run_ada']) {
      const lin = await get(MEMBER_SUB, path);
      const worker = path.endsWith('run_ada') ? lin.body.run.worker : row(lin.body.rows, 'id', 'run_ada').worker;
      expect(worker).toMatchObject({ machineName: null, member: { id: 'mem_machine_1', label: 'Ada' } });
      expect(names(lin.text, ADA_NAMES)).toEqual([]);
      const ada = await get(ADA, path);
      const own = path.endsWith('run_ada') ? ada.body.run.worker : row(ada.body.rows, 'id', 'run_ada').worker;
      expect(own).toMatchObject({ machineName: 'Ada’s studio Mac', member: { id: 'mem_machine_1', label: 'Ada' } });
    }
  });

  it('carries no other member\'s machine name on Today\'s capture or Myco\'s work', async () => {
    const { get } = rig();
    for (const [viewer, hidden] of [[MEMBER_SUB, ADA_NAMES], [ADA, LIN_NAMES]] as const) {
      for (const path of ['/api/status', '/api/work']) {
        const { status, text } = await get(viewer, path);
        expect(status).toBe(200);
        expect({ viewer, path, names: names(text, hidden) }).toEqual({ viewer, path, names: [] });
      }
    }
    // The admin's Today shows Lin's capture as Lin.
    const status = await get(ADA, '/api/status');
    expect(row(status.body.capture, 'machineId', 'lin_box')).toMatchObject({ machineName: null, member: { id: 'mem_machine_2', label: 'Lin' } });
    expect(row(status.body.capture, 'machineId', 'ada_box')).toMatchObject({ machineName: 'Ada’s studio Mac' });
  });

  it('names every machine on the admin pages that manage them, and a member\'s own alone to that member', async () => {
    const { get } = rig();
    for (const path of ['/api/machines', '/api/credentials']) {
      expect(names((await get(ADA, path)).text, [...ADA_NAMES.slice(0, 1), ...LIN_NAMES.slice(0, 1)])).toEqual(['Ada’s studio Mac', 'Lin’s build box']);
      const lin = await get(MEMBER_SUB, path);
      expect({ path, names: names(lin.text, ADA_NAMES) }).toEqual({ path, names: [] });
      expect(names(lin.text, LIN_NAMES.slice(0, 1))).toEqual(['Lin’s build box']);
    }
  });
});
