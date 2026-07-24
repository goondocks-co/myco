/**
 * `--serve` installer flag composite orchestrator (Task 6): the
 * `host enable --designate-default --emit-join` path `docs/install.sh`
 * drives after `myco service install` — enable, designate (Task 3's default
 * path), optionally store the team's LLM provider key, mint a one-time setup
 * key (prompting first on a re-run), and print the complete ready-to-paste
 * join command. Also covers the served-grove backup-staleness doctor
 * finding, deferred from Task 3 to here since this is where backups get
 * seeded/enabled.
 *
 * Orchestrator-level with injected seams — no network, no sudo, no real TTY.
 * The shell script itself (`docs/install.sh`) is rig-verified in Task 12.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'bun:sqlite';

import {
  hostEnableAndEmitJoin,
  type ComposeEnableDeps,
} from '@myco/team-host/compose.js';
import {
  headscaleAssetName,
  headscaleAssetUrl,
  HEADSCALE_VERSION,
  type BinaryFetcher,
  type CommandRunner,
} from '@myco/team-host/binaries.js';
import type { ServiceManager, ServiceStatus, InstallResult } from '@myco/service/types.js';

import { loadMachineConfig, saveMachineConfig, loadGroveConfig, saveGroveConfig } from '@myco/config/loader.js';
import { createSecretsOperations, readSecrets } from '@myco/config/secrets.js';
import { TEAM_AGENT_KEY_SECRET } from '@myco/constants.js';
import { resolveGroveDir, resolveGroveConfigPath, resolveGroveDbPath } from '@myco/grove/paths.js';
import { createGrove } from '@myco/grove/registry.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { createGroveBackup, seedGroveBackupDefaults } from '@myco/backup/service.js';
import { getMachineId } from '@myco/machine-id.js';
import { resolveServedGroveBackupHealth, resolveServedGroveKeyHealth as resolveServedGroveKeyHealthWith } from '@myco/daemon/host-serve.js';
import {
  checkServedGroveBackupStaleness,
  checkServedGroveKeyHealth as checkServedGroveKeyHealthWith,
} from '@myco/cli/doctor.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const { writeSecret } = createSecretsOperations(testPerUserLockNamespace);
const resolveServedGroveKeyHealth = (
  config: Parameters<typeof resolveServedGroveKeyHealthWith>[0],
  mycoHome?: string,
) => resolveServedGroveKeyHealthWith(config, mycoHome, testPerUserLockNamespace);
const checkServedGroveKeyHealth = (mycoHome?: string) =>
  checkServedGroveKeyHealthWith(mycoHome, testPerUserLockNamespace);

// ---------------------------------------------------------------------------
// Shared hermetic MYCO_HOME / MYCO_TEAM_HOME fixture (mirrors
// tests/host/designation-lifecycle.test.ts)
// ---------------------------------------------------------------------------

function withHermeticHomes(): { home: () => string; teamHome: () => string } {
  let home = '';
  let teamHome = '';
  let prevMyco: string | undefined;
  let prevTeam: string | undefined;

  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-serve-flow-'));
    home = path.join(tmp, 'myco');
    teamHome = path.join(tmp, 'team');
    fs.mkdirSync(home, { recursive: true });
    prevMyco = process.env.MYCO_HOME;
    prevTeam = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_HOME = home;
    process.env.MYCO_TEAM_HOME = teamHome;
  });
  afterEach(() => {
    if (prevMyco === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = prevMyco;
    if (prevTeam === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = prevTeam;
    fs.rmSync(path.dirname(home), { recursive: true, force: true });
  });

  return { home: () => home, teamHome: () => teamHome };
}

// ---------------------------------------------------------------------------
// hostEnableAndEmitJoin — seam-injected overlay fixtures (mirrors
// designation-lifecycle.test.ts's hostEnable fixture)
// ---------------------------------------------------------------------------

describe('hostEnableAndEmitJoin', () => {
  const { home, teamHome } = withHermeticHomes();
  let launchDaemonsDir: string;
  let brewDir: string;

  const sha256 = (b: Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
  const bytes = (s: string) => new TextEncoder().encode(s);
  const HEADSCALE_BYTES = bytes('#!/fake headscale\n');
  const TARGET = { os: 'darwin' as const, arch: 'arm64' as const };

  beforeEach(() => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-serve-flow-hostenable-'));
    launchDaemonsDir = path.join(tmp, 'LaunchDaemons');
    brewDir = path.join(tmp, 'brew');
    fs.mkdirSync(brewDir, { recursive: true });
    fs.writeFileSync(path.join(brewDir, 'tailscale'), 'ts', { mode: 0o755 });
    fs.writeFileSync(path.join(brewDir, 'tailscaled'), 'tsd', { mode: 0o755 });
  });

  function fetcher(): BinaryFetcher {
    const routes: Record<string, Uint8Array> = {
      [headscaleAssetUrl(TARGET)]: HEADSCALE_BYTES,
      [`https://github.com/juanfont/headscale/releases/download/v${HEADSCALE_VERSION}/checksums.txt`]:
        bytes(`${sha256(HEADSCALE_BYTES)}  ${headscaleAssetName(TARGET)}\n`),
    };
    return { async download(url) { const b = routes[url]; if (!b) throw new Error(`404 ${url}`); return b; } };
  }

  function baseRunner(): CommandRunner {
    const tailscaledPlist = path.join(launchDaemonsDir, 'com.tailscale.tailscaled.plist');
    return {
      async run(command, args) {
        const joined = [command, ...args].join(' ');
        if (command === 'brew' && args[0] === 'list') return { stdout: 'tailscale', exitCode: 0 };
        if (args[0] === 'version') {
          return command.endsWith('headscale')
            ? { stdout: `v${HEADSCALE_VERSION}\n`, exitCode: 0 }
            : { stdout: '1.98.8\n', exitCode: 0 };
        }
        if (joined.includes('users create')) return { stdout: '{"id":"1","name":"myco-host"}', exitCode: 0 };
        if (joined.includes('users list')) return { stdout: '[{"id":"1","name":"myco-host"}]', exitCode: 0 };
        if (joined.includes('preauthkeys create')) return { stdout: '{"key":"onetimekeyvalue123"}', exitCode: 0 };
        if (joined.includes('nodes list')) return { stdout: '[{"id":"9","name":"testhost"}]', exitCode: 0 };
        if (command === 'sudo' && args[0] === 'install') {
          fs.mkdirSync(path.dirname(args[args.length - 1]), { recursive: true });
          fs.copyFileSync(args[args.length - 2], args[args.length - 1]);
        }
        if (command === 'sudo' && args[0] === 'rm') fs.rmSync(args[args.length - 1], { force: true });
        if (joined.includes('install-system-daemon')) { fs.mkdirSync(launchDaemonsDir, { recursive: true }); fs.writeFileSync(tailscaledPlist, 'plist'); }
        if (joined.includes('uninstall-system-daemon')) fs.rmSync(tailscaledPlist, { force: true });
        return { stdout: '', exitCode: 0 };
      },
    };
  }

  function fakeManager(): ServiceManager {
    return {
      supported: true, platformName: 'launchd',
      isInstalled: async () => true,
      inspect: async () => null,
      install: async (): Promise<InstallResult> => ({ changed: false, supervisorReloaded: false }),
      uninstall: async () => {}, start: async () => {}, stop: async () => {},
      restart: async () => {},
      restartShellCommand: (l) => l,
      status: async (): Promise<ServiceStatus> => ({ installed: true, running: true, pid: 1, lastExitCode: null, unitPath: null }),
    };
  }

  /**
   * A fresh deps() bundle whose `runner` records every invocation (so tests
   * can assert on `preauthkeys create` call counts across TWO composite
   * calls) and whose `resolveOverlayIp` returns null on the first internal
   * try (fresh host node join) then the assigned IP thereafter — so a SECOND
   * call reusing the SAME `deps` object naturally resolves the IP on its
   * first try too, correctly simulating "host node already on the overlay"
   * (`hostEnable`'s own re-run idempotence, never re-minting the HOST's own
   * join key on a re-run — only `mintSetupKey`, Task 6's own step, can
   * produce a `preauthkeys create` call on that second call).
   */
  function buildDeps(overrides: Partial<ComposeEnableDeps> = {}): { deps: ComposeEnableDeps; calls: string[] } {
    const calls: string[] = [];
    const inner = baseRunner();
    const runner: CommandRunner = {
      async run(command, args) {
        calls.push([command, ...args].join(' '));
        return inner.run(command, args);
      },
    };
    const ips = [null as string | null, '100.64.0.5'];
    let call = 0;
    return {
      calls,
      deps: {
        fetcher: fetcher(),
        runner,
        platform: 'darwin',
        arch: 'arm64',
        serviceManager: fakeManager(),
        brewBinDirs: [brewDir],
        systemCtx: { launchDaemonsDir, stagingDir: path.join(os.tmpdir(), 'myco-serve-flow-staging') },
        resolveOverlayIp: async () => ips[Math.min(call++, ips.length - 1)],
        resolveNodeId: async () => 'node-9',
        verifyOverlayListener: async () => true,
        logger: () => {},
        lockNamespace: testPerUserLockNamespace,
        ...overrides,
      },
    };
  }

  const OPTS = { serverUrl: 'https://host.example:8080', hostname: 'testhost' };

  // -------------------------------------------------------------------------
  // (a) complete join command
  // -------------------------------------------------------------------------

  it('(a) composite enable emits a complete, ready-to-paste join command', async () => {
    const { deps } = buildDeps();
    const result = await hostEnableAndEmitJoin(OPTS, deps);

    expect(result.joinCommand).not.toBeNull();
    const parts = result.joinCommand!.split(' ');
    expect(parts[0]).toBe('myco');
    expect(parts[1]).toBe('join');
    expect(parts[2]).toBe(result.enable.hostId);
    expect(parts[3]).toBe('--key');
    expect(parts[4]).toBeTruthy();
    expect(parts[5]).toBe('--server-url');
    expect(parts[6]).toBe(result.enable.serverUrl);
    expect(parts[7]).toBe('--overlay-address');
    expect(parts[8]).toMatch(new RegExp(`^${result.enable.overlayAddress}:\\d+$`));
    expect(parts).toHaveLength(9);
  });

  // -------------------------------------------------------------------------
  // (b) re-run prompts before minting a fresh key
  // -------------------------------------------------------------------------

  it('(b) fresh (never-enabled) machine never prompts, even with confirmRemint injected', async () => {
    const { deps } = buildDeps();
    let confirmCalled = false;
    const confirmRemint = async () => { confirmCalled = true; return true; };
    const result = await hostEnableAndEmitJoin(OPTS, { ...deps, confirmRemint });

    expect(confirmCalled).toBe(false);
    expect(result.joinCommand).not.toBeNull();
  });

  it('(b) re-run — decline skips the re-mint: no fresh key, no join command', async () => {
    const { deps, calls } = buildDeps();
    await hostEnableAndEmitJoin(OPTS, deps);

    calls.length = 0;
    let confirmMessage: string | undefined;
    const confirmRemint = async (message: string) => { confirmMessage = message; return false; };
    const second = await hostEnableAndEmitJoin(OPTS, { ...deps, confirmRemint });

    expect(confirmMessage).toBeDefined();
    expect(second.joinCommand).toBeNull();
    expect(calls.some((c) => c.includes('preauthkeys create'))).toBe(false);
  });

  it('(b) re-run — confirming mints exactly one fresh key and emits a new join command', async () => {
    const { deps, calls } = buildDeps();
    const first = await hostEnableAndEmitJoin(OPTS, deps);

    calls.length = 0;
    let confirmed = false;
    const confirmRemint = async () => { confirmed = true; return true; };
    const second = await hostEnableAndEmitJoin(OPTS, { ...deps, confirmRemint });

    expect(confirmed).toBe(true);
    expect(second.joinCommand).not.toBeNull();
    expect(second.enable.servedGroveId).toBe(first.enable.servedGroveId); // designation immutable across re-runs
    expect(calls.filter((c) => c.includes('preauthkeys create'))).toHaveLength(1);
  });

  it('default confirm (no seam injected) declines on a non-TTY re-run — never hangs', async () => {
    const { deps } = buildDeps();
    await hostEnableAndEmitJoin(OPTS, deps);

    // No confirmRemint override — falls back to the real TTY prompt, which
    // returns false immediately on a non-TTY test runner (never blocks on
    // stdin). This is the exact behavior a piped `curl | sh` re-run relies on.
    const second = await hostEnableAndEmitJoin(OPTS, deps);
    expect(second.joinCommand).toBeNull();
  });

  // -------------------------------------------------------------------------
  // (c) designation seeds backup config on the served grove
  // -------------------------------------------------------------------------

  it('(c) designation seeds backup defaults onto the served grove config', async () => {
    const { deps } = buildDeps();
    const result = await hostEnableAndEmitJoin(OPTS, deps);

    const cfg = loadGroveConfig(result.enable.servedGroveId, home());
    expect(cfg.backup.auto_interval_hours).toBe(24);
    expect(cfg.backup.retention.keep_daily).toBe(14);
    expect(cfg.backup.retention.keep_weekly).toBe(8);
  });

  it('(c) seedGroveBackupDefaults never overwrites explicit values already on disk', () => {
    const grove = createGrove('Team Host', home());
    const current = loadGroveConfig(grove.id, home());
    saveGroveConfig(grove.id, { ...current, backup: { auto_interval_hours: 6, retention: { keep_daily: 3, keep_weekly: 1 } } }, home());

    seedGroveBackupDefaults(grove.id, home());

    const cfg = loadGroveConfig(grove.id, home());
    expect(cfg.backup.auto_interval_hours).toBe(6);
    expect(cfg.backup.retention.keep_daily).toBe(3);
    expect(cfg.backup.retention.keep_weekly).toBe(1);
  });

  it('(c) seedGroveBackupDefaults is idempotent — a second call is a no-op once seeded', () => {
    const grove = createGrove('Team Host', home());
    seedGroveBackupDefaults(grove.id, home());
    seedGroveBackupDefaults(grove.id, home());

    const cfg = loadGroveConfig(grove.id, home());
    expect(cfg.backup.auto_interval_hours).toBe(24);
    expect(cfg.backup.retention.keep_daily).toBe(14);
    expect(cfg.backup.retention.keep_weekly).toBe(8);
  });

  // -------------------------------------------------------------------------
  // (d) optional team key → served grove secrets.env, masked echo only
  // -------------------------------------------------------------------------

  it('(d) team key lands in the served grove secrets.env under the PROVIDER-STANDARD name (never TEAM_AGENT_KEY_SECRET, the transport-only name), never in YAML', async () => {
    const { deps } = buildDeps();
    const teamKey = 'sk-testkey1234567890ABCDEFGH';
    const result = await hostEnableAndEmitJoin({ ...OPTS, teamAgentKey: teamKey }, deps);

    const groveDir = resolveGroveDir(result.enable.servedGroveId, home());
    const secrets = readSecrets(groveDir);
    // Default provider is anthropic (spec §5's API-key path) — stored under
    // ANTHROPIC_API_KEY, the SAME name `missingKeyReason`/`probeProviderAvailable`
    // read, per KEYED_CLOUD_PROVIDER_ENV (Task 8's cross-task alignment fix).
    expect(secrets.ANTHROPIC_API_KEY).toBe(teamKey);
    // The CLI-flag/env-var TRANSPORT name is never the storage key.
    expect(secrets[TEAM_AGENT_KEY_SECRET]).toBeUndefined();

    const rawGroveYaml = fs.readFileSync(resolveGroveConfigPath(result.enable.servedGroveId, home()), 'utf-8');
    expect(rawGroveYaml).not.toContain(teamKey);
  });

  it('(d) --team-key-provider selects a different provider-standard storage name', async () => {
    const { deps } = buildDeps();
    const teamKey = 'sk-testkey1234567890ABCDEFGH';
    const result = await hostEnableAndEmitJoin(
      { ...OPTS, teamAgentKey: teamKey, teamKeyProvider: 'openai' },
      deps,
    );

    const groveDir = resolveGroveDir(result.enable.servedGroveId, home());
    const secrets = readSecrets(groveDir);
    expect(secrets.MYCO_OPENAI_API_KEY).toBe(teamKey);
    expect(secrets.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('(d) team key echo is masked (first-8+last-4) — the raw value never appears in the result', async () => {
    const { deps } = buildDeps();
    const teamKey = 'sk-testkey1234567890ABCDEFGH';
    const result = await hostEnableAndEmitJoin({ ...OPTS, teamAgentKey: teamKey }, deps);

    expect(result.teamAgentKeyMasked).not.toBeNull();
    expect(result.teamAgentKeyMasked).toStartWith(teamKey.slice(0, 8));
    expect(result.teamAgentKeyMasked).toEndWith(teamKey.slice(-4));
    expect(result.teamAgentKeyMasked).not.toContain(teamKey.slice(8, -4));
    expect(result.teamAgentKeyMasked).not.toBe(teamKey);
  });

  it('(d) no team key supplied → nothing written, masked echo is null', async () => {
    const { deps } = buildDeps();
    const result = await hostEnableAndEmitJoin(OPTS, deps);

    expect(result.teamAgentKeyMasked).toBeNull();
    const groveDir = resolveGroveDir(result.enable.servedGroveId, home());
    const secrets = readSecrets(groveDir);
    expect(secrets[TEAM_AGENT_KEY_SECRET]).toBeUndefined();
    expect(secrets.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Served-grove backup staleness (deferred from Task 3 — this is where
// backups get seeded/enabled)
// ---------------------------------------------------------------------------

describe('resolveServedGroveBackupHealth / checkServedGroveBackupStaleness (doctor)', () => {
  const { home } = withHermeticHomes();

  function designate(groveId: string): void {
    const machine = loadMachineConfig(home());
    saveMachineConfig({
      ...machine,
      daemon: { ...machine.daemon, host_serve: { ...machine.daemon.host_serve, enabled: true, served_grove_id: groveId } },
    }, home());
  }

  it('serving disabled → not_applicable, no doctor row', async () => {
    expect(resolveServedGroveBackupHealth(loadMachineConfig(home()), home())).toEqual({ kind: 'not_applicable' });
    expect(await checkServedGroveBackupStaleness(home())).toBeNull();
  });

  it('enabled, undesignated → not_applicable, no doctor row', async () => {
    const machine = loadMachineConfig(home());
    saveMachineConfig({ ...machine, daemon: { ...machine.daemon, host_serve: { ...machine.daemon.host_serve, enabled: true, served_grove_id: null } } }, home());

    expect(resolveServedGroveBackupHealth(loadMachineConfig(home()), home())).toEqual({ kind: 'not_applicable' });
    expect(await checkServedGroveBackupStaleness(home())).toBeNull();
  });

  it('enabled, dangling designation → not_applicable here (checkServedGroveDesignation owns that warning)', async () => {
    designate(`grove_${'9'.repeat(32)}`);

    expect(resolveServedGroveBackupHealth(loadMachineConfig(home()), home())).toEqual({ kind: 'not_applicable' });
    expect(await checkServedGroveBackupStaleness(home())).toBeNull();
  });

  it('designated, no backup ever created → stale, doctor warns naming the served grove', async () => {
    const grove = createGrove('Team Host', home());
    designate(grove.id);

    expect(resolveServedGroveBackupHealth(loadMachineConfig(home()), home())).toEqual({ kind: 'stale', servedGroveId: grove.id });

    const check = await checkServedGroveBackupStaleness(home());
    expect(check).not.toBeNull();
    expect(check!.status).toBe('warn');
    expect(check!.detail).toContain(grove.id);
  });

  it('designated, a fresh backup exists for this machine → ok, no doctor row', async () => {
    const grove = createGrove('Team Host', home());
    ensureGroveDatabase(grove.id, home());
    const db: Database = openDatabase(resolveGroveDbPath(grove.id, home()));
    createSchema(db);
    createGroveBackup({ groveId: grove.id, db, machineId: getMachineId(), mycoHome: home() });
    db.close();
    designate(grove.id);

    expect(resolveServedGroveBackupHealth(loadMachineConfig(home()), home())).toEqual({ kind: 'ok', servedGroveId: grove.id });
    expect(await checkServedGroveBackupStaleness(home())).toBeNull();
  });

  it('designated, only ANOTHER machine has a backup → still stale (staleness is per-machine, like the auto-backup gate itself)', async () => {
    const grove = createGrove('Team Host', home());
    ensureGroveDatabase(grove.id, home());
    const db: Database = openDatabase(resolveGroveDbPath(grove.id, home()));
    createSchema(db);
    createGroveBackup({ groveId: grove.id, db, machineId: 'some-other-machine', mycoHome: home() });
    db.close();
    designate(grove.id);

    expect(resolveServedGroveBackupHealth(loadMachineConfig(home()), home())).toEqual({ kind: 'stale', servedGroveId: grove.id });
  });
});

// ---------------------------------------------------------------------------
// Served-grove team-key posture (Task 7 — server-mode design spec §5): the
// same "no team key configured" condition the scheduler's
// `gateScheduledDispatch` suppresses dispatch on, surfaced on demand for an
// operator running `myco doctor`.
// ---------------------------------------------------------------------------

describe('resolveServedGroveKeyHealth / checkServedGroveKeyHealth (doctor)', () => {
  const { home } = withHermeticHomes();

  // Isolate from whatever the host shell happens to export — these tests
  // assert on the ABSENCE of a key, so a real ANTHROPIC_API_KEY in the
  // ambient dev/CI environment must never leak in.
  const KEY_ENV_VARS = ['ANTHROPIC_API_KEY', 'MYCO_OPENAI_API_KEY', 'OPENAI_API_KEY', 'MYCO_OPENROUTER_API_KEY'];
  let savedKeyEnv: Record<string, string | undefined>;
  beforeEach(() => {
    savedKeyEnv = {};
    for (const k of KEY_ENV_VARS) { savedKeyEnv[k] = process.env[k]; delete process.env[k]; }
  });
  afterEach(() => {
    for (const k of KEY_ENV_VARS) {
      if (savedKeyEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedKeyEnv[k];
    }
  });

  function designate(groveId: string): void {
    const machine = loadMachineConfig(home());
    saveMachineConfig({
      ...machine,
      daemon: { ...machine.daemon, host_serve: { ...machine.daemon.host_serve, enabled: true, served_grove_id: groveId } },
    }, home());
  }

  function setGroveProvider(groveId: string, type: 'anthropic' | 'openai' | 'openrouter' | 'ollama'): void {
    const grove = loadGroveConfig(groveId, home());
    saveGroveConfig(groveId, { ...grove, agent: { ...grove.agent, provider: { type } } }, home());
  }

  it('serving disabled → not_applicable, no doctor row', async () => {
    expect(resolveServedGroveKeyHealth(loadMachineConfig(home()), home())).toEqual({ kind: 'not_applicable' });
    expect(await checkServedGroveKeyHealth(home())).toBeNull();
  });

  it('enabled, undesignated → not_applicable, no doctor row', async () => {
    const machine = loadMachineConfig(home());
    saveMachineConfig({ ...machine, daemon: { ...machine.daemon, host_serve: { ...machine.daemon.host_serve, enabled: true, served_grove_id: null } } }, home());

    expect(resolveServedGroveKeyHealth(loadMachineConfig(home()), home())).toEqual({ kind: 'not_applicable' });
    expect(await checkServedGroveKeyHealth(home())).toBeNull();
  });

  it('designated, no explicit provider configured → not_applicable (claude-sdk subscription default needs no key)', async () => {
    const grove = createGrove('Team Host', home());
    designate(grove.id);

    expect(resolveServedGroveKeyHealth(loadMachineConfig(home()), home())).toEqual({ kind: 'not_applicable' });
    expect(await checkServedGroveKeyHealth(home())).toBeNull();
  });

  it('designated, cloud provider configured, no key anywhere → missing_key, doctor warns naming the served grove', async () => {
    const grove = createGrove('Team Host', home());
    designate(grove.id);
    setGroveProvider(grove.id, 'anthropic');

    expect(resolveServedGroveKeyHealth(loadMachineConfig(home()), home())).toEqual({ kind: 'missing_key', servedGroveId: grove.id });

    const check = await checkServedGroveKeyHealth(home());
    expect(check).not.toBeNull();
    expect(check!.status).toBe('warn');
    expect(check!.detail).toContain(grove.id);
    expect(check!.detail).toContain('no team key configured');
  });

  it('designated, cloud provider configured, key present in the grove secrets.env → ok, no doctor row', async () => {
    const grove = createGrove('Team Host', home());
    designate(grove.id);
    setGroveProvider(grove.id, 'anthropic');
    writeSecret(resolveGroveDir(grove.id, home()), 'ANTHROPIC_API_KEY', 'sk-ant-team-key');

    expect(resolveServedGroveKeyHealth(loadMachineConfig(home()), home())).toEqual({ kind: 'ok', servedGroveId: grove.id });
    expect(await checkServedGroveKeyHealth(home())).toBeNull();
  });

  it('designated, local provider (ollama) configured → ok — never needs a stored key', async () => {
    const grove = createGrove('Team Host', home());
    designate(grove.id);
    setGroveProvider(grove.id, 'ollama');

    expect(resolveServedGroveKeyHealth(loadMachineConfig(home()), home())).toEqual({ kind: 'ok', servedGroveId: grove.id });
    expect(await checkServedGroveKeyHealth(home())).toBeNull();
  });
});
