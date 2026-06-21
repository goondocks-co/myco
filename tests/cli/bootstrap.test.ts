/**
 * Step 5 — runGlobalBootstrap + runSymbiontDetection.
 *
 * Validates the shared code path the daemon's first-start auto-bootstrap,
 * PowerManager tick, version-drift handler, and the postinstall script
 * all invoke. Asserts retired-launcher cleanup, detection gate
 * enforcement, and idempotency on a second pass.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runGlobalBootstrap,
  runSymbiontDetection,
  shouldRunGlobalBootstrap,
} from '@myco/cli/bootstrap.js';
import { loadProjectManifest } from '@myco/config/project-manifest.js';
import {
  GLOBAL_HOOK_LAUNCHER_FILENAME,
  GLOBAL_MCP_LAUNCHER_FILENAME,
} from '@myco/grove/launcher-cleanup.js';
import {
  createGrove,
  registerProjectInGrove,
  clearGroveRegistryCaches,
  listGroves,
  listRegisteredProjects,
  getDefaultGroveId,
  loadGroveRecord,
  findProjectByRoot,
} from '@myco/grove/registry.js';
import { resolveProjectBufferDirFromRoot } from '@myco/capture/buffer-location.js';
import { ensureProjectVault } from '@myco/vault/provision.js';

const PKG_ROOT = path.resolve(__dirname, '..', '..', 'packages', 'myco');

describe('runGlobalBootstrap', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevMycoHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bootstrap-'));
    prevHome = process.env.HOME;
    prevMycoHome = process.env.MYCO_HOME;
    process.env.HOME = tmpHome;
    process.env.MYCO_HOME = path.join(tmpHome, '.myco');
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevMycoHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = prevMycoHome;
  });

  it('deletes retired launcher trampolines and detects all symbionts as not-detected on a clean home', () => {
    // Seed stale launcher trampolines from a previous release so bootstrap
    // has something to clean up.
    const mycoHome = path.join(tmpHome, '.myco');
    fs.mkdirSync(mycoHome, { recursive: true });
    const launcherPath = path.join(mycoHome, GLOBAL_HOOK_LAUNCHER_FILENAME);
    const mcpLauncherPath = path.join(mycoHome, GLOBAL_MCP_LAUNCHER_FILENAME);
    fs.writeFileSync(launcherPath, '// stale launcher\n', 'utf-8');
    fs.writeFileSync(mcpLauncherPath, '// stale mcp launcher\n', 'utf-8');

    const result = runGlobalBootstrap(PKG_ROOT);

    expect(result.launchers.removed).toEqual([launcherPath, mcpLauncherPath]);
    expect(fs.existsSync(launcherPath)).toBe(false);
    expect(fs.existsSync(mcpLauncherPath)).toBe(false);
    // No agent dirs exist under tmpHome — every symbiont should be 'not-detected'.
    expect(result.symbionts.every((r) => r.status === 'not-detected')).toBe(true);
  });

  it('installs into agents whose detectionDir exists', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });

    const result = runGlobalBootstrap(PKG_ROOT);
    const claudeResult = result.symbionts.find((r) => r.symbiont === 'claude-code');
    if (claudeResult?.status === 'error') {
      throw new Error(`Unexpected install error: ${claudeResult.error}`);
    }
    expect(claudeResult?.status).toBe('installed');

    // ~/.claude/settings.json now carries Myco's hook + MCP block.
    const settings = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude', 'settings.json'), 'utf-8'));
    expect(settings.hooks).toBeDefined();
    expect(settings.mcpServers?.myco).toBeDefined();

    // Other symbionts (no detectionDir present) are 'not-detected'.
    const codexResult = result.symbionts.find((r) => r.symbiont === 'codex');
    expect(codexResult?.status).toBe('not-detected');
  });

  it('is idempotent — a second invocation removes no launchers + reports symbionts already-configured', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });

    runGlobalBootstrap(PKG_ROOT);
    const second = runGlobalBootstrap(PKG_ROOT);

    // Nothing left to clean up — the first pass deleted any stale launchers
    // (and a clean home never had them).
    expect(second.launchers.removed).toEqual([]);

    const claudeResult = second.symbionts.find((r) => r.symbiont === 'claude-code');
    expect(claudeResult?.status).toBe('already-configured');
  });
});

describe('runSymbiontDetection', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevMycoHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-detection-'));
    prevHome = process.env.HOME;
    prevMycoHome = process.env.MYCO_HOME;
    process.env.HOME = tmpHome;
    process.env.MYCO_HOME = path.join(tmpHome, '.myco');
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevMycoHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = prevMycoHome;
  });

  it('never creates an agent config dir on its behalf', () => {
    // tmpHome has no agent dirs. Detection runs but does not create them.
    runSymbiontDetection(PKG_ROOT);
    for (const dirname of ['.claude', '.codex', '.cursor', '.gemini', '.pi', '.copilot']) {
      expect(fs.existsSync(path.join(tmpHome, dirname))).toBe(false);
    }
  });

  it('emits one result per manifest, with deterministic status for missing detectionDirs', () => {
    const results = runSymbiontDetection(PKG_ROOT);
    // Every manifest gets a result. The exact count is enforced by the
    // installed manifest set — assert presence by name rather than count
    // so adding/removing a symbiont doesn't break this test silently.
    const names = new Set(results.map((r) => r.symbiont));
    expect(names.has('claude-code')).toBe(true);
    expect(names.has('codex')).toBe(true);
    expect(names.has('antigravity')).toBe(true);
    for (const r of results) expect(['installed', 'already-configured', 'not-detected', 'error']).toContain(r.status);
  });

  // Migration is fire-once-per-project (first-start + auto-Grove-create
  // + explicit `myco doctor --fix`). Running it on every PowerManager
  // tick would normalize failure as ongoing operational state. Lock the
  // boundary by seeding a registered project with a legacy
  // project-local launcher and asserting `runSymbiontDetection()`
  // leaves it intact.
  it('does not invoke the migration walker — legacy project-local launchers survive a detection pass', () => {
    clearGroveRegistryCaches();
    const prevServiceDevMode = process.env.MYCO_SERVICE_DEV_MODE;
    process.env.MYCO_SERVICE_DEV_MODE = '1';
    try {
      const grove = createGrove('default', path.join(tmpHome, '.myco'), { servedBy: 'service-dev' });
      const projectRoot = fs.mkdtempSync(path.join(tmpHome, 'legacy-proj-'));
      fs.mkdirSync(path.join(projectRoot, '.agents'), { recursive: true });
      const legacyLauncher = path.join(projectRoot, '.agents', 'myco-run.cjs');
      fs.writeFileSync(legacyLauncher, '// legacy stub\n', 'utf-8');
      fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
      fs.writeFileSync(
        path.join(projectRoot, '.myco', 'myco.yaml'),
        `version: 3\nconfig_version: 9\n`,
        'utf-8',
      );
      registerProjectInGrove(grove.id, {
        projectId: 'proj_legacy_detection',
        projectName: 'legacy-detection-fixture',
        projectRoot,
      }, path.join(tmpHome, '.myco'));

      runSymbiontDetection(PKG_ROOT);

      expect(fs.existsSync(legacyLauncher)).toBe(true);
    } finally {
      if (prevServiceDevMode === undefined) delete process.env.MYCO_SERVICE_DEV_MODE;
      else process.env.MYCO_SERVICE_DEV_MODE = prevServiceDevMode;
      clearGroveRegistryCaches();
    }
  });
});

describe('runGlobalBootstrap — default-Grove ensure (greenfield)', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  let prevMycoHome: string | undefined;
  let prevServiceVariant: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bootstrap-default-grove-'));
    prevHome = process.env.HOME;
    prevMycoHome = process.env.MYCO_HOME;
    prevServiceVariant = process.env.MYCO_SERVICE_VARIANT;
    process.env.HOME = tmpHome;
    process.env.MYCO_HOME = path.join(tmpHome, '.myco');
    delete process.env.MYCO_SERVICE_VARIANT;
    clearGroveRegistryCaches();
  });
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevMycoHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = prevMycoHome;
    if (prevServiceVariant === undefined) delete process.env.MYCO_SERVICE_VARIANT;
    else process.env.MYCO_SERVICE_VARIANT = prevServiceVariant;
    clearGroveRegistryCaches();
  });

  it('creates a default Grove on a truly greenfield home (unset variant → served_by=service)', () => {
    // Pre-condition: no Groves at all.
    expect(listGroves(path.join(tmpHome, '.myco'))).toEqual([]);
    expect(getDefaultGroveId(path.join(tmpHome, '.myco'))).toBeNull();

    const result = runGlobalBootstrap(PKG_ROOT);

    expect(result.defaultGrove).toBeDefined();
    expect(result.defaultGrove.served_by).toBe('service');
    expect(result.defaultGrove.slug).toBe('default');

    // The registry pointer now names the new Grove.
    expect(getDefaultGroveId(path.join(tmpHome, '.myco'))).toBe(result.defaultGrove.id);

    // The Grove record actually persisted to disk.
    const reloaded = loadGroveRecord(result.defaultGrove.id, path.join(tmpHome, '.myco'));
    expect(reloaded?.served_by).toBe('service');
  });

  it('creates a default Grove for variant=dev (served_by=service-dev)', () => {
    process.env.MYCO_SERVICE_VARIANT = 'dev';
    clearGroveRegistryCaches();

    const result = runGlobalBootstrap(PKG_ROOT);

    expect(result.defaultGrove.served_by).toBe('service-dev');
    expect(result.defaultGrove.slug).toBe('default');
  });

  it('also accepts MYCO_SERVICE_VARIANT=service-dev for documented daemon-dir usage', () => {
    process.env.MYCO_SERVICE_VARIANT = 'service-dev';
    clearGroveRegistryCaches();

    const result = runGlobalBootstrap(PKG_ROOT);

    expect(result.defaultGrove.served_by).toBe('service-dev');
    expect(result.defaultGrove.slug).toBe('default');
  });

  it('startup bootstrap skips when a default Grove already exists in this home', () => {
    const mycoHome = path.join(tmpHome, '.myco');
    fs.mkdirSync(mycoHome, { recursive: true });
    createGrove('default', mycoHome, { servedBy: 'service' });
    clearGroveRegistryCaches();

    // With home separation each daemon owns its own home, so the presence
    // of ANY default Grove means bootstrap has already run.
    const decision = shouldRunGlobalBootstrap(mycoHome, 'service');

    expect(decision.shouldRun).toBe(false);
    expect(decision.defaultGroveAbsent).toBe(false);
  });

  it('startup bootstrap runs when no default Grove exists in this home yet', () => {
    const mycoHome = path.join(tmpHome, '.myco');
    fs.mkdirSync(mycoHome, { recursive: true });
    clearGroveRegistryCaches();

    const decision = shouldRunGlobalBootstrap(mycoHome, 'service-dev');

    expect(decision.shouldRun).toBe(true);
    expect(decision.defaultGroveAbsent).toBe(true);
    expect(decision.servedBy).toBe('service-dev');
  });

  it('startup bootstrap does NOT re-run once this variant default Grove exists, regardless of launcher state', () => {
    // The launcher unification retired the global trampolines and bootstrap
    // deletes any that linger; launcher presence/absence is no longer a
    // bootstrap trigger. The default Grove is the sole durable signal — so a
    // stale launcher file on disk (or none) does not re-fire bootstrap.
    const mycoHome = path.join(tmpHome, '.myco');
    fs.mkdirSync(mycoHome, { recursive: true });
    fs.writeFileSync(path.join(mycoHome, GLOBAL_HOOK_LAUNCHER_FILENAME), '// stale orphan launcher\n', 'utf-8');
    createGrove('default', mycoHome, { servedBy: 'service' });
    clearGroveRegistryCaches();

    const decision = shouldRunGlobalBootstrap(mycoHome, 'service');

    expect(decision.shouldRun).toBe(false);
    expect(decision.defaultGroveAbsent).toBe(false);
  });

  it('is idempotent — second bootstrap returns the same default Grove without creating a duplicate', () => {
    const first = runGlobalBootstrap(PKG_ROOT);
    clearGroveRegistryCaches();
    const second = runGlobalBootstrap(PKG_ROOT);

    expect(second.defaultGrove.id).toBe(first.defaultGrove.id);
    expect(listGroves(path.join(tmpHome, '.myco')).length).toBe(1);
  });

  it('dev and prod variants each get a slug=default Grove in their own home', () => {
    // Prod boots in the default home.
    const prod = runGlobalBootstrap(PKG_ROOT);
    expect(prod.defaultGrove.served_by).toBe('service');
    expect(prod.defaultGrove.slug).toBe('default');

    // Dev boots in a separate home (home separation is the new coexistence
    // model; each home has exactly one daemon and one default Grove).
    const devHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bootstrap-dev-'));
    try {
      process.env.MYCO_HOME = path.join(devHome, '.myco');
      process.env.MYCO_SERVICE_VARIANT = 'dev';
      clearGroveRegistryCaches();
      const dev = runGlobalBootstrap(PKG_ROOT);
      expect(dev.defaultGrove.served_by).toBe('service-dev');
      expect(dev.defaultGrove.slug).toBe('default');
      expect(dev.defaultGrove.id).not.toBe(prod.defaultGrove.id);

      // Each home has exactly one Grove.
      expect(listGroves(path.join(tmpHome, '.myco'))).toHaveLength(1);
      expect(listGroves(path.join(devHome, '.myco'))).toHaveLength(1);
    } finally {
      fs.rmSync(devHome, { recursive: true, force: true });
    }
  });

  it('closes the greenfield + first-hook auto-register loop end-to-end', () => {
    // The full path a real user hits on Day 1:
    //   1. install Myco globally on an empty machine (no ~/.myco/ state)
    //   2. daemon starts → runGlobalBootstrap() runs
    //   3. user fires an agent hook from a git project
    //   4. capture lands without any manual `myco init` step
    //
    // The prior implementation broke at step 3: ensureProjectRegistered
    // would silently return null because no default Grove existed,
    // and capture went silent. This test asserts the full loop closes.
    const projectRoot = fs.mkdtempSync(path.join(tmpHome, 'greenfield-proj-'));
    // isSafeProjectRoot requires the project be a real git repo —
    // protects against hooks misfiring from cwd-fallback locations.
    execFileSync('git', ['init', '--quiet'], { cwd: projectRoot, stdio: 'pipe' });

    // Pre-condition: no Groves, no projects. A hook firing here would
    // silently fail to register.
    const preBootstrap = resolveProjectBufferDirFromRoot(projectRoot, path.join(tmpHome, '.myco'));
    expect(preBootstrap).toBeNull();

    // Run the bootstrap exactly as the daemon first-start does.
    runGlobalBootstrap(PKG_ROOT);

    // Now a hook fires (simulated via the same helper the hook path
    // uses): ensureProjectRegistered should succeed and the project
    // should auto-register into the default Grove.
    const defaultGrove = loadGroveRecord(getDefaultGroveId(path.join(tmpHome, '.myco'))!, path.join(tmpHome, '.myco'))!;
    expect(listRegisteredProjects(defaultGrove.id, path.join(tmpHome, '.myco'))).toEqual([]);

    const postBootstrap = resolveProjectBufferDirFromRoot(projectRoot, path.join(tmpHome, '.myco'));

    // Explicit registration assertion — the test's reason for existing
    // is that the prior implementation silently no-op'd here. Asserting
    // the buffer dir alone is not enough; verify the registry state
    // actually changed.
    expect(postBootstrap).not.toBeNull();
    const registered = findProjectByRoot(projectRoot, path.join(tmpHome, '.myco'));
    expect(registered).not.toBeNull();
    expect(registered?.grove.id).toBe(defaultGrove.id);
    expect(listRegisteredProjects(defaultGrove.id, path.join(tmpHome, '.myco'))).toHaveLength(1);
    expect(postBootstrap?.groveId).toBe(defaultGrove.id);
    expect(postBootstrap?.bufferDir).toContain(path.join(tmpHome, '.myco', 'groves', defaultGrove.id));
  });

  it('preserves the provisioned manifest identity when the first hook registers a project', () => {
    process.env.MYCO_SERVICE_VARIANT = 'service-dev';
    clearGroveRegistryCaches();
    const bootstrap = runGlobalBootstrap(PKG_ROOT);
    expect(bootstrap.defaultGrove.served_by).toBe('service-dev');

    const projectRoot = fs.mkdtempSync(path.join(tmpHome, 'born-global-proj-'));
    execFileSync('git', ['init', '--quiet'], { cwd: projectRoot, stdio: 'pipe' });

    const provisioned = ensureProjectVault(projectRoot);
    const manifest = loadProjectManifest(path.join(projectRoot, '.myco'));
    expect(manifest?.project.id).toBe(provisioned.projectId);
    expect(manifest?.grove?.binding_id).toBeDefined();
    expect(manifest?.grove?.slug).toBe('default');

    const buffer = resolveProjectBufferDirFromRoot(projectRoot, path.join(tmpHome, '.myco'));
    expect(buffer?.groveId).toBe(bootstrap.defaultGrove.id);
    expect(buffer?.projectId).toBe(provisioned.projectId);

    const registered = findProjectByRoot(projectRoot, path.join(tmpHome, '.myco'));
    expect(registered?.project.project_id).toBe(provisioned.projectId);
    expect(registered?.project.binding_id).toBe(manifest?.grove?.binding_id);
    expect(registered?.grove.id).toBe(bootstrap.defaultGrove.id);
  });

  it('dev and prod each register projects into their own home grove, never cross-home', () => {
    // With home separation, dev and prod run in separate MYCO_HOME dirs.
    // Each home has exactly one default Grove; hooks fire against the home
    // owned by that daemon and can never reach the other home's grove.

    const devHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bootstrap-dev-'));
    try {
      // Phase 1: prod daemon boots in the default home.
      const prodBootstrap = runGlobalBootstrap(PKG_ROOT);
      expect(prodBootstrap.defaultGrove.served_by).toBe('service');
      expect(prodBootstrap.defaultGrove.slug).toBe('default');

      // Phase 2: dev daemon boots in its own home.
      process.env.MYCO_HOME = path.join(devHome, '.myco');
      process.env.MYCO_SERVICE_VARIANT = 'dev';
      clearGroveRegistryCaches();
      const devBootstrap = runGlobalBootstrap(PKG_ROOT);
      expect(devBootstrap.defaultGrove.served_by).toBe('service-dev');
      expect(devBootstrap.defaultGrove.slug).toBe('default');
      expect(devBootstrap.defaultGrove.id).not.toBe(prodBootstrap.defaultGrove.id);

      // Phase 3: prod hook fires — registers into prod home's grove.
      const prodProjectRoot = fs.mkdtempSync(path.join(tmpHome, 'prod-proj-'));
      execFileSync('git', ['init', '--quiet'], { cwd: prodProjectRoot, stdio: 'pipe' });
      process.env.MYCO_HOME = path.join(tmpHome, '.myco');
      delete process.env.MYCO_SERVICE_VARIANT;
      clearGroveRegistryCaches();
      const prodBuffer = resolveProjectBufferDirFromRoot(prodProjectRoot, path.join(tmpHome, '.myco'));
      expect(prodBuffer?.groveId).toBe(prodBootstrap.defaultGrove.id);
      expect(listRegisteredProjects(prodBootstrap.defaultGrove.id, path.join(tmpHome, '.myco'))).toHaveLength(1);

      // Phase 4: dev hook fires — registers into dev home's grove.
      const devProjectRoot = fs.mkdtempSync(path.join(tmpHome, 'dev-proj-'));
      execFileSync('git', ['init', '--quiet'], { cwd: devProjectRoot, stdio: 'pipe' });
      process.env.MYCO_HOME = path.join(devHome, '.myco');
      process.env.MYCO_SERVICE_VARIANT = 'dev';
      clearGroveRegistryCaches();
      const devBuffer = resolveProjectBufferDirFromRoot(devProjectRoot, path.join(devHome, '.myco'));
      expect(devBuffer?.groveId).toBe(devBootstrap.defaultGrove.id);
      expect(listRegisteredProjects(devBootstrap.defaultGrove.id, path.join(devHome, '.myco'))).toHaveLength(1);
    } finally {
      fs.rmSync(devHome, { recursive: true, force: true });
    }
  });
});
