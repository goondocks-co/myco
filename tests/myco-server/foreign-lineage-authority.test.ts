/**
 * A backup from another Deployment carries that Deployment's people and access. A fork F restoring a post-fork backup
 * of its source A lists A's newly added people without access and lands every one of A's credentials, keys and grants
 * revoked, keeping their attribution; F keeps its own owner, and only F's owner re-admits a person. The preview says
 * so. A same-lineage replacement restore inserts the same rows as they are.
 */
import { describe, expect, it } from 'bun:test';
import {
  BACKUP_TABLES, backupArtifact, createBackup, deploymentId, FOREIGN_AUTHORITY_NOTICE, FOREIGN_AUTHORITY_TABLES,
  previewRestore, restoreArtifact, restoreBackup,
} from '@myco-server-worker/core/backup.js';
import { authenticateServerMemberToken, releasedRunCredential } from '@myco-server-worker/auth/tokens.js';
import { authenticateGrant } from '@myco-server-worker/auth/grants.js';
import { authenticateRunner } from '@myco-server-worker/auth/runners.js';
import { memberByGithubId } from '@myco-server-worker/auth/identity-link.js';
import { memberSubject } from '@myco-server-worker/auth/authorization.js';
import { listMembers } from '@myco-server-worker/auth/members-admin.js';
import { changeMemberRole } from '@myco-server-worker/core/ownership.js';
import { FOREIGN_LINEAGE_REVOKER, HARNESS_MEMBER_ID } from '@myco-server-worker/constants.js';
import { sqliteEnv } from './helpers/fixtures.js';

type Env = ReturnType<typeof sqliteEnv>;
const NOW = 1_800_000_000_000;
const FUTURE = NOW + 86_400_000;
const PROJECT = 'proj_fork';
const OWNER_GITHUB = '640001';
const NEW_ADMIN_GITHUB = '970001';
const BEARER_TABLES = FOREIGN_AUTHORITY_TABLES.filter((table) => table !== 'members');

function seedTenant(env: Env): void {
  env.sqlite.run(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES (?, 'fork', 1)`, [PROJECT]);
  env.sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at, role, github_id) VALUES ('mem_a', 'A owner', 1, 'admin', ?)`, [OWNER_GITHUB]);
  env.sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at) VALUES (?, 'harness', 1)`, [HARNESS_MEMBER_ID]);
  env.sqlite.run(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, issued_at, expires_at, lineage_root, lineage_started_at)
    VALUES ('cred_pre', 'mem_a', 'hash_pre', 'machine_a', 1, ?, 'cred_pre', 1)`, [FUTURE]);
}

/** What A adds after the fork: a GitHub-linked admin, a person A itself removed, and every carried bearer kind, live, plus a released harness credential still in its window. */
function issueAfterFork(env: Env): void {
  env.sqlite.run(`INSERT INTO members (id, label, created_at, role, github_id) VALUES ('mem_new', 'A new admin', 2, 'admin', ?)`, [NEW_ADMIN_GITHUB]);
  env.sqlite.run(`INSERT INTO members (id, label, created_at, role, revoked_at, revoked_by) VALUES ('mem_gone', 'A removed', 2, 'member', 3, 'mem_a')`);
  env.sqlite.run(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, issued_at, expires_at, lineage_root, lineage_started_at)
    VALUES ('cred_post', 'mem_a', 'hash_post', 'machine_a2', 2, ?, 'cred_post', 2)`, [FUTURE]);
  env.sqlite.run(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, issued_at, expires_at, lineage_root, lineage_started_at)
    VALUES ('cred_new', 'mem_new', 'hash_new', 'machine_new', 2, ?, 'cred_new', 2)`, [FUTURE]);
  env.sqlite.run(`INSERT INTO member_credentials (id, member_id, token_hash, issued_at, expires_at, lineage_root, lineage_started_at, revoked_at, revoked_by)
    VALUES ('cred_harness', ?, 'hash_harness', 2, ?, 'cred_harness', 2, 3, ?)`, [HARNESS_MEMBER_ID, FUTURE, HARNESS_MEMBER_ID]);
  env.sqlite.run(`INSERT INTO enrollment_authorities (id, key_hash, created_at, expires_at, member_id) VALUES ('enr_post', 'enr_hash', 2, ?, 'mem_new')`, [FUTURE]);
  env.sqlite.run(`INSERT INTO identity_link_authorities (id, key_hash, member_id, created_at, expires_at) VALUES ('link_post', 'link_hash', 'mem_new', 2, ?)`, [FUTURE]);
  env.sqlite.run(`INSERT INTO external_grants (id, project_id, key_hash, created_by, created_at, expires_at) VALUES ('grant_post', ?, 'grant_hash', 'mem_new', 2, ?)`, [PROJECT, FUTURE]);
  env.sqlite.run(`INSERT INTO runners (id, name, created_at, created_by_member) VALUES ('rn_post', 'mini', 2, 'mem_new')`);
  env.sqlite.run(`INSERT INTO runner_credentials (id, runner_id, token_hash, epoch, issued_at, expires_at, lineage_root) VALUES ('rc_post', 'rn_post', 'runner_hash', 1, 2, ?, 'rc_post')`, [FUTURE]);
}

const BEARER_IDS = ['cred_pre', 'cred_post', 'cred_new', 'cred_harness', 'enr_post', 'link_post', 'grant_post', 'rc_post'];

function liveBearers(env: Env): string[] {
  return BEARER_TABLES.flatMap((table) => env.sqlite.query<{ id: string }, []>(
    `SELECT id FROM ${table} WHERE revoked_at IS NULL ORDER BY id`).all().map((row) => `${table}:${row.id}`));
}

/** Every way a carried row could authenticate on the store under test: a bearer secret or a GitHub sign-in. */
async function authenticated(env: Env): Promise<string[]> {
  const hits: string[] = [];
  if (await authenticateServerMemberToken(env.db, 'hash_post', NOW) !== null) hits.push('member credential');
  if (await authenticateServerMemberToken(env.db, 'hash_new', NOW) !== null) hits.push('new admin credential');
  if (await releasedRunCredential(env.db, 'hash_harness', NOW) !== null) hits.push('released harness credential');
  if (await authenticateGrant(env.db, 'grant_hash', NOW) !== null) hits.push('external grant');
  if (await authenticateRunner(env.db, 'runner_hash', NOW) !== null) hits.push('runner credential');
  if (await memberByGithubId(env.db, NEW_ADMIN_GITHUB) !== null) hits.push('new admin GitHub sign-in');
  if ((await memberSubject(env.db, 'mem_new', 'http')).live) hits.push('new admin live actor');
  return hits;
}

const ALL_AUTHORITY = ['member credential', 'new admin credential', 'released harness credential', 'external grant', 'runner credential', 'new admin GitHub sign-in', 'new admin live actor'];

/** A stored copy of a backup in `env`'s own index and bucket, as an owner download-and-upload would leave it. */
async function storeIn(env: Env, source: Env, id: string): Promise<void> {
  const row = source.sqlite.query<Record<string, unknown>, [string]>('SELECT * FROM backups WHERE id = ?').get(id)!;
  const { text } = (await backupArtifact(source.db, source.bucket, id))!;
  await env.bucket.put(row.key as string, new Response(text).body, { sha256: row.sha256 as string });
  env.sqlite.run(`INSERT INTO backups (id, key, created_at, size_bytes, counts_json, schema_version, producer, pinned, sha256)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`, [id, row.key as string, row.created_at as number, row.size_bytes as number,
    row.counts_json as string, row.schema_version as number, row.producer as string, row.sha256 as string]);
}

/** F as a fork recovery leaves it: A's rows restored as the same tenant, then a rotated identity with every carried bearer row revoked, and A's owner as F's owner. */
async function fork(a: Env): Promise<Env> {
  const f = sqliteEnv();
  f.sqlite.run(`UPDATE schema_meta SET value = ? WHERE key = 'deployment_id'`, [await deploymentId(a.db)]);
  const saved = await createBackup(a.db, a.bucket, { producer: 'fork', now: 10 });
  await restoreArtifact(f.db, { authorization: { kind: 'recovery' }, text: (await backupArtifact(a.db, a.bucket, saved.id))!.text, now: NOW });
  f.sqlite.run(`UPDATE schema_meta SET value = ? WHERE key = 'deployment_id'`, [crypto.randomUUID()]);
  for (const table of BEARER_TABLES) f.sqlite.run(`UPDATE ${table} SET revoked_at = 5 WHERE revoked_at IS NULL`);
  f.sqlite.run(`UPDATE deployment_ownership SET member_id = 'mem_a', revision = 1, bootstrap_mode = 'selection' WHERE id = 1`);
  return f;
}

describe('foreign-lineage restore of people and access', () => {
  it('GATE: every carried table holding a bearer hash or a GitHub sign-in is held on a foreign-lineage insert', () => {
    const env = sqliteEnv();
    try {
      const columnsOf = (table: string) => env.sqlite.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all().map((column) => column.name);
      const bearing = BACKUP_TABLES.filter((table) => columnsOf(table).some((column) => ['key_hash', 'token_hash', 'github_id'].includes(column)));
      expect([...bearing].sort()).toEqual([...FOREIGN_AUTHORITY_TABLES].sort());
      for (const table of FOREIGN_AUTHORITY_TABLES) expect(columnsOf(table)).toEqual(expect.arrayContaining(['revoked_at', 'revoked_by']));
    } finally { env.sqlite.close(); }
  });

  it('a post-fork backup of A restored into fork F holds A\'s new admin, revokes A\'s access, keeps F\'s owner, and the preview names it', async () => {
    const a = sqliteEnv();
    let f: Env | undefined;
    try {
      seedTenant(a);
      f = await fork(a);
      expect(await deploymentId(f.db)).not.toBe(await deploymentId(a.db));
      f.sqlite.run(`INSERT INTO member_credentials (id, member_id, token_hash, issued_at, expires_at, lineage_root, lineage_started_at)
        VALUES ('cred_f', 'mem_a', 'hash_f', 5, ?, 'cred_f', 5)`, [FUTURE]);

      issueAfterFork(a);
      a.sqlite.run(`UPDATE deployment_ownership SET member_id = 'mem_new', revision = 7, bootstrap_mode = 'selection' WHERE id = 1`);
      a.sqlite.run(`INSERT INTO deployment_ownership_audit (revision, member_id, actor_id, created_at) VALUES (7, 'mem_new', 'mem_a', 2)`);
      expect(await authenticated(a)).toEqual(ALL_AUTHORITY);
      const postFork = await createBackup(a.db, a.bucket, { producer: 'post-fork', now: 20 });
      await storeIn(f, a, postFork.id);

      const preview = (await previewRestore(f.db, f.bucket, postFork.id))!;
      expect(preview.foreignLineage).toBe(true);
      expect(preview.authorityExcluded).toEqual({ tables: [...FOREIGN_AUTHORITY_TABLES], notice: FOREIGN_AUTHORITY_NOTICE });
      expect(preview.authorityExcluded!.notice).toContain('cannot sign in until the owner re-admits them');

      const outcome = (await restoreBackup(f.db, f.bucket, { authorization: { kind: 'recovery' }, id: postFork.id, allowForeignLineage: true, now: NOW }))!;
      expect(outcome.tables.member_credentials?.inserted).toBe(3);
      expect(outcome.tables.deployment_ownership?.skipped).toContain('keeps its own owner');
      expect(liveBearers(f)).toEqual(['member_credentials:cred_f']);
      expect(await authenticated(f)).toEqual([]);
      expect(await authenticateServerMemberToken(f.db, 'hash_f', NOW)).not.toBeNull();
      expect(await memberByGithubId(f.db, OWNER_GITHUB)).toMatchObject({ id: 'mem_a', role: 'admin' });
      expect(f.sqlite.query(`SELECT member_id FROM deployment_ownership WHERE id = 1`).get()).toEqual({ member_id: 'mem_a' });

      const carried = BEARER_TABLES.flatMap((table) => f!.sqlite.query<Record<string, unknown>, []>(
        `SELECT id, revoked_by FROM ${table} WHERE id IN (${BEARER_IDS.map((id) => `'${id}'`).join(', ')})`).all());
      expect(carried.map((row) => row.id).sort()).toEqual([...BEARER_IDS].sort());
      for (const row of carried) expect(row.revoked_by).toBe(row.id === 'cred_pre' ? null : FOREIGN_LINEAGE_REVOKER);
      expect(f.sqlite.query(`SELECT role, github_id, revoked_at, revoked_by FROM members WHERE id = 'mem_new'`).get())
        .toEqual({ role: 'admin', github_id: NEW_ADMIN_GITHUB, revoked_at: NOW, revoked_by: FOREIGN_LINEAGE_REVOKER });
      expect(f.sqlite.query(`SELECT revoked_at, revoked_by FROM members WHERE id = 'mem_gone'`).get()).toEqual({ revoked_at: 3, revoked_by: 'mem_a' });
      const listed = await listMembers(f.db, NOW);
      expect(listed.filter((member) => member.awaitingAdmission).map((member) => member.id)).toEqual(['mem_new']);

      const again = (await restoreBackup(f.db, f.bucket, { authorization: { kind: 'recovery' }, id: postFork.id, allowForeignLineage: true, now: NOW + 1 }))!;
      expect(again.tables.member_credentials?.inserted).toBe(0);
      expect(await authenticated(f)).toEqual([]);

      await expect(changeMemberRole(f.db, 'mem_new', 'mem_new', 'admin', '0', NOW)).rejects.toThrow('not_owner');
      await expect(changeMemberRole(f.db, 'mem_a', 'mem_gone', 'member', '0', NOW)).rejects.toThrow('invalid_member');
      expect(await changeMemberRole(f.db, 'mem_a', 'mem_new', 'admin', '0', NOW + 2)).toEqual({ memberId: 'mem_new', role: 'admin', roleRevision: '1' });
      expect(await memberByGithubId(f.db, NEW_ADMIN_GITHUB)).toMatchObject({ id: 'mem_new', role: 'admin' });
      expect((await memberSubject(f.db, 'mem_new', 'http')).live).toBe(true);
      expect(f.sqlite.query(`SELECT revision, previous_role, role, actor_id FROM member_role_audit WHERE member_id = 'mem_new'`).all())
        .toEqual([{ revision: 1, previous_role: 'admin', role: 'admin', actor_id: 'mem_a' }]);
      expect(await authenticateServerMemberToken(f.db, 'hash_new', NOW)).toBeNull();
    } finally { a.sqlite.close(); f?.sqlite.close(); }
  });

  it('a same-lineage replacement restore inserts people and access as they are, and its preview names no exclusion', async () => {
    const a = sqliteEnv();
    const replacement = sqliteEnv();
    try {
      seedTenant(a);
      issueAfterFork(a);
      const saved = await createBackup(a.db, a.bucket, { producer: 'replacement', now: 20 });
      replacement.sqlite.run(`UPDATE schema_meta SET value = ? WHERE key = 'deployment_id'`, [await deploymentId(a.db)]);
      await storeIn(replacement, a, saved.id);
      const preview = (await previewRestore(replacement.db, replacement.bucket, saved.id))!;
      expect({ foreign: preview.foreignLineage, excluded: preview.authorityExcluded }).toEqual({ foreign: false, excluded: null });

      await restoreBackup(replacement.db, replacement.bucket, { authorization: { kind: 'recovery' }, id: saved.id, now: NOW });
      const columns = 'id, role, revoked_at, revoked_by';
      expect(replacement.sqlite.query(`SELECT ${columns} FROM members ORDER BY id`).all())
        .toEqual(a.sqlite.query(`SELECT ${columns} FROM members ORDER BY id`).all());
      for (const table of BEARER_TABLES) {
        expect(replacement.sqlite.query(`SELECT id, revoked_at, revoked_by FROM ${table} ORDER BY id`).all())
          .toEqual(a.sqlite.query(`SELECT id, revoked_at, revoked_by FROM ${table} ORDER BY id`).all());
      }
      expect(await authenticated(replacement)).toEqual(ALL_AUTHORITY);
      expect((await listMembers(replacement.db, NOW)).some((member) => member.awaitingAdmission)).toBe(false);
    } finally { a.sqlite.close(); replacement.sqlite.close(); }
  });
});
