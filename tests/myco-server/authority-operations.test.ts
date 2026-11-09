/**
 * Typed authority operations: a refusal rolls the whole commit back, the active Project count stays exact across every
 * writer, an unarchive at the limit is refused in its own commit, and a replaced successor activates nothing.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MAX_PROJECTS } from '@myco-server-worker/constants.js';
import { activateSuccessor, detectLineageReplay, refreshMemberToken } from '@myco-server-worker/auth/tokens.js';
import { admitProject, unarchiveProject } from '@myco-server-worker/db/storage/projects.js';
import { archiveProject } from '@myco-server-worker/db/storage/s2a3.js';
import { commit } from '@myco-server-worker/db/index.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { migrateAndSeed } from './helpers/d1.js';
import { issueMemberToken } from './helpers/member-token.js';

const NOW = 1_800_000_000_000;

function rig() {
  const sqlite = migrateAndSeed(new Database(':memory:'));
  return { sqlite, db: sqliteRelationalStore(sqlite) };
}
const active = (sqlite: Database) => sqlite.query('SELECT active FROM active_project_count WHERE slot=1').get() as { active: number } | null;
const realActive = (sqlite: Database) => sqlite.query('SELECT COUNT(*) AS active FROM projects WHERE archived_at IS NULL').get() as { active: number };

describe('active project count', () => {
  it('matches the projects through create, archive, unarchive, delete and restore', async () => {
    const { sqlite, db } = rig();
    expect(active(sqlite)).toEqual(realActive(sqlite));
    await admitProject(db, { projectId: 'p1', name: 'One', now: NOW }, { kind: 'operator' });
    await admitProject(db, { projectId: 'p2', name: 'Two', now: NOW }, { kind: 'operator' });
    expect(active(sqlite)).toEqual(realActive(sqlite));
    await archiveProject(db, 'p1', 'mem_machine_1', NOW);
    expect(active(sqlite)).toEqual(realActive(sqlite));
    expect(await unarchiveProject(db, 'p1')).toBe('restored');
    expect(active(sqlite)).toEqual(realActive(sqlite));
    sqlite.run("DELETE FROM projects WHERE project_id='p2'");
    expect(active(sqlite)).toEqual(realActive(sqlite));
    sqlite.run("INSERT OR IGNORE INTO projects(project_id,name,created_at) VALUES('p3','Three',1)");
    sqlite.run("INSERT OR IGNORE INTO projects(project_id,name,created_at,archived_at) VALUES('p4','Four',1,2)");
    expect(active(sqlite)).toEqual(realActive(sqlite));
  });

  it('refuses a create and an unarchive at the limit, in the commit that would exceed it', async () => {
    const { sqlite, db } = rig();
    await admitProject(db, { projectId: 'held', name: 'Held', now: NOW }, { kind: 'operator' });
    await archiveProject(db, 'held', 'mem_machine_1', NOW);
    const room = MAX_PROJECTS - realActive(sqlite).active;
    for (let i = 0; i < room; i += 1) sqlite.run(`INSERT INTO projects(project_id,name,created_at) VALUES('fill_${i}','Fill',1)`);
    expect(active(sqlite)).toEqual({ active: MAX_PROJECTS });

    const refused = await admitProject(db, { projectId: 'over', name: 'Over', now: NOW }, { kind: 'operator' });
    expect(refused).toEqual({ resolved: false, reason: 'refused' });
    expect(await unarchiveProject(db, 'held')).toEqual({ reason: 'project_limit', active: MAX_PROJECTS, limit: MAX_PROJECTS });
    expect(sqlite.query("SELECT archived_at FROM projects WHERE project_id='held'").get()).toEqual({ archived_at: NOW });

    sqlite.run("UPDATE projects SET archived_at=1 WHERE project_id='fill_0'");
    expect(active(sqlite)).toEqual({ active: MAX_PROJECTS - 1 });
    expect(await unarchiveProject(db, 'held')).toBe('restored');
    expect(active(sqlite)).toEqual({ active: MAX_PROJECTS });
  });

  it('binds a remote only to the project this admission created', async () => {
    const { sqlite, db } = rig();
    await admitProject(db, { projectId: 'p5', name: 'Five', now: NOW, remote: 'github.com/o/a' }, { kind: 'operator' });
    expect(sqlite.query("SELECT project_id FROM project_remotes WHERE remote='github.com/o/a'").get()).toEqual({ project_id: 'p5' });
    await admitProject(db, { projectId: 'p5', name: 'Five', now: NOW + 1, remote: 'github.com/o/other' }, { kind: 'operator' });
    expect(sqlite.query("SELECT COUNT(*) AS n FROM project_remotes WHERE remote='github.com/o/other'").get()).toEqual({ n: 0 });
  });
});

describe('credential activation', () => {
  async function lineage() {
    const f = rig();
    const predecessor = await issueMemberToken(f.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, NOW);
    const subject = { memberId: 'mem_machine_1', tokenId: predecessor.tokenId, machineId: 'machine_1', expiresAt: predecessor.expiresAt, lineageRoot: predecessor.tokenId, lineageStartedAt: NOW, runtime: { runtimeLabel: null, runtimeKind: null } };
    return { ...f, predecessor, subject };
  }

  it('revokes the predecessor and carries its bytes when the successor is live', async () => {
    const { sqlite, db, predecessor, subject } = await lineage();
    sqlite.run('UPDATE member_credentials SET bytes_written=70 WHERE id=?', [predecessor.tokenId]);
    const successor = await refreshMemberToken(db, subject, predecessor.expiresAt);
    if (!successor.refreshed) throw new Error('fixture: refresh refused');
    expect(await activateSuccessor(db, { tokenId: successor.tokenId, predecessorId: predecessor.tokenId }, predecessor.expiresAt + 1)).toBe(true);
    expect(sqlite.query('SELECT revoked_at FROM member_credentials WHERE id=?').get(predecessor.tokenId)).toEqual({ revoked_at: predecessor.expiresAt + 1 });
    expect(sqlite.query('SELECT bytes_written,first_used_at FROM member_credentials WHERE id=?').get(successor.tokenId)).toEqual({ bytes_written: 70, first_used_at: predecessor.expiresAt + 1 });
  });

  it('ends nothing when a second refresh already replaced the successor: no stamp, no revoke, no replay of the lineage', async () => {
    const { sqlite, db, predecessor, subject } = await lineage();
    const replaced = await refreshMemberToken(db, subject, predecessor.expiresAt);
    if (!replaced.refreshed) throw new Error('fixture: refresh refused');
    const current = await refreshMemberToken(db, subject, predecessor.expiresAt + 1);
    if (!current.refreshed) throw new Error('fixture: refresh refused');
    expect(await activateSuccessor(db, { tokenId: replaced.tokenId, predecessorId: predecessor.tokenId }, predecessor.expiresAt + 2)).toBe(false);
    expect(sqlite.query('SELECT revoked_at FROM member_credentials WHERE id=?').get(predecessor.tokenId)).toEqual({ revoked_at: null });
    expect(sqlite.query('SELECT first_used_at FROM member_credentials WHERE id=?').get(replaced.tokenId)).toEqual({ first_used_at: null });
    expect(await detectLineageReplay(db, await sha256Hex(predecessor.token), predecessor.expiresAt + 3)).toBeNull();
  });

  it('activates a successor once: a repeat changes nothing more', async () => {
    const { db, predecessor, subject } = await lineage();
    const successor = await refreshMemberToken(db, subject, predecessor.expiresAt);
    if (!successor.refreshed) throw new Error('fixture: refresh refused');
    expect(await activateSuccessor(db, { tokenId: successor.tokenId, predecessorId: predecessor.tokenId }, predecessor.expiresAt + 1)).toBe(true);
    expect(await activateSuccessor(db, { tokenId: successor.tokenId, predecessorId: predecessor.tokenId }, predecessor.expiresAt + 2)).toBe(false);
  });
});

describe('a refused authority operation writes nothing', () => {
  it('a commit with an unmet assertion leaves no rows', async () => {
    const { sqlite, db } = rig();
    const { assertion, refusalCode, write } = await import('@myco-server-worker/db/index.js');
    const code = refusalCode('authority_op_test_refused');
    const never = assertion<[]>({ name: 'authorityOpsTest.never', refusal: code, when: '1=0' });
    const insert = write<[]>({ name: 'authorityOpsTest.insert', sql: "INSERT INTO projects(project_id,name,created_at) VALUES('nope','n',1)" });
    await expect(commit(db, never.bind(), insert.bind())).rejects.toThrow();
    expect(sqlite.query("SELECT 1 FROM projects WHERE project_id='nope'").get()).toBeNull();
  });
});
