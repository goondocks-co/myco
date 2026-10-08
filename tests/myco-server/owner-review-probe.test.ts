import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import worker from '@myco-server-worker/index.js';
import { bootstrapOwnership } from '@myco-server-worker/core/ownership.js';
import { BACKUP_FORMAT } from '@myco-server-worker/core/backup.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { issueIdentityLinkAuthority, spendIdentityLinkAuthority } from '@myco-server-worker/auth/identity-link.js';
import { issueMemberToken, revokeCredentialAsMember, revokeMachineCredentialsAsMember } from '@myco-server-worker/auth/tokens.js';
import { renameMachine } from '@myco-server-worker/auth/enrollment.js';

const OWNER = 'mem_machine_1';
const ADMIN = 'mem_machine_2';
const MEMBER = 'mem_machine_3';
async function rig() {
  const f = sqliteEnv();
  f.sqlite.run("UPDATE members SET github_id='9002',role='admin' WHERE id=?", [ADMIN]);
  f.sqlite.run("UPDATE members SET github_id='9003',role='member' WHERE id=?", [MEMBER]);
  await bootstrapOwnership(f.db, OWNER, OWNER, '0', Date.now());
  return f;
}
async function post(f: ReturnType<typeof sqliteEnv>, sub: string, path: string, body: unknown) {
  return worker.fetch(new Request(`https://s${path}`, {
    method: 'POST', headers: { cookie: await ownerCookie(f.db, Date.now(), sub), origin: 'https://s', 'cf-connecting-ip': '1.2.3.4' },
    body: JSON.stringify(body),
  }), { ...f.env, ...OWNER_ENV });
}
for (const actor of [{ sub: '583231', role: 'owner', status: 200 }, { sub: '9002', role: 'admin', status: 403 }, { sub: '9003', role: 'member', status: 403 }]) {
  for (const operation of ['transfer', 'promote', 'demote'] as const) {
    it(`${actor.role} ${actor.status === 200 ? 'may' : 'may not'} ${operation}`, async () => {
      const f = await rig();
      try {
        const response = operation === 'transfer'
          ? await post(f, actor.sub, '/api/ownership/transfer', { member_id: ADMIN, expected_revision: '1' })
          : await post(f, actor.sub, `/api/members/${operation === 'promote' ? MEMBER : ADMIN}/role`, { role: operation === 'promote' ? 'admin' : 'member', expected_revision: '0' });
        expect(response.status).toBe(actor.status);
        if (actor.status !== 200) {
          expect(f.sqlite.query('SELECT member_id,revision FROM deployment_ownership').get()).toEqual({ member_id: OWNER, revision: 1 });
          expect(f.sqlite.query('SELECT COUNT(*) AS n FROM member_role_audit').get()).toEqual({ n: 0 });
        }
      } finally { f.sqlite.close(); }
    });
  }
}
it('a non-owner admin may not grant admin authority through restore-upload', async () => {
  const f = await rig();
  try {
    const now = Date.now();
    const lineage = f.sqlite.query("SELECT value FROM schema_meta WHERE key='deployment_id'").get() as { value: string };
    const artifact = [
      { format: BACKUP_FORMAT, deploymentId: lineage.value, schemaVersion: 73, createdAt: now, producer: ADMIN, counts: { members: 1 } },
      { t: 'members', r: { id: 'mem_review_admin', role: 'admin', github_id: '9004', created_at: now } },
    ].map(row => JSON.stringify(row)).join('\n');
    const response = await post(f, '9002', '/api/backups/restore-upload', { artifact });
    const inserted = f.sqlite.query('SELECT id,role,github_id FROM members WHERE id=?').get('mem_review_admin');
    expect({ status: response.status, inserted }).toEqual({ status: 403, inserted: null });
  } finally { f.sqlite.close(); }
});

for (const [table, column] of [['member_role_audit', 'actor_id'], ['deployment_ownership_audit', 'previous_member_id']]) {
  it(`indexes the foreign-key child ${table}.${column}`, () => {
    const f = sqliteEnv();
    try {
      const indexes = f.sqlite.query(`PRAGMA index_list(${table})`).all() as { name: string }[];
      const covered = indexes.some(index => {
        const fields = f.sqlite.query(`PRAGMA index_info(${index.name})`).all() as { name: string }[];
        return fields[0]?.name === column;
      });
      expect({ table, column, covered }).toEqual({ table, column, covered: true });
    } finally { f.sqlite.close(); }
  });
}

it('schema 73 preserves an established owner with two live admins', () => {
  const sqlite = new Database(':memory:');
  try {
    for (const step of SCHEMA_STEPS.filter(step => step.version < 73)) for (const sql of step.statements) sqlite.exec(sql);
    sqlite.run("INSERT INTO members(id,role,github_id,created_at) VALUES (?,'admin','9001',0),(?,'admin','9002',0)", [OWNER, ADMIN]);
    sqlite.run('UPDATE deployment_ownership SET member_id=?,revision=1 WHERE id=1', [OWNER]);
    sqlite.run('INSERT INTO deployment_ownership_audit(revision,member_id,actor_id,created_at) VALUES (1,?,?,0)', [OWNER, OWNER]);
    for (const sql of SCHEMA_STEPS.find(step => step.version === 73)!.statements) sqlite.exec(sql);
    expect(sqlite.query('SELECT member_id,revision,bootstrap_mode FROM deployment_ownership').get()).toEqual({ member_id: OWNER, revision: 1, bootstrap_mode: 'selection' });
    expect(sqlite.query('SELECT role,role_revision FROM members ORDER BY id').all()).toEqual([{ role: 'admin', role_revision: 0 }, { role: 'admin', role_revision: 0 }]);
    expect(sqlite.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally { sqlite.close(); }
});

it('two fresh authenticated links produce exactly one linked owner and receipt', async () => {
  const sqlite = new Database(':memory:');
  try {
    for (const step of SCHEMA_STEPS) for (const sql of step.statements) sqlite.exec(sql);
    sqlite.run("INSERT INTO members(id,role,created_at) VALUES (?,'admin',0),(?,'admin',0)", [OWNER, ADMIN]);
    const db = sqliteRelationalStore(sqlite);
    const now = Date.now();
    const first = (await issueIdentityLinkAuthority(db, OWNER, now))!;
    const second = (await issueIdentityLinkAuthority(db, ADMIN, now))!;
    const results = await Promise.all([spendIdentityLinkAuthority(db, first.key, '9001', now), spendIdentityLinkAuthority(db, second.key, '9002', now)]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    const linked = sqlite.query('SELECT id FROM members WHERE github_id IS NOT NULL').all() as { id: string }[];
    expect(linked).toHaveLength(1);
    expect(sqlite.query('SELECT member_id,revision FROM deployment_ownership').get()).toEqual({ member_id: linked[0]!.id, revision: 1 });
    expect(sqlite.query('SELECT COUNT(*) AS n FROM deployment_ownership_audit').get()).toEqual({ n: 1 });
  } finally { sqlite.close(); }
});

for (const operation of ['credential', 'machine'] as const) {
  it(`a demoted admin loses authority before a foreign ${operation} Stop commits`, async () => {
    let armed = false;
    const f = sqliteEnv({ onSql(sql, sqlite) {
      if (!armed || !/UPDATE member_credentials SET revoked_at/.test(sql)) return;
      armed = false;
      sqlite.run("UPDATE members SET role='member',role_revision=role_revision+1 WHERE id=?", [ADMIN]);
    } });
    try {
      const now = Date.now();
      f.sqlite.run("UPDATE members SET github_id='9002',role='admin' WHERE id=?", [ADMIN]);
      f.sqlite.run("UPDATE members SET role='member' WHERE id=?", [MEMBER]);
      await bootstrapOwnership(f.db, OWNER, OWNER, '0', now);
      f.sqlite.run('INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES (?,?,?)', ['review_machine', MEMBER, now]);
      const issued = await issueMemberToken(f.db, { memberId: MEMBER, machineId: 'review_machine' }, now);
      armed = true;
      const actor = { id: ADMIN, label: null, role: 'admin' as const };
      const outcome = operation === 'credential'
        ? await revokeCredentialAsMember(f.db, actor, issued.tokenId, now)
        : await revokeMachineCredentialsAsMember(f.db, actor, 'review_machine', now);
      expect(outcome.revoked).toBe(operation === 'credential' ? false : 0);
      expect(f.sqlite.query('SELECT revoked_at FROM member_credentials WHERE id=?').get(issued.tokenId)).toEqual({ revoked_at: null });
    } finally { f.sqlite.close(); }
  });
}

it('a demoted admin loses authority before a foreign machine rename commits', async () => {
  let armed = false;
  const f = sqliteEnv({ onSql(sql, sqlite) {
    if (!armed || !sql.startsWith('UPDATE machine_claims SET label')) return;
    armed = false;
    sqlite.run("UPDATE members SET role='member',role_revision=role_revision+1 WHERE id=?", [ADMIN]);
  } });
  try {
    f.sqlite.run("UPDATE members SET role='admin' WHERE id=?", [ADMIN]);
    f.sqlite.run('INSERT INTO machine_claims(machine_id,member_id,claimed_at,label) VALUES (?,?,0,?)', ['rename_race', MEMBER, 'Original']);
    armed = true;
    expect(await renameMachine(f.db, { memberId: ADMIN }, 'rename_race', 'Forbidden')).toBe(false);
    expect(f.sqlite.query("SELECT label FROM machine_claims WHERE machine_id='rename_race'").get()).toEqual({ label: 'Original' });
  } finally { f.sqlite.close(); }
});

for (const state of ['admin', 'member-own', 'member-foreign', 'revoked'] as const) {
  it(`machine rename resolves ${state} authority at its conditional write`, async () => {
    const f = sqliteEnv();
    try {
      f.sqlite.run("UPDATE members SET role=?,revoked_at=? WHERE id=?", [state === 'admin' ? 'admin' : 'member', state === 'revoked' ? 1 : null, ADMIN]);
      f.sqlite.run('INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES (?,?,0)', ['rename_scope', state === 'member-own' || state === 'revoked' ? ADMIN : MEMBER]);
      expect(await renameMachine(f.db, { memberId: ADMIN }, 'rename_scope', 'Renamed')).toBe(state === 'admin' || state === 'member-own');
    } finally { f.sqlite.close(); }
  });
}

for (const operation of ['credential', 'machine'] as const) {
  it(`a revoked admin loses authority before a foreign ${operation} Stop commits`, async () => {
    let armed = false;
    const f = sqliteEnv({ onSql(sql, sqlite) {
      if (!armed || !sql.startsWith('UPDATE member_credentials SET revoked_at')) return;
      armed = false;
      sqlite.run('UPDATE members SET revoked_at=1 WHERE id=?', [ADMIN]);
    } });
    try {
      const now = Date.now();
      f.sqlite.run("UPDATE members SET role='admin',github_id='9002' WHERE id=?", [ADMIN]);
      f.sqlite.run('INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES (?,?,?)', ['revoke_race', MEMBER, now]);
      const issued = await issueMemberToken(f.db, { memberId: MEMBER, machineId: 'revoke_race' }, now);
      armed = true;
      const actor = { id: ADMIN, label: null, role: 'admin' as const };
      const result = operation === 'credential'
        ? await revokeCredentialAsMember(f.db, actor, issued.tokenId, now)
        : await revokeMachineCredentialsAsMember(f.db, actor, 'revoke_race', now);
      expect(result.revoked).toBe(operation === 'credential' ? false : 0);
      expect(f.sqlite.query('SELECT revoked_at FROM member_credentials WHERE id=?').get(issued.tokenId)).toEqual({ revoked_at: null });
    } finally { f.sqlite.close(); }
  });
}
