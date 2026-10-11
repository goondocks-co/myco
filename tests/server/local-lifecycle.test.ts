import { afterEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';
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

const native = { library: null, vec0: null };
const homes: string[] = [];
const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
function fixture(create = true, name = 'myco') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-native-lifecycle-'));
  homes.push(root);
  const home = path.join(root, name);
  const paths = peekLocalPaths(home);
  if (create) createLocalDeployment(DEFAULT_LOCAL_RECORD, native, paths);
  const spec = defaultSpec(path.join(root, 'bin', 'myco'), root, 'darwin', home);
  const platform = nativeServicePlatform(paths, spec);
  disposers.push(platform.dispose);
  const deps: LocalPrepareDeps = { native, userHome: root, binaryPath: path.join(root, 'bin', 'myco'),
    service: { platform: 'darwin', runner: platform.runner },
    fetchImpl: Object.assign(async () => new Response('ok'), { preconnect: () => {} }),
    confirmStop: async () => true };
  return { root, home, paths, deps, platform, spec };
}
const plan: LocalPreparePlan = { port: DEFAULT_LOCAL_RECORD.port, signIn: 'skip', owner: 'mint', serve: 'service' };
function signIn(f: ReturnType<typeof fixture>) {
  writeLocalSecrets({ ...readLocalSecrets(f.paths), GITHUB_CLIENT_ID: 'test-app', GITHUB_CLIENT_SECRET: 'test-secret' }, f.paths);
}
function serve(f: ReturnType<typeof fixture>) {
  return new LocalVolume(f.paths).serve({ pending: () => false, startup: () => {},
    identity: () => volumeIdentity(f.paths.databasePath, () => null), start: async () => ({ stop: async () => {} }) });
}
function tree(root: string): unknown {
  if (!fs.existsSync(root)) return null;
  return fs.readdirSync(root).sort().map(name => {
    const file = path.join(root, name);
    return fs.statSync(file).isDirectory() ? [name, tree(file)] : [name, fs.readFileSync(file).toString('base64')];
  });
}

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
    const child = spawn(process.execPath, ['test', '--preload', path.join(repo, 'tests/setup/sandbox-preload.ts'),
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

describe('prepare native lifecycle', () => {
  it('refuses a service installed for another Myco home before any service command', async () => {
    const f = fixture(); signIn(f);
    const other = defaultSpec(f.spec.binaryPath, f.root, 'darwin', path.join(f.root, 'another-myco'));
    installService(other, f.deps.service);
    f.platform.commands.length = 0;
    const before = tree(f.root);
    await expect(prepareLocal(f.home, plan, f.deps)).rejects.toThrow('does not belong');
    expect(tree(f.root)).toEqual(before);
    expect(f.platform.commands).toEqual([]);
  });
  it('keeps an unexpired pending link during ordinary resume', async () => {
    const f = fixture(); signIn(f);
    const first = await setupLocalOwner(f.paths, native);
    installService(f.spec, f.deps.service);
    f.platform.commands.length = 0;
    expect((await prepareLocal(f.home, plan, f.deps)).ownerLink).toBeNull();
    expect(f.platform.commands.some(line => line.includes('unload'))).toBe(false);
    const sqlite = new Database(f.paths.databasePath);
    try {
      expect(await spendIdentityLinkAuthority(sqliteRelationalStore(sqlite), new URL(first.url).hash.slice(1), '3333', Date.now())).toMatchObject({ ok: true });
    } finally { sqlite.close(); }
  });
  for (const platform of ['linux', 'win32'] as const) it(`attributes a running ${platform} service to its serving process through the runner`, async () => {
    const f = fixture();
    const spec = defaultSpec(f.spec.binaryPath, f.root, platform, f.home);
    const unit = servicePaths(spec, platform);
    fs.mkdirSync(path.dirname(unit.unitFile), { recursive: true });
    fs.writeFileSync(unit.unitFile, renderUnit(spec, unit, platform));
    const held = await serve(f);
    const calls: string[] = [];
    try {
      const state = await inspectLocal(f.home, { ...f.deps, service: { platform, runner: (command, args) => {
        calls.push(command);
        return { status: 0, stdout: command === 'powershell.exe' && args.at(-1)?.includes('Get-ScheduledTask') ? 'Running' : String(process.pid) };
      } } });
      expect(state.serving).toMatchObject({ mode: 'service', pid: process.pid });
      expect(calls).toContain(platform === 'win32' ? 'powershell.exe' : 'systemctl');
    } finally { await held.stop(); }
  });
  it('stops a running service, mints while stopped, restores and proves health', async () => {
    const f = fixture(); signIn(f);
    installService(f.spec, f.deps.service);
    f.platform.commands.length = 0;
    const result = await prepareLocal(f.home, plan, f.deps);
    expect(result.ownerLink?.url).toContain('/link#');
    const commands = f.platform.commands;
    expect(commands.findIndex(line => line.startsWith('launchctl unload'))).toBeLessThan(commands.findIndex(line => line.startsWith('launchctl load')));
    expect(f.platform.running.has(f.spec.unit.label)).toBe(true);
    expect(fs.readFileSync(servicePaths(f.spec, 'darwin').unitFile, 'utf8')).toContain(f.home);
    expect((await inspectLocal(f.home, f.deps)).owner).toBe('pending-link');
  });
  it('refuses foreground exclusive work without signals or service calls', async () => {
    const f = fixture(); signIn(f);
    const held = await serve(f);
    const before = tree(f.root);
    try {
      expect((await inspectLocal(f.home, f.deps)).serving).toMatchObject({ mode: 'foreground', pid: process.pid });
      await expect(prepareLocal(f.home, plan, f.deps)).rejects.toThrow(`process ${process.pid}`);
      expect(tree(f.root)).toEqual(before);
      expect(f.platform.commands).toEqual([]);
    } finally { await held.stop(); }
  });
  it('restores a running service when owner mint fails', async () => {
    const f = fixture(); signIn(f);
    const sqlite = new Database(f.paths.databasePath);
    sqlite.exec("CREATE TRIGGER fail_mint BEFORE INSERT ON identity_link_authorities BEGIN SELECT RAISE(ABORT, 'mint failed'); END");
    sqlite.close();
    installService(f.spec, f.deps.service);
    await expect(prepareLocal(f.home, plan, f.deps)).rejects.toThrow('mint failed');
    expect(f.platform.running.has(f.spec.unit.label)).toBe(true);
    expect((await inspectLocal(f.home, f.deps)).owner).toBe('none');
  });
  it('waits for delayed service teardown before minting', async () => {
    const f = fixture(); signIn(f); installService(f.spec, f.deps.service);
    let waits = 0;
    const runner = f.platform.runner;
    const service = { ...f.deps.service, runner: (command: string, args: readonly string[]) => {
      if (args[0] === 'unload' || args[0] === 'remove') return { status: 0 };
      return runner(command, args);
    } };
    const result = await prepareLocal(f.home, plan, { ...f.deps, service, sleep: async () => {
      waits++;
      runner('launchctl', ['remove', f.spec.unit.label]);
    } });
    expect(waits).toBe(1);
    expect(result.ownerLink).not.toBeNull();
    expect(f.platform.running.has(f.spec.unit.label)).toBe(true);
  });
  it('requires consent before stopping a service', async () => {
    const f = fixture(); signIn(f);
    installService(f.spec, f.deps.service);
    f.platform.commands.length = 0;
    await expect(prepareLocal(f.home, plan, { ...f.deps, confirmStop: async () => false })).rejects.toThrow('consent');
    expect(f.platform.commands.some(line => line.includes('unload'))).toBe(false);
  });
  it('restores the prior service when the plan requests terminal serving', async () => {
    const f = fixture(); signIn(f); installService(f.spec, f.deps.service);
    await prepareLocal(f.home, { ...plan, serve: 'terminal' }, f.deps);
    expect(f.platform.running.has(f.spec.unit.label)).toBe(true);
  });
  it('creates, configures and mints before starting; reruns preserve linked ownership', async () => {
    const f = fixture(false);
    const events: string[] = [];
    const deps: LocalPrepareDeps = { ...f.deps, registerSignIn: async () => {
      events.push('sign-in');
      expect(f.platform.running.size).toBe(0);
      signIn(f);
      return { app: { slug: 'test', htmlUrl: 'https://github.com/apps/test', name: 'test', clientId: 'test', ownerLogin: null },
        callbackUrl: 'http://127.0.0.1:8787/auth/callback', verified: { ok: false, pendingStart: true, reason: 'stopped' } };
    }, fetchImpl: Object.assign(async () => {
      events.push('health');
      expect((await inspectLocal(f.home, { ...f.deps, checkRemote: false })).owner).toBe('pending-link');
      return new Response('ok');
    }, { preconnect: () => {} }) };
    const result = await prepareLocal(f.home, { ...plan, signIn: { url: 'http://127.0.0.1:8787', target: { kind: 'local', paths: f.paths } } }, deps);
    expect(events).toEqual(['sign-in', 'health']);
    const sqlite = new Database(f.paths.databasePath);
    try { await spendIdentityLinkAuthority(sqliteRelationalStore(sqlite), new URL(result.ownerLink!.url).hash.slice(1), '5678', Date.now()); }
    finally { sqlite.close(); }
    expect((await prepareLocal(f.home, plan, f.deps)).ownerLink).toBeNull();
  });
  it('waits for an external terminal server without spawning or installing one', async () => {
    const f = fixture(); signIn(f);
    const messages: string[] = [];
    let probes = 0;
    let terminal: Awaited<ReturnType<typeof serve>> | undefined;
    try { await prepareLocal(f.home, { ...plan, serve: 'terminal' }, { ...f.deps, log: line => messages.push(line), sleep: async () => {},
      fetchImpl: Object.assign(async () => {
        probes++;
        if (probes === 3) terminal = await serve(f);
        return new Response('', { status: probes < 3 ? 503 : 200 });
      }, { preconnect: () => {} }) });
    } finally { await terminal?.stop(); }
    expect(probes).toBe(3);
    expect(messages).toContain('In another terminal, run: myco server run --target local');
    expect(f.platform.commands).toEqual([]);
  });
  it('health timeout names the retained data and log path', async () => {
    const f = fixture(); signIn(f);
    let clock = 0;
    await expect(prepareLocal(f.home, plan, { ...f.deps, now: () => clock, sleep: async ms => { clock += ms; },
      fetchImpl: Object.assign(async () => new Response('', { status: 503 }), { preconnect: () => {} }) })).rejects.toThrow(servicePaths(f.spec, 'darwin').errLog);
    expect(fs.existsSync(f.paths.databasePath)).toBe(true);
  });
  it('does not credit a foreground volume holder as service readiness', async () => {
    const f = fixture(); signIn(f);
    let clock = 0;
    const runner = (command: string, args: readonly string[]) => {
      const result = f.platform.runner(command, args);
      return { ...result, stdout: result.stdout?.replace(String(process.pid), '4242') };
    };
    await expect(prepareLocal(f.home, { ...plan, owner: 'skip' }, { ...f.deps,
      service: { platform: 'darwin', runner }, now: () => clock, sleep: async ms => { clock += ms; },
    })).rejects.toThrow(servicePaths(f.spec, 'darwin').errLog);
    expect(fs.existsSync(f.paths.databasePath)).toBe(true);
  });
  for (const mode of ['service', 'terminal'] as const) it(`recovers an expired link in ${mode} mode`, async () => {
    const f = fixture(); signIn(f);
    const first = await setupLocalOwner(f.paths, native);
    expect(await waitForOwnerLink(first.expiresAt, { now: () => first.expiresAt, linked: async () => false })).toBe('expired');
    let held: Awaited<ReturnType<typeof serve>> | undefined;
    if (mode === 'service') installService(f.spec, f.deps.service);
    else held = await serve(f);
    const messages: string[] = [];
    try {
      const replacement = await recoverLocalOwnerLink(f.home, { ...plan, serve: mode }, { ...f.deps,
        log: line => {
          messages.push(line);
          if (line.startsWith('Start it again')) {
            const sqlite = new Database(f.paths.databasePath, { readonly: true });
            try { expect(sqlite.query('SELECT COUNT(*) AS n FROM identity_link_authorities').get()).toEqual({ n: 2 }); }
            finally { sqlite.close(); }
          }
        }, sleep: async () => { await held?.stop(); held = undefined; },
        fetchImpl: Object.assign(async () => {
          if (mode === 'terminal' && held === undefined) held = await serve(f);
          return new Response('ok');
        }, { preconnect: () => {} }) });
      expect(replacement.ownerLink?.memberId).toBe(first.memberId);
      expect(replacement.ownerLink?.url).not.toBe(first.url);
      if (mode === 'service') expect(f.platform.running.has(f.spec.unit.label)).toBe(true);
      else expect(messages[0]).toContain('Ctrl-C');
    } finally { await held?.stop(); }
  });
});

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
