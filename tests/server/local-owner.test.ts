import { afterEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupLocalOwner } from '@myco/server/local-owner.js';
import { createLocalDeployment, DEFAULT_LOCAL_RECORD, readLocalSecrets, resolveLocalPaths, writeLocalSecrets } from '@myco/server/local.js';
import { LocalVolume } from '@myco/server/local-volume.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { previewIdentityLinkAuthority, spendIdentityLinkAuthority } from '@myco-server-worker/auth/identity-link.js';

const homes: string[] = [];
const native = { library: null, vec0: null };
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'myco-first-owner-'));
  homes.push(home);
  const paths = resolveLocalPaths(home);
  createLocalDeployment(DEFAULT_LOCAL_RECORD, native, paths);
  writeLocalSecrets({ ...readLocalSecrets(paths), GITHUB_CLIENT_ID: 'test-app', GITHUB_CLIENT_SECRET: 'test-secret' }, paths);
  return paths;
}

it('retries one pending administrator and connects it through the ordinary identity-link authority', async () => {
  const paths = fixture();
  const secrets = readFileSync(paths.secretsFile, 'utf8');
  const first = await setupLocalOwner(paths, native);
  const second = await setupLocalOwner(paths, native);
  expect(second.memberId).toBe(first.memberId);
  expect(second.url).not.toBe(first.url);
  const sqlite = new Database(paths.databasePath);
  try {
    const db = sqliteRelationalStore(sqlite);
    expect(await previewIdentityLinkAuthority(db, new URL(first.url).hash.slice(1), Date.now())).toBeNull();
    expect(await spendIdentityLinkAuthority(db, new URL(second.url).hash.slice(1), '12345', Date.now()))
      .toMatchObject({ ok: true, member: { id: first.memberId, role: 'admin' } });
    await expect(setupLocalOwner(paths, native)).rejects.toThrow(/already has members/);
    expect(sqlite.query('SELECT COUNT(*) AS n FROM members').get()).toEqual({ n: 1 });
    expect(readFileSync(paths.secretsFile, 'utf8')).toBe(secrets);
  } finally { sqlite.close(); }
});

it('refuses an existing unlinked or revoked member without granting access', async () => {
  const paths = fixture();
  const sqlite = new Database(paths.databasePath);
  try {
    sqlite.query("INSERT INTO members (id, label, created_at, role) VALUES ('mem_existing', 'Existing', 1, 'member')").run();
    await expect(setupLocalOwner(paths, native)).rejects.toThrow(/already has members/);
    sqlite.query("UPDATE members SET revoked_at = 2 WHERE id = 'mem_existing'").run();
    await expect(setupLocalOwner(paths, native)).rejects.toThrow(/already has members/);
    expect(sqlite.query('SELECT COUNT(*) AS n FROM identity_link_authorities').get()).toEqual({ n: 0 });
  } finally { sqlite.close(); }
});

it('rolls back a failed authority write so retry cannot strand an administrator', async () => {
  const paths = fixture();
  const sqlite = new Database(paths.databasePath);
  try {
    sqlite.exec("CREATE TRIGGER reject_link BEFORE INSERT ON identity_link_authorities BEGIN SELECT RAISE(ABORT, 'fixture write failure'); END");
    await expect(setupLocalOwner(paths, native)).rejects.toThrow(/fixture write failure/);
    expect(sqlite.query('SELECT COUNT(*) AS n FROM members').get()).toEqual({ n: 0 });
    sqlite.exec('DROP TRIGGER reject_link');
    const result = await setupLocalOwner(paths, native);
    expect(result.memberId).toMatch(/^mem_/);
    expect(sqlite.query('SELECT COUNT(*) AS n FROM members').get()).toEqual({ n: 1 });
  } finally { sqlite.close(); }
});

it('refuses a serving volume and an incomplete sign-in configuration before making a member', async () => {
  const paths = fixture();
  const serving = await new LocalVolume(paths).serve(async () => ({ stop: async () => {} }));
  try { await expect(setupLocalOwner(paths, native)).rejects.toThrow(/volume is in use/); }
  finally { await serving.stop(); }
  writeLocalSecrets({ ...readLocalSecrets(paths), GITHUB_CLIENT_SECRET: '' }, paths);
  await expect(setupLocalOwner(paths, native)).rejects.toThrow(/github-app/);
  const sqlite = new Database(paths.databasePath);
  try { expect(sqlite.query('SELECT COUNT(*) AS n FROM members').get()).toEqual({ n: 0 }); }
  finally { sqlite.close(); }
});
