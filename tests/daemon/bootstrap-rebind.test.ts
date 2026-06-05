/**
 * Greenfield daemon → first-project rebind invariant.
 *
 * Task #1 (commit 30fbad6e) added phantom-bootstrap mode: the daemon
 * starts in the directory returned by `resolvePhantomBootstrapVaultDir()`
 * (currently `~/.myco/_unbound-bootstrap/`, renamed in 357f9125) against
 * a synthetic project manifest so the API surface can come up before
 * any real project is registered.
 * A registry-poll watcher (every 5s) detects the first hook-driven
 * project auto-registration and triggers a graceful restart — the next
 * boot resolves a real vault via `resolveBootstrapVaultDir()`. This
 * rebind path is for the VARIANT-LESS greenfield daemon only; the global
 * (MYCO_SERVICE_VARIANT-set) daemon never rebinds — see the
 * "global (variant-pinned) daemon is always home-scoped" block below and
 * the watcher guard in daemon/main.ts.
 *
 * Two failure modes are the focus here:
 *
 *   1. The rebind transition itself: before any project is registered,
 *      `resolveBootstrapVaultDir()` returns null (greenfield contract).
 *      AFTER a project lands in the registry, the same call must return
 *      the real project vault — that's the signal the watcher uses to
 *      decide to schedule a SIGTERM.
 *
 *   2. The phantom path must NOT leak into anything project-scoped once
 *      a real project is reachable. `resolveBootstrapVaultDirOrPhantom()`
 *      flipping back to `isPhantom: false` is the contract; any persisted
 *      artifact whose path string starts with the resolver's output
 *      after a rebind would mean a write happened against a scope that
 *      no longer represents a project.
 *
 * Test #1 (phantom-mode startup) from the original spec is already
 * covered in `tests/vault/bootstrap.test.ts` — see "phantom helper
 * falls back to MYCO_HOME scratch dir on greenfield". This file
 * focuses on the rebind invariants and the variant-aware filter that
 * test doesn't reach. (Test #4 of the original spec — "variant-pinned
 * throws on greenfield" — was invalidated by Task #6 in commit
 * 2cb70c6c, which flipped variant-pinned greenfield to phantom mode
 * to break the launchd respawn loop on the publication path.)
 *
 * NOTE: the rebind watcher in `daemon/main.ts:2130` is wired around a
 * 5-second `setInterval` and a `SIGTERM` 250ms after the registry probe
 * resolves. We do NOT actually spawn the daemon here — that would be a
 * 5-second-bounded integration test for one assertion. Instead we
 * exercise the resolver logic that the watcher polls, plus the
 * `bootstrapVaultDir` ↔ `isPhantom` couple the daemon-startup branch
 * downstream of `resolveBootstrapVaultDirOrPhantom()` keys off of.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveBootstrapVaultDir,
  resolveBootstrapVaultDirOrPhantom,
  resolvePhantomBootstrapVaultDir,
} from '../../packages/myco/src/vault/bootstrap';
import { resolveDaemonDataPaths } from '../../packages/myco/src/daemon/data-paths';
import {
  resolveDaemonServiceState,
  resolveDaemonLogDir,
} from '../../packages/myco/src/daemon/service-state';
import { resolveServiceDir } from '../../packages/myco/src/grove/paths';

let originalHome: string | undefined;
let originalVariant: string | undefined;
let tmpHome: string;
let tmpCwd: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-rebind-home-'));
  tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-rebind-cwd-'));
  originalHome = process.env.MYCO_HOME;
  originalVariant = process.env.MYCO_SERVICE_VARIANT;
  process.env.MYCO_HOME = tmpHome;
  delete process.env.MYCO_SERVICE_VARIANT;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = originalHome;
  if (originalVariant === undefined) delete process.env.MYCO_SERVICE_VARIANT;
  else process.env.MYCO_SERVICE_VARIANT = originalVariant;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  fs.rmSync(tmpCwd, { recursive: true, force: true });
});

function writeRegistry(defaultGroveId: string): void {
  fs.mkdirSync(path.join(tmpHome, 'groves'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpHome, 'groves', 'registry.yaml'),
    `default_grove_id: ${defaultGroveId}\n`,
  );
}

function writeGroveToml(groveId: string, servedBy: 'service' | 'service-dev'): void {
  const dir = path.join(tmpHome, 'groves', groveId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'grove.toml'),
    `[grove]\nid = "${groveId}"\nname = "${groveId}"\nslug = "${groveId}"\nmode = "local"\ncreated_at = "2026-01-01T00:00:00.000Z"\nserved_by = "${servedBy}"\n`,
  );
}

function writeProjectsToml(groveId: string, rows: Array<{ id: string; root: string }>): void {
  const dir = path.join(tmpHome, 'groves', groveId, 'registry');
  fs.mkdirSync(dir, { recursive: true });
  const body = rows
    .map(
      (r) =>
        `[projects.${r.id}]\nproject_id = "${r.id}"\nname = "test"\nroot = "${r.root}"\nbinding_id = "gbind_${r.id}"\ncreated_at = "2026-01-01T00:00:00.000Z"\nupdated_at = "2026-01-01T00:00:00.000Z"\n`,
    )
    .join('\n');
  fs.writeFileSync(path.join(dir, 'projects.toml'), body);
}

function makeProjectOnDisk(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `myco-rebind-proj-${name}-`));
  fs.mkdirSync(path.join(root, '.myco'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.myco', 'project.toml'),
    '[project]\nid = "proj_test"\n',
  );
  return root;
}

describe('greenfield phantom → real-project rebind transition', () => {
  test('resolver flips from null to real-vault path when first project lands in registry', () => {
    // BEFORE: empty registry, variant-less, cwd has no project. Greenfield.
    expect(resolveBootstrapVaultDir(tmpCwd)).toBeNull();

    // AFTER: simulate the hook-driven auto-Grove-create writing the
    // first project under the default Grove. The watcher's next 5s tick
    // would observe this as a non-null resolver result and schedule a
    // rebind shutdown.
    const groveId = 'grove_11111111111111111111111111111111';
    const projRoot = makeProjectOnDisk('rebind-target');
    try {
      writeRegistry(groveId);
      writeGroveToml(groveId, 'service');
      writeProjectsToml(groveId, [{ id: 'proj_rebind', root: projRoot }]);

      const after = resolveBootstrapVaultDir(tmpCwd);
      expect(after).toBe(path.join(projRoot, '.myco'));
    } finally {
      fs.rmSync(projRoot, { recursive: true, force: true });
    }
  });

  test('phantom helper flips isPhantom=true → false across the rebind without intermediate state', () => {
    // First call lands in phantom mode and materializes the phantom
    // scratch dir. The daemon's `bootstrapIsPhantom` branch off this
    // result is what enables the rebind watcher in main.ts.
    const before = resolveBootstrapVaultDirOrPhantom(tmpCwd);
    expect(before.isPhantom).toBe(true);
    expect(before.vaultDir).toBe(resolvePhantomBootstrapVaultDir(tmpHome));

    // Simulate first-project registration (post-rebind, the new daemon
    // process re-runs `resolveBootstrapVaultDirOrPhantom()` from
    // scratch — we mirror that here by calling again).
    const groveId = 'grove_22222222222222222222222222222222';
    const projRoot = makeProjectOnDisk('rebind-flip');
    try {
      writeRegistry(groveId);
      writeGroveToml(groveId, 'service');
      writeProjectsToml(groveId, [{ id: 'proj_flip', root: projRoot }]);

      const after = resolveBootstrapVaultDirOrPhantom(tmpCwd);
      expect(after.isPhantom).toBe(false);
      expect(after.vaultDir).toBe(path.join(projRoot, '.myco'));
      // The flipped vault MUST NOT be inside the phantom scratch dir.
      // That's the leak invariant — even if the phantom dir still
      // exists on disk (it's persisted intentionally so the synthetic
      // project id stays stable for the in-flight phantom mode), the
      // resolver hands out the real path.
      expect(after.vaultDir.startsWith(resolvePhantomBootstrapVaultDir(tmpHome))).toBe(false);
    } finally {
      fs.rmSync(projRoot, { recursive: true, force: true });
    }
  });
});

describe('no phantom leak after rebind', () => {
  test('post-rebind resolver does NOT return any path under the phantom dir', () => {
    // Land in phantom mode first to ensure the phantom dir exists on
    // disk — the leak risk is having a stale path string that points
    // into a dir that *still exists*.
    const phantom = resolveBootstrapVaultDirOrPhantom(tmpCwd);
    expect(phantom.isPhantom).toBe(true);
    expect(fs.existsSync(phantom.vaultDir)).toBe(true);

    // Now register a real project — same shape as the hook-driven
    // auto-create.
    const groveId = 'grove_33333333333333333333333333333333';
    const projRoot = makeProjectOnDisk('leak-check');
    try {
      writeRegistry(groveId);
      writeGroveToml(groveId, 'service');
      writeProjectsToml(groveId, [{ id: 'proj_leak', root: projRoot }]);

      // Every post-rebind resolution must hand back the real vault.
      // Loop a few times to catch any stale-cache regression — the
      // resolver is intentionally cacheless today; if a future
      // refactor adds memoization keyed on a single-process lifetime,
      // this assertion catches the resulting "phantom-sticky" bug.
      for (let i = 0; i < 3; i++) {
        const result = resolveBootstrapVaultDirOrPhantom(tmpCwd);
        expect(result.isPhantom).toBe(false);
        expect(result.vaultDir).toBe(path.join(projRoot, '.myco'));
        expect(result.vaultDir.startsWith(resolvePhantomBootstrapVaultDir(tmpHome))).toBe(false);
      }
    } finally {
      fs.rmSync(projRoot, { recursive: true, force: true });
    }
  });

  test('phantom dir still exists on disk post-rebind (intentional) but carries no project id', () => {
    // The phantom scratch dir persists (machine id, secrets, myco.yaml) but
    // NEVER carries a fabricated project id — the daemon's anchor is the
    // project-less daemon-global context. The resolver must also stop
    // surfacing the phantom dir once a real project registers.
    const phantomPath = resolvePhantomBootstrapVaultDir(tmpHome);
    // Force materialization of the phantom dir.
    resolveBootstrapVaultDirOrPhantom(tmpCwd);
    expect(fs.existsSync(phantomPath)).toBe(true);
    expect(fs.existsSync(path.join(phantomPath, 'project.toml'))).toBe(false);

    // Rebind.
    const groveId = 'grove_44444444444444444444444444444444';
    const projRoot = makeProjectOnDisk('phantom-persists');
    try {
      writeRegistry(groveId);
      writeGroveToml(groveId, 'service');
      writeProjectsToml(groveId, [{ id: 'proj_persist', root: projRoot }]);

      const after = resolveBootstrapVaultDirOrPhantom(tmpCwd);
      expect(after.vaultDir).not.toBe(phantomPath);

      // Phantom scratch dir still exists on disk (the rebind does NOT clean
      // it) but still carries no project id — no fabricated tenancy survives.
      expect(fs.existsSync(phantomPath)).toBe(true);
      expect(fs.existsSync(path.join(phantomPath, 'project.toml'))).toBe(false);
    } finally {
      fs.rmSync(projRoot, { recursive: true, force: true });
    }
  });
});

describe('rebind precondition — the watcher polls resolveBootstrapVaultDir, not the phantom helper', () => {
  test('plain resolver (no phantom fallback) returns null in greenfield — this is the watcher signal', () => {
    // The watcher in daemon/main.ts:2137 calls
    // `resolveBootstrapVaultDir()` (NOT the *OrPhantom helper) on
    // every tick. Null means "no rebind yet, keep waiting"; a non-null
    // value triggers `rebindShutdown()`. This test pins that contract.
    expect(resolveBootstrapVaultDir(tmpCwd)).toBeNull();

    // Phantom dir existing on disk must NOT make the plain resolver
    // return non-null — that would cause an infinite restart loop
    // (every boot rebinds immediately to the phantom path, which on
    // the next boot is no longer a registered project, so it falls
    // back to phantom again...).
    fs.mkdirSync(resolvePhantomBootstrapVaultDir(tmpHome), { recursive: true });
    fs.writeFileSync(
      path.join(resolvePhantomBootstrapVaultDir(tmpHome), 'project.toml'),
      '[project]\nid = "proj_phantom_dangling"\n',
    );
    expect(resolveBootstrapVaultDir(tmpCwd)).toBeNull();
  });

  test('plain resolver returns the real vault as soon as registry has a project — what the watcher fires on', () => {
    expect(resolveBootstrapVaultDir(tmpCwd)).toBeNull();

    const groveId = 'grove_55555555555555555555555555555555';
    const projRoot = makeProjectOnDisk('watcher-fire');
    try {
      writeRegistry(groveId);
      writeGroveToml(groveId, 'service');
      writeProjectsToml(groveId, [{ id: 'proj_fire', root: projRoot }]);
      const resolved = resolveBootstrapVaultDir(tmpCwd);
      expect(resolved).toBe(path.join(projRoot, '.myco'));
      // Sanity: the watcher's `if (!resolved) return;` guard would now
      // fall through to `rebindShutdown()` — there's no further check
      // it does before SIGTERMing the process.
      expect(resolved).not.toBeNull();
    } finally {
      fs.rmSync(projRoot, { recursive: true, force: true });
    }
  });
});

/**
 * Global (variant-pinned) daemon: always home-scoped, NEVER rebinds.
 *
 * Production user path: `npm install -g` → postinstall registers a
 * managed service → launchd/systemd spawns the daemon with
 * `MYCO_SERVICE_VARIANT` set. The global, multi-tenant daemon has NO
 * bootstrap project at all — its home is MYCO_HOME and it serves every
 * tenant through the per-request `MycoRequestContext`. So it always boots
 * phantom (home-scoped) and stays that way for its whole lifetime, whether
 * the registry is empty or full.
 *
 * The old behavior — anchoring to (and rebinding to) the *first registered
 * project* matching the variant — was the bug-attractor that every
 * tenant-scope leak we just fixed leaked *to*. This block locks the new
 * contract: the variant path returns null regardless of registry state, so
 * `resolveBootstrapVaultDir` is the watcher signal that NEVER fires for the
 * global daemon (the daemon's rebind watcher is skipped entirely when
 * MYCO_SERVICE_VARIANT is set — see daemon/main.ts).
 */
describe('global (variant-pinned) daemon is always home-scoped and never rebinds', () => {
  test('prod variant on empty registry enters phantom mode (does not throw, does not respawn-loop)', () => {
    process.env.MYCO_SERVICE_VARIANT = 'prod';
    try {
      const result = resolveBootstrapVaultDirOrPhantom(tmpCwd);
      expect(result.isPhantom).toBe(true);
      expect(result.vaultDir).toBe(resolvePhantomBootstrapVaultDir(tmpHome));
      expect(fs.existsSync(result.vaultDir)).toBe(true);
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
    }
  });

  test('dev variant on empty registry enters phantom mode (matches prod-variant behavior)', () => {
    process.env.MYCO_SERVICE_VARIANT = 'dev';
    try {
      const result = resolveBootstrapVaultDirOrPhantom(tmpCwd);
      expect(result.isPhantom).toBe(true);
      expect(result.vaultDir).toBe(resolvePhantomBootstrapVaultDir(tmpHome));
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
    }
  });

  test('dev variant stays home-scoped (null) even when a matching dev Grove is registered', () => {
    // The whole point: the global dev daemon does NOT rebind to a dev
    // project. With a fully-registered dev Grove + project on disk, the
    // plain resolver still returns null — the watcher signal never fires.
    const prodGrove = 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const devGrove = 'grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const prodRoot = makeProjectOnDisk('cross-variant-prod');
    const devRoot = makeProjectOnDisk('cross-variant-dev');
    process.env.MYCO_SERVICE_VARIANT = 'dev';
    try {
      // Phase 1: only prod Grove registered. Resolver returns null.
      writeRegistry(prodGrove);
      writeGroveToml(prodGrove, 'service');
      writeProjectsToml(prodGrove, [{ id: 'proj_p', root: prodRoot }]);
      expect(resolveBootstrapVaultDir(tmpCwd)).toBeNull();

      // Phase 2: dev Grove registered alongside the prod one. The global
      // daemon STILL returns null — it never anchors to a project.
      writeGroveToml(devGrove, 'service-dev');
      writeProjectsToml(devGrove, [{ id: 'proj_d', root: devRoot }]);
      expect(resolveBootstrapVaultDir(tmpCwd)).toBeNull();
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
      fs.rmSync(prodRoot, { recursive: true, force: true });
      fs.rmSync(devRoot, { recursive: true, force: true });
    }
  });

  test('prod variant stays home-scoped (null) even when a matching prod default Grove is registered', () => {
    // Symmetric to the dev case: the global prod daemon never anchors to a
    // registered prod project. Whether the default Grove is dev-served
    // (always skipped) or prod-served (the old anchor target), the global
    // path returns null and runs phantom from MYCO_HOME.
    const prodGrove = 'grove_cccccccccccccccccccccccccccccccc';
    const devGrove = 'grove_dddddddddddddddddddddddddddddddd';
    const prodRoot = makeProjectOnDisk('symm-prod');
    const devRoot = makeProjectOnDisk('symm-dev');
    process.env.MYCO_SERVICE_VARIANT = 'prod';
    try {
      // Phase 1: dev Grove registered as default — null (as before).
      writeRegistry(devGrove);
      writeGroveToml(devGrove, 'service-dev');
      writeProjectsToml(devGrove, [{ id: 'proj_d', root: devRoot }]);
      expect(resolveBootstrapVaultDir(tmpCwd)).toBeNull();

      // Phase 2: prod Grove registered AS DEFAULT. Pre-change this was the
      // anchor the prod daemon bound to; now it stays home-scoped (null).
      writeRegistry(prodGrove);
      writeGroveToml(prodGrove, 'service');
      writeProjectsToml(prodGrove, [{ id: 'proj_p', root: prodRoot }]);
      expect(resolveBootstrapVaultDir(tmpCwd)).toBeNull();
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
      fs.rmSync(prodRoot, { recursive: true, force: true });
      fs.rmSync(devRoot, { recursive: true, force: true });
    }
  });

  test('variant-pinned OrPhantom stays isPhantom=true even when a matching Grove registers', () => {
    // End-to-end through the helper the daemon actually uses on startup.
    // The global daemon's bootstrap result is phantom before AND after a
    // matching-variant Grove registers — it never flips to a project vault.
    const devGrove = 'grove_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const devRoot = makeProjectOnDisk('e2e-dev');
    process.env.MYCO_SERVICE_VARIANT = 'dev';
    try {
      const before = resolveBootstrapVaultDirOrPhantom(tmpCwd);
      expect(before.isPhantom).toBe(true);
      expect(before.vaultDir).toBe(resolvePhantomBootstrapVaultDir(tmpHome));

      writeRegistry(devGrove);
      writeGroveToml(devGrove, 'service-dev');
      writeProjectsToml(devGrove, [{ id: 'proj_d', root: devRoot }]);

      const after = resolveBootstrapVaultDirOrPhantom(tmpCwd);
      // Still phantom, still home-scoped — the global daemon is not a
      // registry project root.
      expect(after.isPhantom).toBe(true);
      expect(after.vaultDir).toBe(resolvePhantomBootstrapVaultDir(tmpHome));
      expect(after.vaultDir).not.toBe(path.join(devRoot, '.myco'));
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
      fs.rmSync(devRoot, { recursive: true, force: true });
    }
  });
});

/**
 * Global-daemon phantom bootstrap → home-scoped data/service/log paths.
 *
 * This is the consumer-side proof for the bootstrap change: feeding the
 * global daemon's phantom `bootstrapVaultDir` into the same resolvers
 * `daemon/main.ts` calls at startup yields:
 *   - a phantom bootstrap (`isPhantom: true`) whose vault is the
 *     home-scoped `_unbound-bootstrap` dir, NOT any registry project root;
 *   - a boot DB under that phantom home (so the daemon's own logs/state
 *     never land in an arbitrary tenant's DB);
 *   - service-state + log dir under `~/.myco/service/` (keyed off
 *     MYCO_HOME + variant, never off the project).
 */
describe('global daemon phantom bootstrap resolves home-scoped service/log/data paths', () => {
  test('boot DB is under the phantom home and NOT a registry project root', () => {
    // A fully-registered prod Grove + project exists on disk — the old
    // anchor would have made this the boot vault. The global daemon must
    // ignore it.
    const prodGrove = 'grove_abababababababababababababababab';
    const projRoot = makeProjectOnDisk('global-boot-db');
    process.env.MYCO_SERVICE_VARIANT = 'prod';
    try {
      writeRegistry(prodGrove);
      writeGroveToml(prodGrove, 'service');
      writeProjectsToml(prodGrove, [{ id: 'proj_boot', root: projRoot }]);

      const boot = resolveBootstrapVaultDirOrPhantom(tmpCwd);
      expect(boot.isPhantom).toBe(true);
      expect(boot.vaultDir).toBe(resolvePhantomBootstrapVaultDir(tmpHome));
      // The would-be anchor project root is never the boot vault.
      expect(boot.vaultDir).not.toBe(path.join(projRoot, '.myco'));

      // The boot DB resolves under the phantom home — not the project. The
      // daemon passes { daemonGlobal: isPhantom } so the anchor context is the
      // project-less daemon-global shape (mirrors daemon/main.ts).
      const dataPaths = resolveDaemonDataPaths(
        boot.vaultDir,
        { MYCO_HOME: tmpHome, MYCO_MACHINE_ID: 'machine-test' },
        { daemonGlobal: boot.isPhantom },
      );
      expect(dataPaths.databasePath.startsWith(boot.vaultDir)).toBe(true);
      expect(dataPaths.databasePath.startsWith(projRoot)).toBe(false);
      // The daemon-global anchor carries NO project and NO Grove binding —
      // no fabricated phantom project id.
      expect(dataPaths.requestContext.projectId).toBeNull();
      expect(dataPaths.requestContext.groveId).toBeNull();
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
      fs.rmSync(projRoot, { recursive: true, force: true });
    }
  });

  test('service-state and log dir resolve under ~/.myco/service/ for the phantom global daemon', () => {
    process.env.MYCO_SERVICE_VARIANT = 'prod';
    try {
      const boot = resolveBootstrapVaultDirOrPhantom(tmpCwd);
      expect(boot.isPhantom).toBe(true);

      const serviceDir = resolveServiceDir(tmpHome); // ~/.myco/service
      const state = resolveDaemonServiceState(boot.vaultDir, {
        env: { MYCO_HOME: tmpHome },
      });
      // Keyed off MYCO_HOME + variant — the phantom vaultDir is irrelevant.
      expect(state.scope).toBe('global');
      expect(state.stateDir).toBe(serviceDir);
      expect(state.statePath.startsWith(serviceDir)).toBe(true);
      expect(state.lockPath.startsWith(serviceDir)).toBe(true);

      const logDir = resolveDaemonLogDir(boot.vaultDir, {
        env: { MYCO_HOME: tmpHome },
      });
      expect(logDir).toBe(path.join(serviceDir, 'logs'));
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
    }
  });
});
