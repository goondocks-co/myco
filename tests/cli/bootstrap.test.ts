/**
 * Step 5 — runGlobalBootstrap + runSymbiontDetection.
 *
 * Validates the shared code path the daemon's first-start auto-bootstrap,
 * PowerManager tick, version-drift handler, and CLI `myco init` (no flag)
 * all invoke. Asserts launcher writes, detection gate enforcement, and
 * idempotency on a second pass.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runGlobalBootstrap, runSymbiontDetection } from '@myco/cli/bootstrap.js';
import {
  createGrove,
  registerProjectInGrove,
  clearGroveRegistryCaches,
  listGroves,
  getDefaultGroveId,
  loadGroveRecord,
} from '@myco/grove/registry.js';
import { resolveProjectBufferDirFromRoot } from '@myco/capture/buffer-location.js';

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

  it('writes both launchers and detects all symbionts as not-detected on a clean home', () => {
    const result = runGlobalBootstrap(PKG_ROOT);

    expect(result.launchers.written.length).toBe(2);
    expect(result.launchers.unchanged).toEqual([]);
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

  it('is idempotent — a second invocation reports launchers unchanged + symbionts already-configured', () => {
    fs.mkdirSync(path.join(tmpHome, '.claude'), { recursive: true });

    runGlobalBootstrap(PKG_ROOT);
    const second = runGlobalBootstrap(PKG_ROOT);

    expect(second.launchers.written).toEqual([]);
    expect(second.launchers.unchanged.length).toBe(2);

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

  it('creates a default-dev Grove for variant=dev (served_by=service-dev)', () => {
    process.env.MYCO_SERVICE_VARIANT = 'dev';
    clearGroveRegistryCaches();

    const result = runGlobalBootstrap(PKG_ROOT);

    expect(result.defaultGrove.served_by).toBe('service-dev');
    expect(result.defaultGrove.slug).toBe('default-dev');
  });

  it('is idempotent — second bootstrap returns the same default Grove without creating a duplicate', () => {
    const first = runGlobalBootstrap(PKG_ROOT);
    clearGroveRegistryCaches();
    const second = runGlobalBootstrap(PKG_ROOT);

    expect(second.defaultGrove.id).toBe(first.defaultGrove.id);
    expect(listGroves(path.join(tmpHome, '.myco')).length).toBe(1);
  });

  it('dev and prod variants coexist on the same machine with distinct Groves', () => {
    // First: prod boots.
    const prod = runGlobalBootstrap(PKG_ROOT);
    expect(prod.defaultGrove.served_by).toBe('service');
    expect(prod.defaultGrove.slug).toBe('default');

    // Then: dev boots on the same machine.
    process.env.MYCO_SERVICE_VARIANT = 'dev';
    clearGroveRegistryCaches();
    const dev = runGlobalBootstrap(PKG_ROOT);
    expect(dev.defaultGrove.served_by).toBe('service-dev');
    expect(dev.defaultGrove.slug).toBe('default-dev');
    expect(dev.defaultGrove.id).not.toBe(prod.defaultGrove.id);

    // Two Groves exist; each variant owns its own served_by.
    const groves = listGroves(path.join(tmpHome, '.myco'));
    expect(groves.length).toBe(2);
    expect(new Set(groves.map((g) => g.served_by))).toEqual(new Set(['service', 'service-dev']));
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
    // uses): ensureProjectRegistered should succeed, the project should
    // auto-register into the default Grove, and a buffer dir should
    // resolve under the global Grove tree.
    const postBootstrap = resolveProjectBufferDirFromRoot(projectRoot, path.join(tmpHome, '.myco'));
    expect(postBootstrap).not.toBeNull();
    expect(postBootstrap?.bufferDir).toContain(path.join(tmpHome, '.myco', 'groves'));
  });
});
