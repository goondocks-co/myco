import { expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { BACKUP_FORMAT, createBackup, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { bootstrapOwnership } from '@myco-server-worker/core/ownership.js';
import { RestoreAuthorizationError } from '@myco-server-worker/core/restore-authorization.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';

const OWNER = 'mem_machine_1';
const ADMIN = 'mem_machine_2';
const AUTHORITY_TABLES = [
  'members', 'enrollment_authorities', 'identity_link_authorities', 'machine_claims', 'member_credentials',
  'deployment_ownership', 'deployment_ownership_audit', 'member_role_audit', 'external_grants',
  'raw_claims', 'raw_credentials', 'raw_resources',
];

async function fixture(owner = true, onSql?: (sql: string) => void) {
  const f = sqliteEnv({ onSql });
  f.sqlite.run("UPDATE members SET role='admin',github_id='9002' WHERE id=?", [ADMIN]);
  if (owner) await bootstrapOwnership(f.db, OWNER, OWNER, '0', Date.now());
  return f;
}

function artifact(f: ReturnType<typeof sqliteEnv>, rows: Array<{ t: string; r: Record<string, unknown> }>, counts: Record<string, number> = {}): string {
  const lineage = f.sqlite.query("SELECT value FROM schema_meta WHERE key='deployment_id'").get() as { value: string };
  return [{ format: BACKUP_FORMAT, deploymentId: lineage.value, schemaVersion: SERVER_SCHEMA_VERSION, createdAt: 1, producer: 'review', counts }, ...rows]
    .map(row => JSON.stringify(row)).join('\n');
}

async function post(f: ReturnType<typeof sqliteEnv>, path: string, body: unknown, sub = '9002') {
  return worker.fetch(new Request(`https://s${path}`, {
    method: 'POST', headers: { cookie: await ownerCookie(f.db, Date.now(), sub), origin: 'https://s', 'cf-connecting-ip': '1.2.3.4' },
    body: JSON.stringify(body),
  }), { ...f.env, ...OWNER_ENV });
}

for (const table of AUTHORITY_TABLES) {
  for (const transport of ['upload', 'stored'] as const) {
    it(`refuses a non-owner admin's ${transport} ${table} before preceding data commits`, async () => {
      const attemptedWrites: string[] = [];
      const f = await fixture(true, sql => {
        if (/^(INSERT|UPDATE|DELETE)\b/i.test(sql) && !sql.startsWith('INSERT OR REPLACE INTO schema_meta (key, value)')) attemptedWrites.push(sql);
      });
      try {
        const text = artifact(f, [
          { t: 'projects', r: { project_id: 'proj_restore_denied', name: 'Denied', created_at: 1 } },
          { t: table, r: {} },
        ]);
        if (transport === 'stored') {
          f.bucket.seed('backups/review.jsonl', { size: new TextEncoder().encode(text).byteLength, bytes: new TextEncoder().encode(text) });
          f.sqlite.run("INSERT INTO backups(id,key,created_at,size_bytes,counts_json,schema_version,producer,pinned) VALUES ('bk_review','backups/review.jsonl',1,?,'{}',?,'review',0)", [new TextEncoder().encode(text).byteLength, SERVER_SCHEMA_VERSION]);
        }
        attemptedWrites.length = 0;
        const response = await post(f, transport === 'upload' ? '/api/backups/restore-upload' : '/api/backups/bk_review/restore',
          transport === 'upload' ? { artifact: text, authorization: { kind: 'recovery' } } : {});
        expect({ status: response.status, body: await response.json() }).toEqual({ status: 403, body: { error: 'not_owner' } });
        expect(attemptedWrites).toEqual([]);
        expect(f.sqlite.query("SELECT 1 FROM projects WHERE project_id='proj_restore_denied'").get()).toBeNull();
        expect(f.sqlite.query('SELECT COUNT(*) AS n FROM raw_restore_revisions').get()).toEqual({ n: 0 });
      } finally { f.sqlite.close(); }
    });
  }
}

it('holds authority restore pending explicit owner selection while preserving admin backup access', async () => {
  const f = await fixture(false);
  try {
    const backup = await createBackup(f.db, f.bucket, { now: Date.now(), producer: ADMIN });
    for (const path of ['/api/backups', `/api/backups/${backup.id}/artifact`]) {
      const response = await worker.fetch(new Request(`https://s${path}`, { headers: { cookie: await ownerCookie(f.db, Date.now(), '9002'), 'cf-connecting-ip': '1.2.3.4' } }), { ...f.env, ...OWNER_ENV });
      expect(response.status).toBe(200);
    }
    expect((await post(f, `/api/backups/${backup.id}/restore-preview`, {})).status).toBe(200);
    const response = await post(f, '/api/backups/restore-upload', { artifact: artifact(f, [{ t: 'members', r: { id: 'mem_recovery', role: 'admin', created_at: 1 } }]) });
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 409, body: { error: 'owner_pending' } });
    expect(f.sqlite.query("SELECT 1 FROM members WHERE id='mem_recovery'").get()).toBeNull();
  } finally { f.sqlite.close(); }
});

it('an owner restores authority and a non-owner admin restores ordinary data', async () => {
  const f = await fixture();
  try {
    const authority = await post(f, '/api/backups/restore-upload', { artifact: artifact(f, [{ t: 'members', r: { id: 'mem_restored_admin', role: 'admin', github_id: '9004', created_at: 1 } }]) }, '583231');
    expect(authority.status).toBe(200);
    expect(f.sqlite.query("SELECT role,github_id FROM members WHERE id='mem_restored_admin'").get()).toEqual({ role: 'admin', github_id: '9004' });
    const ordinary = await post(f, '/api/backups/restore-upload', { artifact: artifact(f, [{ t: 'projects', r: { project_id: 'proj_restore_allowed', name: 'Allowed', created_at: 1 } }]) });
    expect(ordinary.status).toBe(200);
    expect(f.sqlite.query("SELECT name FROM projects WHERE project_id='proj_restore_allowed'").get()).toEqual({ name: 'Allowed' });
  } finally { f.sqlite.close(); }
});

it('previews stored restore permission from artifact rows even when header counts disagree', async () => {
  const f = await fixture();
  try {
    const stored = (id: string, text: string) => {
      const key = `backups/${id}.jsonl`;
      const bytes = new TextEncoder().encode(text);
      f.bucket.seed(key, { size: bytes.byteLength, bytes });
      f.sqlite.run('INSERT INTO backups(id,key,created_at,size_bytes,counts_json,schema_version,producer,pinned) VALUES (?,?,1,?,\'{}\',?,\'review\',0)',
        [id, key, bytes.byteLength, SERVER_SCHEMA_VERSION]);
    };
    stored('bk_authority', artifact(f, [{ t: 'members', r: { id: 'mem_restored_admin', role: 'admin', created_at: 1 } }]));
    stored('bk_data', artifact(f, [{ t: 'projects', r: { project_id: 'proj_restore_allowed', name: 'Allowed', created_at: 1 } }], { members: 100 }));
    const preview = async (id: string, sub: string) => {
      const response = await post(f, `/api/backups/${id}/restore-preview`, {}, sub);
      expect(response.status).toBe(200);
      return response.json() as Promise<{ restore: { allowed: boolean; reason: string | null } }>;
    };
    expect((await preview('bk_authority', '9002')).restore).toEqual({
      allowed: false, reason: 'Only the owner can restore a backup that includes members or access authority.',
    });
    expect((await preview('bk_authority', '583231')).restore).toEqual({ allowed: true, reason: null });
    expect((await preview('bk_data', '9002')).restore).toEqual({ allowed: true, reason: null });
  } finally { f.sqlite.close(); }
});

it('a transfer after restore admission rolls back the first guarded data batch', async () => {
  let armed = false;
  const f = sqliteEnv({ onSql(sql, sqlite) {
    if (!armed || !sql.startsWith('INSERT OR IGNORE INTO projects')) return;
    armed = false;
    sqlite.run('UPDATE deployment_ownership SET member_id=?,revision=revision+1 WHERE id=1', [ADMIN]);
  } });
  try {
    f.sqlite.run("UPDATE members SET role='admin',github_id='9002' WHERE id=?", [ADMIN]);
    await bootstrapOwnership(f.db, OWNER, OWNER, '0', Date.now());
    armed = true;
    const text = artifact(f, [
      { t: 'projects', r: { project_id: 'proj_restore_race', name: 'Race', created_at: 1 } },
      { t: 'members', r: { id: 'mem_restore_race', role: 'admin', created_at: 1 } },
    ]);
    await expect(restoreArtifact(f.db, { text, authorization: { kind: 'member', memberId: OWNER } })).rejects.toBeInstanceOf(RestoreAuthorizationError);
    expect(f.sqlite.query("SELECT 1 FROM projects WHERE project_id='proj_restore_race'").get()).toBeNull();
    expect(f.sqlite.query("SELECT 1 FROM members WHERE id='mem_restore_race'").get()).toBeNull();
  } finally { f.sqlite.close(); }
});

it('offline recovery requires explicit authorization and preserves owner-selection mode', async () => {
  const f = await fixture(false);
  try {
    const text = artifact(f, [{ t: 'members', r: { id: 'mem_offline_recovery', role: 'admin', created_at: 1 } }]);
    await expect(Reflect.apply(restoreArtifact, undefined, [f.db, { text }])).rejects.toBeInstanceOf(RestoreAuthorizationError);
    expect(f.sqlite.query("SELECT 1 FROM members WHERE id='mem_offline_recovery'").get()).toBeNull();
    await restoreArtifact(f.db, { text, authorization: { kind: 'recovery' } });
    expect(f.sqlite.query('SELECT member_id,bootstrap_mode FROM deployment_ownership').get()).toEqual({ member_id: null, bootstrap_mode: 'selection' });
    expect(f.sqlite.query("SELECT role FROM members WHERE id='mem_offline_recovery'").get()).toEqual({ role: 'admin' });
  } finally { f.sqlite.close(); }
});
