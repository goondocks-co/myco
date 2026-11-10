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
      await expect(prepareLocal(f.home, plan, f.deps)).rejects.toThrow(`Your Myco is running in another terminal (process ${process.pid}). Stop it there with Ctrl-C, then rerun myco server install --target local.`);
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

