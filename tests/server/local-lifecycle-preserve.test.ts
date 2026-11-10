import { afterEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NESTED_BUN_TEST_TIMEOUT_ARGS, sandboxChildEnv } from '../../scripts/test-environment.mjs';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalDeployment, ensureLocalSecrets, DEFAULT_LOCAL_RECORD, peekLocalPaths, readLocalSecrets, writeLocalRecord, writeLocalSecrets, type LocalCreateStep } from '@myco/server/local.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { inspectLocal, prepareLocal, recoverLocalOwnerLink, type LocalPreparePlan, type LocalPrepareDeps } from '@myco/server/local-lifecycle.js';
import { localOwnerLinked, setupLocalOwner, waitForOwnerLink } from '@myco/server/local-owner.js';
import { LocalVolume, volumeIdentity } from '@myco/server/local-volume.js';
import { defaultSpec, installService, servicePaths, renderUnit } from '@myco/server/service.js';
import { nativeServicePlatform } from '../helpers/native-service-platform.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { spendIdentityLinkAuthority } from '@myco-server-worker/auth/identity-link.js';
import { fixture, native, plan, signIn, serve, tree, installLocalLifecycle } from './fixtures/local-lifecycle.js';
installLocalLifecycle();

describe('reviewed native volume preservation', () => {
  for (const damage of ['deleted', 'spaced', 'invalid', 'missing-session'] as const) {
    it(`refuses a populated volume with ${damage} secrets without changing any bytes`, async () => {
      const f = fixture(); signIn(f);
      await setupLocalOwner(f.paths, native);
      const original = fs.readFileSync(f.paths.secretsFile, 'utf8');
      if (damage === 'deleted') fs.unlinkSync(f.paths.secretsFile);
      else fs.writeFileSync(f.paths.secretsFile, damage === 'spaced' ? original.replace('SECRET_WRAP_KEY=', 'SECRET_WRAP_KEY = ')
        : damage === 'invalid' ? original.replace(/SECRET_WRAP_KEY=.*/, 'SECRET_WRAP_KEY=broken')
          : original.replace(/SESSION_SECRET=.*/, 'SESSION_SECRET='));
      const before = tree(f.paths.root);
      expect((await inspectLocal(f.home, f.deps)).creation).toEqual({ unavailable: 'storage keys missing for an existing volume; restore secrets.env' });
      await expect(prepareLocal(f.home, plan, f.deps)).rejects.toThrow('restore secrets.env');
      expect(() => ensureLocalSecrets(f.paths)).toThrow('restore secrets.env');
      expect(() => createLocalDeployment(DEFAULT_LOCAL_RECORD, native, f.paths)).toThrow('restore secrets.env');
      expect(tree(f.paths.root)).toEqual(before);
      expect(f.platform.running.size).toBe(0);
    });
  }
  it('refuses missing keys even when only user rows identify an existing database', async () => {
    const f = fixture(false);
    fs.mkdirSync(f.paths.root, { recursive: true });
    const db = new Database(f.paths.databasePath);
    db.exec("CREATE TABLE user_data (value TEXT); INSERT INTO user_data VALUES ('keep me')");
    db.close();
    const before = tree(f.paths.root);
    expect(() => ensureLocalSecrets(f.paths)).toThrow('restore secrets.env');
    expect((await inspectLocal(f.home, f.deps)).creation).toMatchObject({ unavailable: expect.stringContaining('restore secrets.env') });
    expect(tree(f.paths.root)).toEqual(before);
  });
  it('preserves unknown secrets lines and saves the prior file before every rewrite', () => {
    const f = fixture();
    const original = fs.readFileSync(f.paths.secretsFile, 'utf8') + '# operator note\r\nOTHER_TOKEN=keep\r\nSECRET_WRAP_KEY = retained malformed line\n';
    fs.writeFileSync(f.paths.secretsFile, original);
    signIn(f);
    expect(fs.readFileSync(f.paths.secretsFile + '.bak', 'utf8')).toBe(original);
    expect(fs.readFileSync(f.paths.secretsFile, 'utf8')).toContain('# operator note\r\nOTHER_TOKEN=keep\r\nSECRET_WRAP_KEY = retained malformed line\n');
    expect(fs.statSync(f.paths.secretsFile + '.bak').mode & 0o777).toBe(0o600);
    const next = fs.readFileSync(f.paths.secretsFile, 'utf8');
    signIn(f);
    expect(fs.readFileSync(f.paths.secretsFile + '.bak', 'utf8')).toBe(next);
  });
  it('resumes a populated volume missing its sentinel without replacing data or keys', async () => {
    const f = fixture(); signIn(f);
    const link = await setupLocalOwner(f.paths, native);
    const db = new Database(f.paths.databasePath);
    try { await spendIdentityLinkAuthority(sqliteRelationalStore(db), new URL(link.url).hash.slice(1), '2345', Date.now()); }
    finally { db.close(); }
    fs.mkdirSync(f.paths.blobDir, { recursive: true });
    const blob = path.join(f.paths.blobDir, 'kept-object');
    fs.writeFileSync(blob, 'retained object bytes');
    fs.unlinkSync(f.paths.recordFile);
    const database = fs.readFileSync(f.paths.databasePath);
    const secrets = fs.readFileSync(f.paths.secretsFile);
    await prepareLocal(f.home, plan, f.deps);
    expect(fs.readFileSync(f.paths.databasePath)).toEqual(database);
    expect(fs.readFileSync(f.paths.secretsFile)).toEqual(secrets);
    expect(fs.readFileSync(blob, 'utf8')).toBe('retained object bytes');
    expect((await inspectLocal(f.home, f.deps)).owner).toBe('linked');
  });
  it('does not install a service when initial sign-in registration fails', async () => {
    const f = fixture(false);
    await expect(prepareLocal(f.home, { ...plan, signIn: { url: 'http://127.0.0.1:8787', target: { kind: 'local', paths: f.paths } } },
      { ...f.deps, registerSignIn: async () => { throw new Error('user cancelled GitHub'); } })).rejects.toThrow('user cancelled GitHub');
    expect(fs.existsSync(servicePaths(f.spec, 'darwin').unitFile)).toBe(false);
    expect(f.platform.running.size).toBe(0);
    expect(f.platform.commands.some(line => /load|bootstrap/.test(line))).toBe(false);
  });
  it('does not start an already installed stopped service after failed setup', async () => {
    const f = fixture();
    const unit = servicePaths(f.spec, 'darwin').unitFile;
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, renderUnit(f.spec, servicePaths(f.spec, 'darwin'), 'darwin'));
    await expect(prepareLocal(f.home, plan, f.deps)).rejects.toThrow('configure native sign-in');
    expect(f.platform.running.size).toBe(0);
    expect(f.platform.commands.some(line => /load|bootstrap/.test(line))).toBe(false);
  });
  it('normalizes a relative home through inspection, preparation and link recovery', async () => {
    const f = fixture(); signIn(f);
    const relative = path.relative(process.cwd(), f.home);
    expect((await inspectLocal(relative, f.deps)).creation).toBe('complete');
    await prepareLocal(relative, plan, f.deps);
    expect(fs.readFileSync(servicePaths(f.spec, 'darwin').unitFile, 'utf8')).toContain(`<string>${f.home}</string>`);
    await recoverLocalOwnerLink(relative, plan, f.deps);
    expect((await inspectLocal(relative, f.deps)).serving.mode).toBe('service');
  });
  it('refuses a systemd home or log path containing spaces before installation', async () => {
    const f = fixture(true, 'My Myco');
    const spec = defaultSpec(f.spec.binaryPath, f.root, 'linux', f.home);
    expect(() => renderUnit(spec, servicePaths(spec, 'linux'), 'linux')).toThrow(/whitespace/);
    expect(() => installService(spec, { platform: 'linux', runner: f.platform.runner })).toThrow(/whitespace/);
    expect(fs.existsSync(servicePaths(spec, 'linux').unitFile)).toBe(false);
    expect(f.platform.running.size).toBe(0);
  });
  for (const version of [SERVER_SCHEMA_VERSION - 1, SERVER_SCHEMA_VERSION + 1]) {
    it(`reports schema ${version} without modifying or recreating its volume`, async () => {
      const f = fixture();
      const db = new Database(f.paths.databasePath);
      db.query("UPDATE schema_meta SET value = ? WHERE key = 'version'").run(String(version));
      db.close();
      const before = tree(f.paths.root);
      expect((await inspectLocal(f.home, f.deps)).creation).toEqual(version > SERVER_SCHEMA_VERSION
        ? { unavailable: "this Myco is older than the server's data; update Myco" } : 'behind');
      await expect(prepareLocal(f.home, plan, f.deps)).rejects.toThrow(/update/);
      expect(tree(f.paths.root)).toEqual(before);
    });
  }
  it('refuses a disappeared database instead of creating an empty replacement', async () => {
    const f = fixture(); signIn(f);
    fs.unlinkSync(f.paths.databasePath);
    const before = tree(f.paths.root);
    await expect(prepareLocal(f.home, plan, f.deps)).rejects.toThrow('database missing');
    expect(() => createLocalDeployment(DEFAULT_LOCAL_RECORD, native, f.paths)).toThrow('database missing');
    expect(tree(f.paths.root)).toEqual(before);
  });
});

describe('owner wait', () => {
  for (const expiry of [NaN, Infinity, -Infinity, undefined]) it(`rejects non-finite expiry ${expiry} before reading the database`, async () => {
    let calls = 0;
    await expect(waitForOwnerLink(expiry!, { linked: async () => { calls++; return false; }, signal: AbortSignal.timeout(150) })).rejects.toThrow(/finite/);
    expect(calls).toBe(0);
  });
  it('uses the real delay through expiry with exactly one final database read', async () => {
    let calls = 0;
    expect(await waitForOwnerLink(Date.now() + 120, { linked: async () => { calls++; return false; } })).toBe('expired');
    expect(calls).toBe(2);
  });

  it('uses shared ownership while serving and waits for a real account link', async () => {
    const f = fixture(); signIn(f);
    const link = await setupLocalOwner(f.paths, native);
    const held = await serve(f);
    const delays: number[] = [];
    try {
      expect(await localOwnerLinked(f.paths, native)).toBe(false);
      const result = await waitForOwnerLink(link.expiresAt, { linked: () => localOwnerLinked(f.paths, native), sleep: async ms => {
        delays.push(ms);
        const sqlite = new Database(f.paths.databasePath);
        try { await spendIdentityLinkAuthority(sqliteRelationalStore(sqlite), new URL(link.url).hash.slice(1), '7890', Date.now()); }
        finally { sqlite.close(); }
      } });
      expect(result).toBe('linked');
      expect(delays).toEqual([5000]);
    } finally { await held.stop(); }
  });
  it('expires without claiming an unlinked owner, and polls only to expiry', async () => {
    let clock = 0;
    const delays: number[] = [];
    expect(await waitForOwnerLink(7000, { now: () => clock, linked: async () => false, sleep: async ms => { delays.push(ms); clock += ms; } })).toBe('expired');
    expect(delays).toEqual([5000, 2000]);
  });
  it('recognizes a link completed during the final sleep at expiry', async () => {
    let clock = 0;
    expect(await waitForOwnerLink(5000, { now: () => clock, linked: async () => clock === 5000,
      sleep: async ms => { clock += ms; } })).toBe('linked');
  });
  for (const message of ['auth refused', 'database unavailable', 'volume unavailable']) it(`stops immediately on ${message}`, async () => {
    let sleeps = 0;
    await expect(waitForOwnerLink(Date.now() + 10000, { linked: async () => { throw new Error(message); }, sleep: async () => { sleeps++; } })).rejects.toThrow(message);
    expect(sleeps).toBe(0);
  });
  it('cancels a terminal wait', async () => {
    const abort = new AbortController(); abort.abort(new Error('cancelled'));
    await expect(waitForOwnerLink(Date.now() + 10000, { linked: async () => false, signal: abort.signal })).rejects.toThrow('cancelled');
  });
});

