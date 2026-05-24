/**
 * Greenfield daemon → first-project rebind invariant.
 *
 * Task #1 (commit 30fbad6e) added phantom-bootstrap mode: the daemon
 * starts in the directory returned by `resolvePhantomBootstrapVaultDir()`
 * (currently `~/.myco/_unbound-bootstrap/`, renamed in 357f9125) against
 * a synthetic project manifest so the API surface can come up before
 * any real project is registered.
 * A registry-poll watcher (every 5s) detects the first hook-driven
 * `myco init` and triggers a graceful restart — the next boot resolves
 * a real vault via `firstProjectVaultFromRegistry()`.
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

  test('phantom dir still exists on disk post-rebind (intentional) but is not surfaced by the resolver', () => {
    // This locks in the design choice from bootstrap.ts:130-141:
    // "Persisted across boots so the phantom id stays stable; the
    // daemon restarts to a real vault as soon as the first project
    // registers." We do NOT delete the phantom dir after rebind — but
    // the resolver must stop returning it.
    const phantomPath = resolvePhantomBootstrapVaultDir(tmpHome);
    // Force materialization of the phantom dir.
    resolveBootstrapVaultDirOrPhantom(tmpCwd);
    expect(fs.existsSync(phantomPath)).toBe(true);
    const phantomManifestBefore = fs.readFileSync(
      path.join(phantomPath, 'project.toml'),
      'utf-8',
    );

    // Rebind.
    const groveId = 'grove_44444444444444444444444444444444';
    const projRoot = makeProjectOnDisk('phantom-persists');
    try {
      writeRegistry(groveId);
      writeGroveToml(groveId, 'service');
      writeProjectsToml(groveId, [{ id: 'proj_persist', root: projRoot }]);

      const after = resolveBootstrapVaultDirOrPhantom(tmpCwd);
      expect(after.vaultDir).not.toBe(phantomPath);

      // Phantom artifacts still exist on disk — the rebind does NOT
      // clean them. The next greenfield daemon (e.g. after `myco
      // remove` strips all projects) would reuse the same synthetic
      // project id, which is the documented design.
      expect(fs.existsSync(phantomPath)).toBe(true);
      const phantomManifestAfter = fs.readFileSync(
        path.join(phantomPath, 'project.toml'),
        'utf-8',
      );
      expect(phantomManifestAfter).toBe(phantomManifestBefore);
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
 * Variant-pinned greenfield + variant-aware rebind filter.
 *
 * Production user path: `npm install -g` → postinstall registers a
 * managed service → launchd/systemd spawns the daemon with
 * `MYCO_SERVICE_VARIANT` set BEFORE any project exists. The old
 * variant-pinned branch threw on greenfield, which respawn-looped
 * the supervisor before any hook could register the first project.
 *
 * Task #6 (commit 2cb70c6c) reshaped variant-pinned greenfield: it
 * now returns null and the OrPhantom helper takes over, while
 * `firstProjectVaultFromRegistry()`'s `served_by` filter preserves
 * the cross-variant safety invariant — a dev daemon's rebind watcher
 * only binds to dev Groves; a prod daemon's only binds to prod
 * Groves. This block locks BOTH halves: phantom-bootstrap survival
 * AND variant-aware rebind filtering.
 *
 * The phantom-bootstrap survival half is also covered in
 * `tests/vault/bootstrap.test.ts`
 *   ("variant-pinned greenfield routes through phantom helper without throw")
 * — replicated here because the rebind-after-survival sequence is
 * the contract this file owns, and a future regression that
 * re-introduces the throw would break the rebind invariants below
 * silently if we only asserted the survival in the other file.
 */
describe('variant-pinned daemons phantom-bootstrap + bind only to matching-variant Groves', () => {
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

  test('dev variant rebinds to a dev Grove, NOT a prod Grove registered alongside it', () => {
    // The variant safety invariant under rebind: a dev daemon's
    // watcher must only fire on dev-served Groves. If a prod Grove
    // gets registered first (or is already there from another
    // variant's daemon), the dev watcher must keep waiting — never
    // bind to it.
    const prodGrove = 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const devGrove = 'grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const prodRoot = makeProjectOnDisk('cross-variant-prod');
    const devRoot = makeProjectOnDisk('cross-variant-dev');
    process.env.MYCO_SERVICE_VARIANT = 'dev';
    try {
      // Phase 1: only prod Grove registered. Dev watcher must NOT fire.
      writeRegistry(prodGrove);
      writeGroveToml(prodGrove, 'service');
      writeProjectsToml(prodGrove, [{ id: 'proj_p', root: prodRoot }]);
      expect(resolveBootstrapVaultDir(tmpCwd)).toBeNull();

      // Phase 2: dev Grove registered alongside the prod one. Dev
      // watcher fires and binds to the DEV vault, ignoring prod.
      writeGroveToml(devGrove, 'service-dev');
      writeProjectsToml(devGrove, [{ id: 'proj_d', root: devRoot }]);
      const resolved = resolveBootstrapVaultDir(tmpCwd);
      expect(resolved).toBe(path.join(devRoot, '.myco'));
      expect(resolved).not.toBe(path.join(prodRoot, '.myco'));
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
      fs.rmSync(prodRoot, { recursive: true, force: true });
      fs.rmSync(devRoot, { recursive: true, force: true });
    }
  });

  test('prod variant rebinds to a prod Grove, NOT a non-default dev Grove registered alongside it', () => {
    // Symmetric to the dev case via the served_by-filtered fallback
    // path. The default-Grove fast-path in `firstProjectVaultFromRegistry()`
    // now honors `served_by`: a legacy default Grove with no
    // `grove.toml` (or no `served_by` field) still binds to prod, but
    // an explicit `served_by = "service-dev"` default Grove is skipped.
    // Phase 1 below asserts the post-fix skip-on-dev behavior; phase 2
    // asserts the standard prod-default bind.
    const prodGrove = 'grove_cccccccccccccccccccccccccccccccc';
    const devGrove = 'grove_dddddddddddddddddddddddddddddddd';
    const prodRoot = makeProjectOnDisk('symm-prod');
    const devRoot = makeProjectOnDisk('symm-dev');
    process.env.MYCO_SERVICE_VARIANT = 'prod';
    try {
      // Phase 1: only dev Grove registered, set as default. Prod
      // watcher MUST keep waiting — even though the dev Grove is the
      // default, served_by=service-dev disqualifies it. See the
      // file-level note on the prod default-Grove fast-path: this
      // assertion fails if a future regression flips the fallback
      // to ignore served_by.
      writeRegistry(devGrove);
      writeGroveToml(devGrove, 'service-dev');
      writeProjectsToml(devGrove, [{ id: 'proj_d', root: devRoot }]);
      // Task #9 closed the default-Grove escape hatch: when the
      // registry's default_grove_id points to a Grove with
      // `served_by = "service-dev"`, the prod daemon now refuses to
      // bind it and falls through to wait for a prod-served Grove.
      // Phase 1 here asserts the post-fix behavior — the dev default
      // is invisible to the prod variant.
      expect(resolveBootstrapVaultDir(tmpCwd)).toBeNull();

      // Phase 2: prod Grove registered AS DEFAULT, alongside the
      // non-default dev Grove. Prod watcher fires, binds to the
      // prod default. The served_by filter is what makes the
      // non-default dev Grove invisible here — change the registry
      // to make the dev Grove default to exercise the gap above.
      writeRegistry(prodGrove);
      writeGroveToml(prodGrove, 'service');
      writeProjectsToml(prodGrove, [{ id: 'proj_p', root: prodRoot }]);
      const resolved = resolveBootstrapVaultDir(tmpCwd);
      expect(resolved).toBe(path.join(prodRoot, '.myco'));
      expect(resolved).not.toBe(path.join(devRoot, '.myco'));
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
      fs.rmSync(prodRoot, { recursive: true, force: true });
      fs.rmSync(devRoot, { recursive: true, force: true });
    }
  });

  test('variant-pinned phantom→rebind: OrPhantom flips isPhantom true→false when matching-variant Grove registers', () => {
    // End-to-end through the helper the daemon actually uses on
    // startup. Greenfield → phantom → rebind tick → real vault.
    const devGrove = 'grove_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const devRoot = makeProjectOnDisk('e2e-dev');
    process.env.MYCO_SERVICE_VARIANT = 'dev';
    try {
      const before = resolveBootstrapVaultDirOrPhantom(tmpCwd);
      expect(before.isPhantom).toBe(true);

      writeRegistry(devGrove);
      writeGroveToml(devGrove, 'service-dev');
      writeProjectsToml(devGrove, [{ id: 'proj_d', root: devRoot }]);

      const after = resolveBootstrapVaultDirOrPhantom(tmpCwd);
      expect(after.isPhantom).toBe(false);
      expect(after.vaultDir).toBe(path.join(devRoot, '.myco'));
      expect(after.vaultDir.startsWith(resolvePhantomBootstrapVaultDir(tmpHome))).toBe(false);
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
      fs.rmSync(devRoot, { recursive: true, force: true });
    }
  });
});
