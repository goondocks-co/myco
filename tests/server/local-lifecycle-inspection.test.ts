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

describe('read-only native inspection', () => {
  it('does not create a home, locks, or migrate old target paths', async () => {
    const f = fixture(false);
    const before = tree(f.root);
    expect((await inspectLocal(f.home, f.deps)).creation).toBe('absent');
    expect(tree(f.root)).toEqual(before);
    fs.mkdirSync(path.join(f.home, 'server'), { recursive: true });
    fs.writeFileSync(path.join(f.home, 'server', 'cloudflare.json'), '{}');
    const legacy = tree(f.root);
    expect((await inspectLocal(f.home, f.deps)).creation).toBe('absent');
    expect(tree(f.root)).toEqual(legacy);
  });
  it('refuses a record whose database is absent', async () => {
    const f = fixture(false);
    writeLocalRecord(DEFAULT_LOCAL_RECORD, f.paths);
    const before = tree(f.root);
    expect((await inspectLocal(f.home, f.deps)).creation).toEqual({ unavailable: 'database missing for an existing volume; restore myco.sqlite' });
    await expect(prepareLocal(f.home, plan, f.deps)).rejects.toThrow('database missing');
    expect(() => createLocalDeployment(DEFAULT_LOCAL_RECORD, native, f.paths)).toThrow('database missing');
    expect(tree(f.root)).toEqual(before);
  });
  it('reads complete, pending and linked state without changing volume bytes', async () => {
    const f = fixture(); signIn(f);
    const link = await setupLocalOwner(f.paths, native);
    const before = tree(f.root);
    expect(await inspectLocal(f.home, f.deps)).toMatchObject({ creation: 'complete', signIn: 'configured', owner: 'pending-link' });
    expect(tree(f.root)).toEqual(before);
    const sqlite = new Database(f.paths.databasePath);
    try { await spendIdentityLinkAuthority(sqliteRelationalStore(sqlite), new URL(link.url).hash.slice(1), '1234', Date.now()); }
    finally { sqlite.close(); }
    expect((await inspectLocal(f.home, f.deps)).owner).toBe('linked');
  });
  it('shares the runtime secrets grammar, including whitespace and last-value precedence', async () => {
    const f = fixture(); signIn(f);
    const secrets = fs.readFileSync(f.paths.secretsFile, 'utf8');
    fs.writeFileSync(f.paths.secretsFile, secrets.split('\n').map(line => `  ${line}  `).join('\n'));
    expect(await inspectLocal(f.home, f.deps)).toMatchObject({ creation: 'complete', signIn: 'configured' });
    fs.appendFileSync(f.paths.secretsFile, '\nGITHUB_CLIENT_SECRET=\n');
    expect((await inspectLocal(f.home, f.deps)).signIn).toBe('absent');
  });
  it('ignores a stale serve PID that now belongs to a later process', async () => {
    const f = fixture();
    fs.writeFileSync(`${f.paths.root}.serve.lock`, JSON.stringify({ pid: process.pid, startedAt: 1 }));
    expect((await inspectLocal(f.home, f.deps)).serving.mode).toBe('stopped');
  });
  it('does not credit another HTTP listener when the volume has no live server', async () => {
    const f = fixture();
    expect((await inspectLocal(f.home, f.deps)).serving).toEqual({ mode: 'stopped', pid: null, healthy: false });
  });
  it('reports a busy database as unavailable and does not repair it', async () => {
    const f = fixture();
    const sqlite = new Database(f.paths.databasePath);
    sqlite.exec('BEGIN EXCLUSIVE');
    try { expect((await inspectLocal(f.home, f.deps)).creation).toEqual({ unavailable: 'busy' }); }
    finally { sqlite.exec('ROLLBACK'); sqlite.close(); }
  });
  it('reports unreadable record and schema as unavailable', async () => {
    const f = fixture();
    fs.writeFileSync(f.paths.recordFile, '{');
    expect((await inspectLocal(f.home, f.deps)).creation).toMatchObject({ unavailable: expect.any(String) });
    writeLocalRecord(DEFAULT_LOCAL_RECORD, f.paths);
    fs.writeFileSync(f.paths.databasePath, 'not SQLite');
    expect((await inspectLocal(f.home, f.deps)).creation).toMatchObject({ unavailable: expect.any(String) });
  });
  it('can omit all network calls for file-only observation', async () => {
    const f = fixture();
    expect((await inspectLocal(f.home, { ...f.deps, checkRemote: false,
      fetchImpl: Object.assign(async () => { throw new Error('network forbidden'); }, { preconnect: () => {} }) })).creation).toBe('complete');
  });
});

describe('sentinel-last resumable create', () => {
  for (const step of ['directory', 'secrets', 'schema'] as LocalCreateStep[]) {
    it(`interruption after ${step} leaves no sentinel and resumes preserving generated keys`, async () => {
      const f = fixture(false);
      expect(() => createLocalDeployment(DEFAULT_LOCAL_RECORD, native, f.paths, reached => {
        if (reached === step) throw new Error('interrupted');
      })).toThrow('interrupted');
      expect(fs.existsSync(f.paths.recordFile)).toBe(false);
      expect((await inspectLocal(f.home, f.deps)).creation).toMatchObject({ incomplete: expect.arrayContaining(['record']) });
      const secrets = readLocalSecrets(f.paths);
      createLocalDeployment(DEFAULT_LOCAL_RECORD, native, f.paths);
      expect((await inspectLocal(f.home, f.deps)).creation).toBe('complete');
      for (const [key, value] of Object.entries(secrets)) expect(readLocalSecrets(f.paths)[key as keyof typeof secrets]).toBe(value);
    });
  }
  for (const step of ['directory', 'secrets', 'schema', 'record', 'serve']) it(`SIGKILL after ${step} is detected and resumable`, async () => {
    const f = fixture(false);
    const repo = fileURLToPath(new URL('../../', import.meta.url));
    const childRoot = path.join(f.root, 'child');
    fs.mkdirSync(childRoot);
    const env = sandboxChildEnv(childRoot, { MYCO_TEST_RUN_ROOT: process.env.MYCO_TEST_RUN_ROOT,
      MYCO_CREATE_STOP_AFTER: step });
    const child = spawn(process.execPath, ['test', ...NESTED_BUN_TEST_TIMEOUT_ARGS, '--preload', path.join(repo, 'tests/setup/sandbox-preload.ts'),
      '--tsconfig-override', path.join(repo, 'tsconfig.json'), path.join(repo, 'tests/setup/fixtures/native_create_interruption_test.ts')],
    { env, cwd: childRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stderr?.on('data', chunk => { output += chunk; });
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
    const marker = path.join(childRoot, 'reached');
    try {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(marker) && Date.now() < deadline && child.exitCode === null) await Bun.sleep(20);
      expect({ reached: fs.existsSync(marker), output }).toEqual({ reached: true, output: expect.any(String) });
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); await exited; }
    const childHome = fs.readFileSync(marker, 'utf8');
    const childPaths = peekLocalPaths(childHome);
    const state = await inspectLocal(childHome, f.deps);
    if (step === 'record' || step === 'serve') expect(state.creation).toBe('complete');
    if (step === 'serve') expect(state.serving.mode).toBe('stopped');
    else if (step !== 'record') {
      expect(fs.existsSync(childPaths.recordFile)).toBe(false);
      expect(state.creation).toMatchObject({ incomplete: expect.arrayContaining(['record']) });
    }
    const secrets = readLocalSecrets(childPaths);
    createLocalDeployment(DEFAULT_LOCAL_RECORD, native, childPaths);
    expect((await inspectLocal(childHome, f.deps)).creation).toBe('complete');
    for (const [key, value] of Object.entries(secrets)) expect(readLocalSecrets(childPaths)[key as keyof typeof secrets]).toBe(value);
  }, 20_000);
  it('interruption after sentinel publication is already complete and retries idempotently', async () => {
    const f = fixture(false);
    expect(() => createLocalDeployment(DEFAULT_LOCAL_RECORD, native, f.paths, reached => {
      if (reached === 'record') throw new Error('interrupted');
    })).toThrow('interrupted');
    expect((await inspectLocal(f.home, f.deps)).creation).toBe('complete');
    const secrets = readLocalSecrets(f.paths);
    expect(createLocalDeployment(DEFAULT_LOCAL_RECORD, native, f.paths)).toEqual({ generated: [], applied: 0 });
    expect(readLocalSecrets(f.paths)).toEqual(secrets);
  });
});

