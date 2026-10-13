import { afterEach, describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { seedCredential } from './helpers/d1.js';
import { MEMBER_SUB, OWNER_ENV, ownerCookie, seedMemberRoleAccount } from './helpers/owner.js';
import { readSetupProgress } from '@myco-server-worker/read/setup.js';
import worker from '@myco-server-worker/index.js';
import { seedMisleadingHistory } from '../setup/fixtures/misleading-history.js';

const NOW = 1_790_000_000_000;
const DAY = 86_400_000;
const fixtures: ReturnType<typeof sqliteEnv>[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.sqlite.close(); });
function rig() {
  const f = sqliteEnv(); fixtures.push(f);
  const sql = (text: string, ...args: (string | number | null)[]) => f.sqlite.run(text, args);
  const read = (memberId?: string) => readSetupProgress(f.serverEnv,
    memberId ? { all: false, memberId } : { all: true }, NOW);
  const claim = (machine = 'machine_1', member = 'mem_machine_1') => {
    sql('INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES (?,?,?)', machine, member, NOW - DAY);
    sql('INSERT INTO machine_harness_reports(machine_id,harnesses,reported_at) VALUES (?,?,?)', machine, JSON.stringify([{ id: 'claude-code', provisioned: true, state: 'ready', sinceAt: 0 }]), NOW);
    seedCredential(f.sqlite, { id: `mt_${machine}`, machineId: machine, memberId: member, expiresAt: NOW + DAY });
  };
  const capture = (machine = 'machine_1', project = 'proj_1', live: number | null = NOW) => {
    sql(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,last_live_received_at,agent)
      VALUES (?,?,?,?,?,?,?,'claude-code')`, project, `session_${machine}_${project}`, machine, `mt_${machine}`, NOW, NOW, live);
  };
  const runner = () => {
    sql("INSERT INTO runners(id,name,created_at) VALUES ('rn_setup','Secret runner label',?)", NOW);
    sql(`INSERT INTO runner_credentials(id,runner_id,token_hash,epoch,issued_at,expires_at,lineage_root)
      VALUES ('rc_setup','rn_setup','secret-hash',1,?,?,'rc_setup')`, NOW, NOW + DAY);
    sql(`INSERT INTO runner_contacts(runner_id,machine_id,offers,last_seen_at,updated_at)
      VALUES ('rn_setup','secret-machine',?, ?, ?)`, JSON.stringify([{ id: 'claude-code', authenticated: true }]), NOW, NOW);
  };
  const output = (at = NOW, status = 'completed', dryRun = 0) => {
    sql("INSERT INTO agents(id,name,source,enabled,created_at) VALUES ('agent_setup','a','built-in',1,?)", NOW);
    sql(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,completed_at,dry_run)
      VALUES ('proj_1','run_setup','agent_setup','extract-curate',?,?,?,?)`, status, at, at + 1, dryRun);
    sql(`INSERT INTO spores(project_id,id,agent_id,observation_type,status,content,author,created_at)
      VALUES ('proj_1','sp_setup','agent_setup','gotcha','active','private output','run_setup',?)`, at);
  };
  return { f, sql, read, claim, capture, runner, output };
}

describe('observed setup progress', () => {
  it('rejects the seeded imported session, old contact and empty completed work', async () => {
    const { f, read } = rig();
    await seedMisleadingHistory(f.db, NOW);
    expect(await read()).toMatchObject({ machines: { signedIn: 0 }, liveCapture: false, runnersReady: 0, workProduced: false });
    expect(await read('mem_machine_1')).toMatchObject({ machines: { signedIn: 0 }, projects: 0, liveCapture: false, runnersReady: null, legacyWorkers: null });
  });

  it('counts only currently claimed machines with live authority and their live capture', async () => {
    const { read, sql, claim, capture } = rig();
    claim(); capture();
    expect(await read()).toMatchObject({ machines: { signedIn: 1 }, liveCapture: true });
    sql("DELETE FROM machine_claims WHERE machine_id = 'machine_1'");
    expect(await read()).toMatchObject({ machines: { signedIn: 0 }, liveCapture: false });
  });

  for (const [name, change] of [
    ['a session with no harness', 'UPDATE sessions SET agent = NULL'],
    ['a session from an unreported harness', "UPDATE sessions SET agent = 'other-agent'"],
    ['imported history', "UPDATE sessions SET last_live_received_at = NULL"],
    ['a stopped machine', "UPDATE member_credentials SET revoked_at = 1"],
    ['an expired machine', `UPDATE member_credentials SET expires_at = ${NOW}`],
    ['a revoked member', "UPDATE members SET revoked_at = 1 WHERE id = 'mem_machine_1'"],
    ['a session before its current claim', `UPDATE machine_claims SET claimed_at = ${NOW + 1}`],
    ['an archived project', "UPDATE projects SET archived_at = 1 WHERE project_id = 'proj_1'"],
  ]) it(`does not tick capture from ${name}`, async () => {
    const { read, claim, capture, sql } = rig(); claim(); capture(); sql(change!);
    expect((await read()).liveCapture).toBe(false);
  });

  it('does not tick capture or work from a deleted project, even if history remains', async () => {
    const { f, sql, read, claim, capture, output } = rig(); claim(); capture(); output(NOW - 1);
    f.sqlite.run('PRAGMA foreign_keys = OFF'); sql("DELETE FROM projects WHERE project_id = 'proj_1'");
    expect(await read()).toMatchObject({ liveCapture: false, workProduced: false });
  });

  it('does not tick a tombstoned session', async () => {
    const { read, claim, capture, sql } = rig(); claim(); capture();
    sql("INSERT INTO session_tombstones(project_id,session_id,created_at,created_by) VALUES ('proj_1','session_machine_1_proj_1',?,'test')", NOW);
    expect((await read()).liveCapture).toBe(false);
  });

  it('examines only the latest eight post-claim receipts per reported harness', async () => {
    const { read, claim, capture, sql } = rig(); claim(); capture();
    sql("UPDATE sessions SET last_live_received_at = ?", NOW - 100);
    for (let i = 0; i < 8; i++) {
      sql(`INSERT INTO sessions(project_id,session_id,machine_id,agent,created_by_token_id,first_received_at,last_received_at,last_live_received_at)
        VALUES ('proj_1',?,'machine_1','claude-code','mt_machine_1',?,?,?)`, `new_${i}`, NOW, NOW, NOW - i);
      sql("INSERT INTO session_tombstones(project_id,session_id,created_at,created_by) VALUES ('proj_1',?,?,'test')", `new_${i}`, NOW);
    }
    expect((await read()).liveCapture).toBe(false);
    sql("DELETE FROM session_tombstones WHERE session_id = 'new_0'");
    expect((await read()).liveCapture).toBe(true);
  });

  it('restricts a member’s capture and machines to their own claims', async () => {
    const { read, claim, capture } = rig(); claim('machine_2', 'mem_machine_2'); capture('machine_2');
    expect(await read('mem_machine_1')).toMatchObject({ machines: { signedIn: 0 }, projects: 0, liveCapture: false });
    expect(await read('mem_machine_2')).toMatchObject({ machines: { signedIn: 1 }, projects: 1, liveCapture: true });
  });

  it('counts a ready registered runner', async () => {
    const { read, runner } = rig(); runner();
    expect((await read()).runnersReady).toBe(1);
  });

  it('never counts a fresh eligible older worker as a registered runner', async () => {
    const { f, read, sql } = rig();
    seedCredential(f.sqlite, { id: 'mt_legacy', machineId: 'machine_9', expiresAt: NOW + DAY });
    sql(`INSERT INTO worker_contacts(credential_id,machine_id,offers,capabilities,last_seen_at,updated_at)
      VALUES ('mt_legacy','machine_9','[{"id":"claude-code","authenticated":true}]','[]',?,?)`, NOW, NOW);
    expect(await read()).toMatchObject({ runnersReady: 0, legacyWorkers: 1 });
  });

  for (const [name, change] of [
    ['stale', `UPDATE worker_contacts SET last_seen_at = ${NOW - DAY}`],
    ['revoked', 'UPDATE member_credentials SET revoked_at = 1'],
    ['expired', `UPDATE member_credentials SET expires_at = ${NOW}`],
  ]) it(`does not describe a ${name} older worker as running work`, async () => {
    const { f, read, sql } = rig();
    seedCredential(f.sqlite, { id: 'mt_legacy', machineId: 'machine_9', expiresAt: NOW + DAY });
    sql(`INSERT INTO worker_contacts(credential_id,machine_id,offers,capabilities,last_seen_at,updated_at)
      VALUES ('mt_legacy','machine_9','[{"id":"claude-code","authenticated":true}]','[]',?,?)`, NOW, NOW);
    sql(change!);
    expect((await read()).legacyWorkers).toBe(0);
  });

  for (const [name, change] of [
    ['revoked authority', "UPDATE runner_credentials SET revoked_at = 1"],
    ['expired authority', `UPDATE runner_credentials SET expires_at = ${NOW}`],
    ['a superseded credential epoch', "UPDATE runners SET credential_epoch = 2"],
    ['a stale contact', `UPDATE runner_contacts SET last_seen_at = ${NOW - DAY}`],
    ['a paused runner', "UPDATE runners SET state = 'paused'"],
    ['a removed runner', "UPDATE runners SET state = 'removed', removed_at = 1"],
    ['an unsigned agent', `UPDATE runner_contacts SET offers = '[{"id":"claude-code","authenticated":false}]'`],
    ['an unreadable offer', "UPDATE runner_contacts SET offers = NULL"],
    ['an unavailable runner', `INSERT INTO runner_observations(runner_id,availability,reason,observed_at) VALUES ('rn_setup','settling','waiting',${NOW})`],
  ]) it(`does not tick runner readiness from ${name}`, async () => {
    const { read, runner, sql } = rig(); runner(); sql(change!);
    expect((await read()).runnersReady).toBe(0);
  });

  it('does not tick work for a recent completed run that published nothing', async () => {
    const { read, output, sql } = rig(); output(NOW - 1);
    sql("DELETE FROM spores WHERE id = 'sp_setup'");
    expect((await read()).workProduced).toBe(false);
  });

  it('requires published output inside the 31 day window; failed runs with output count', async () => {
    const { read, output } = rig(); output(NOW - 1, 'failed');
    expect((await read()).workProduced).toBe(true);
  });
  for (const [name, at, dry] of [['old output', NOW - 32 * DAY, 0], ['dry-run output', NOW - 1, 1], ['future output', NOW + DAY, 0]] as const)
    it(`does not tick work from ${name}`, async () => {
      const { read, output } = rig(); output(at, 'completed', dry);
      expect((await read()).workProduced).toBe(false);
    });

  it('reports a queued project without an enabled registered runner, excluding deleted and archived projects', async () => {
    const { read, sql, runner } = rig();
    sql("INSERT INTO agents(id,name,source,enabled,created_at) VALUES ('a','a','built-in',1,0)");
    sql("INSERT INTO agent_runs(project_id,id,agent_id,task,status,queued_at) VALUES ('proj_1','q','a','extract-curate','queued',0)");
    expect((await read('mem_machine_2')).queuedWithoutRunner).toBe(true);
    sql("UPDATE projects SET archived_at = 1 WHERE project_id = 'proj_1'");
    expect((await read()).queuedWithoutRunner).toBe(false);
    sql("UPDATE projects SET archived_at = NULL WHERE project_id = 'proj_1'"); runner();
    expect((await read()).queuedWithoutRunner).toBe(false);
  });

  it('admits owner, admin and member sessions, refuses unlinked accounts, and redacts every role’s payload', async () => {
    const { f, sql, claim, capture, runner, output } = rig();
    sql("UPDATE deployment_ownership SET member_id = 'mem_machine_1', revision = 1 WHERE id = 1");
    seedMemberRoleAccount(f.sqlite); claim(); capture(); runner(); output(NOW - 1);
    sql("UPDATE members SET github_id = '770003' WHERE id = 'mem_machine_3'");
    const get = async (sub?: string) => {
      const response = await worker.fetch(new Request('https://s/api/setup', { headers: {
        cookie: await ownerCookie(f.db, Date.now(), sub), 'cf-connecting-ip': '1.2.3.4',
      } }), { ...f.env, ...OWNER_ENV });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const owner = await get(); expect(owner.status).toBe(200); expect(owner.body.viewerIsOwner).toBe(true);
    const admin = await get('770003'); expect(admin.status).toBe(200); expect(admin.body.viewerIsOwner).toBe(false);
    const member = await get(MEMBER_SUB); expect(member).toMatchObject({ status: 200, body: {
      signInWorking: true, machines: { signedIn: 0 }, projects: 0, liveCapture: false, runnersReady: null, legacyWorkers: null, workProduced: false,
    } });
    for (const result of [owner, admin, member]) {
      expect(Object.keys(result.body).sort()).toEqual(['ownerLinked','viewerIsOwner','signInWorking','machines','projects','liveCapture','runnersReady','workProduced','legacyWorkers','queuedWithoutRunner'].sort());
      expect(JSON.stringify(result.body)).not.toMatch(/secret|token|hash|email|583231|private output|machine_1|runner label/i);
    }
    expect((await get('770004')).status).toBe(401);
    expect((await worker.fetch(new Request('https://s/api/setup', { headers: { 'cf-connecting-ip': '1.2.3.4' } }), { ...f.env, ...OWNER_ENV })).status).toBe(401);
  });

  it('surfaces failed observations instead of answering absent progress', async () => {
    const { f, read } = rig(); f.sqlite.close();
    fixtures.splice(fixtures.indexOf(f), 1);
    await expect(read()).rejects.toThrow();
  });
});
