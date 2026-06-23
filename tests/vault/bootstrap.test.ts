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
let tmpHome: string;
let tmpCwd: string;

function setUpTmpHome(): void {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-boot-home-'));
  originalHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = tmpHome;
}

function tearDownTmpHome(): void {
  if (originalHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = originalHome;
}

function writeRegistry(defaultGroveId: string): void {
  fs.mkdirSync(path.join(tmpHome, 'groves'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, 'groves', 'registry.yaml'), `default_grove_id: ${defaultGroveId}\n`);
}

function writeProjectsToml(groveId: string, rows: Array<{ id: string; root: string }>): void {
  const dir = path.join(tmpHome, 'groves', groveId, 'registry');
  fs.mkdirSync(dir, { recursive: true });
  const body = rows.map((r) =>
    `[projects.${r.id}]\nproject_id = "${r.id}"\nname = "test"\nroot = "${r.root}"\nbinding_id = "gbind_${r.id}"\ncreated_at = "2026-01-01T00:00:00.000Z"\nupdated_at = "2026-01-01T00:00:00.000Z"\n`,
  ).join('\n');
  fs.writeFileSync(path.join(dir, 'projects.toml'), body);
}

function makeProject(name: string, withManifest = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `myco-proj-${name}-`));
  fs.mkdirSync(path.join(root, '.myco'), { recursive: true });
  if (withManifest) {
    // project.toml lives inside .myco/, matching the real on-disk layout
    fs.writeFileSync(path.join(root, '.myco', 'project.toml'), '[project]\nid = "proj_test"\n');
  }
  return root;
}

describe('resolveBootstrapVaultDir', () => {
  beforeEach(() => {
    setUpTmpHome();
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cwd-'));
  });
  afterEach(() => {
    tearDownTmpHome();
  });

  test('returns cwd-enclosing vault when project.toml exists alongside it', () => {
    const projRoot = makeProject('cwd');
    expect(resolveBootstrapVaultDir(projRoot)).toBe(path.join(projRoot, '.myco'));
  });

  test('falls back to first registered project in default Grove when cwd has no project', () => {
    const groveId = 'grove_65b606b9665228ac5f1812d645cdf6fe';
    const projRoot = makeProject('reg1');
    writeRegistry(groveId);
    writeGroveToml(groveId);
    writeProjectsToml(groveId, [{ id: 'proj_test', root: projRoot }]);
    // cwd has no enclosing project, registry has one
    expect(resolveBootstrapVaultDir(tmpCwd)).toBe(path.join(projRoot, '.myco'));
  });

  test('skips registered projects whose root no longer exists on disk', () => {
    const groveId = 'grove_65b606b9665228ac5f1812d645cdf6fe';
    const goodRoot = makeProject('good');
    const ghostRoot = '/this/path/does/not/exist';
    writeRegistry(groveId);
    writeGroveToml(groveId);
    writeProjectsToml(groveId, [
      { id: 'proj_ghost', root: ghostRoot },
      { id: 'proj_good', root: goodRoot },
    ]);
    expect(resolveBootstrapVaultDir(tmpCwd)).toBe(path.join(goodRoot, '.myco'));
  });

  test('returns null on greenfield (no enclosing project, no registry)', () => {
    // Greenfield contract: the variant-less daemon must come up so hooks
    // can register the first project. Throwing here would re-create the
    // chicken-and-egg that blocked publication.
    expect(resolveBootstrapVaultDir(tmpCwd)).toBeNull();
  });

  test('MYCO_DAEMON_MANAGED phantom-boot gate: managed daemon returns null; non-managed proceeds to cwd/registry', () => {
    // Regression for T8 C1: the phantom-boot gate must read MYCO_DAEMON_MANAGED,
    // not MYCO_SERVICE_VARIANT. Before this fix, MYCO_DAEMON_MANAGED was never
    // read here — only MYCO_SERVICE_VARIANT was — so a supervisor-managed prod
    // daemon would fall through to the cwd/registry path and mis-anchor to an
    // arbitrary registered project (tenant-scope-leak class, same as PR #508).
    //
    // This test would FAIL against the old code:
    //   Old: gate reads MYCO_SERVICE_VARIANT → MYCO_DAEMON_MANAGED='1' is ignored
    //        → non-null (falls through to registry or cwd-walk).
    //   New: gate reads MYCO_DAEMON_MANAGED → returns null immediately.
    let savedManaged: string | undefined;
    let savedVariant: string | undefined;
    try {
      savedManaged = process.env.MYCO_DAEMON_MANAGED;
      savedVariant = process.env.MYCO_SERVICE_VARIANT;
      // Ensure MYCO_SERVICE_VARIANT is NOT set — the old signal must not fire.
      delete process.env.MYCO_SERVICE_VARIANT;

      // With MYCO_DAEMON_MANAGED set, even in a cwd with no project and no
      // registry, the gate fires and returns null (phantom home-scoped boot).
      process.env.MYCO_DAEMON_MANAGED = '1';
      expect(resolveBootstrapVaultDir(tmpCwd)).toBeNull();

      // Without MYCO_DAEMON_MANAGED, the same cwd with no project/registry
      // falls through the gate and returns null only at the greenfield path —
      // NOT at the managed-gate. Both return null here (greenfield), but the
      // code path differs: without managed, it reaches cwd-walk first.
      // Verify the non-managed case proceeds to the cwd-walk branch by
      // confirming a cwd WITH a project does NOT return null.
      delete process.env.MYCO_DAEMON_MANAGED;
      const projRoot = makeProject('regression-non-managed');
      expect(resolveBootstrapVaultDir(projRoot)).toBe(path.join(projRoot, '.myco'));
    } finally {
      if (savedManaged === undefined) delete process.env.MYCO_DAEMON_MANAGED;
      else process.env.MYCO_DAEMON_MANAGED = savedManaged;
      if (savedVariant === undefined) delete process.env.MYCO_SERVICE_VARIANT;
      else process.env.MYCO_SERVICE_VARIANT = savedVariant;
    }
  });

  test('phantom helper falls back to MYCO_HOME scratch dir on greenfield', () => {
    const result = resolveBootstrapVaultDirOrPhantom(tmpCwd);
    expect(result.isPhantom).toBe(true);
    expect(result.vaultDir).toBe(resolvePhantomBootstrapVaultDir(tmpHome));
    // Dir is created so callers (machine-id, logger) can write into it
    // immediately.
    expect(fs.existsSync(result.vaultDir)).toBe(true);
    // No project.toml is minted: the daemon's anchor is the project-less
    // daemon-global context, never a fabricated `proj_<hex>` id. (Regression
    // for the phantom-tenancy elimination — see daemon-global-anchor.test.ts.)
    const manifestPath = path.join(result.vaultDir, 'project.toml');
    expect(fs.existsSync(manifestPath)).toBe(false);
    // myco.yaml is still materialized so loadConfigInternal doesn't throw
    // "myco.yaml not found" on the first loadMergedConfig call —
    // greenfield smoke caught this gap before the fix-up.
    const configPath = path.join(result.vaultDir, 'myco.yaml');
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('version: 3\n');
  });

  test('phantom helper never materializes a project id (no proj_ in the scratch dir)', () => {
    const first = resolveBootstrapVaultDirOrPhantom(tmpCwd);
    expect(fs.existsSync(path.join(first.vaultDir, 'project.toml'))).toBe(false);
    // Idempotent: a second call still leaves no project.toml.
    const second = resolveBootstrapVaultDirOrPhantom(tmpCwd);
    expect(fs.existsSync(path.join(second.vaultDir, 'project.toml'))).toBe(false);
  });

  test('phantom helper passes through real vault when one resolves', () => {
    const projRoot = makeProject('phantom-passthrough');
    const result = resolveBootstrapVaultDirOrPhantom(projRoot);
    expect(result.isPhantom).toBe(false);
    expect(result.vaultDir).toBe(path.join(projRoot, '.myco'));
  });

  function writeGroveToml(groveId: string): void {
    const dir = path.join(tmpHome, 'groves', groveId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'grove.toml'),
      `[grove]\nid = "${groveId}"\nname = "${groveId}"\nslug = "${groveId}"\nmode = "local"\ncreated_at = "2026-01-01T00:00:00.000Z"\n`,
    );
  }

  test('managed daemon ignores the registry and stays home-scoped (null)', () => {
    // The global, multi-tenant daemon has no bootstrap project. Even with
    // a registered Grove + project on disk, MYCO_DAEMON_MANAGED=1 causes
    // startup to materialize the phantom MYCO_HOME and serve tenants by
    // request context. Picking the first registered project — the old
    // behavior — was the tenant-scope-leak bug-attractor this change removes.
    const prodGrove = 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const devGrove = 'grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const prodRoot = makeProject('prod');
    const devRoot = makeProject('dev');
    writeRegistry(prodGrove); // default = prod
    writeGroveToml(prodGrove);
    writeGroveToml(devGrove);
    writeProjectsToml(prodGrove, [{ id: 'proj_prod', root: prodRoot }]);
    writeProjectsToml(devGrove, [{ id: 'proj_dev', root: devRoot }]);
    process.env.MYCO_DAEMON_MANAGED = '1';
    try {
      expect(resolveBootstrapVaultDir(tmpCwd)).toBeNull();
    } finally {
      delete process.env.MYCO_DAEMON_MANAGED;
    }
  });

  test('managed daemon ignores a registered default Grove and stays home-scoped (null)', () => {
    // Even with a fully-registered default Grove on disk, a managed daemon
    // returns null and runs phantom from MYCO_HOME. The anchor is gone from
    // the managed path entirely — no project is ever selected for the
    // global daemon.
    const prodGrove = 'grove_2222222222222222222222222222222a';
    const prodRoot = makeProject('global-prod-default');
    writeRegistry(prodGrove);
    writeGroveToml(prodGrove);
    writeProjectsToml(prodGrove, [{ id: 'proj_prod', root: prodRoot }]);
    process.env.MYCO_DAEMON_MANAGED = '1';
    try {
      expect(resolveBootstrapVaultDir(tmpCwd)).toBeNull();
    } finally {
      delete process.env.MYCO_DAEMON_MANAGED;
    }
  });

  test('non-managed daemon (no MYCO_DAEMON_MANAGED) still picks the default Grove', () => {
    const prodGrove = 'grove_cccccccccccccccccccccccccccccccc';
    const devGrove = 'grove_dddddddddddddddddddddddddddddddd';
    const prodRoot = makeProject('prod2');
    const devRoot = makeProject('dev2');
    writeRegistry(prodGrove);
    writeGroveToml(prodGrove);
    writeGroveToml(devGrove);
    writeProjectsToml(prodGrove, [{ id: 'proj_prod', root: prodRoot }]);
    writeProjectsToml(devGrove, [{ id: 'proj_dev', root: devRoot }]);
    // MYCO_DAEMON_MANAGED unset — non-managed daemon should pick default Grove
    expect(resolveBootstrapVaultDir(tmpCwd)).toBe(path.join(prodRoot, '.myco'));
  });

  test('managed greenfield (no registry at all) returns null for phantom-mode bootstrap', () => {
    // Production user path: supervisor (launchd/systemd) spawns the daemon
    // with MYCO_DAEMON_MANAGED=1 BEFORE any project exists. Returning null
    // lets the phantom-home path come up so the API serves requests and
    // the first hook registers a project, triggering a restart.
    process.env.MYCO_DAEMON_MANAGED = '1';
    try {
      expect(resolveBootstrapVaultDir(tmpCwd)).toBeNull();
    } finally {
      delete process.env.MYCO_DAEMON_MANAGED;
    }
  });

  test('managed greenfield routes through phantom helper without throw', () => {
    // End-to-end: the daemon's actual startup path. Combined with the
    // phantom helper, managed supervisor spawns get a usable bootstrap
    // dir instead of a respawn loop.
    process.env.MYCO_DAEMON_MANAGED = '1';
    try {
      const result = resolveBootstrapVaultDirOrPhantom(tmpCwd);
      expect(result.isPhantom).toBe(true);
      expect(result.vaultDir).toBe(resolvePhantomBootstrapVaultDir(tmpHome));
    } finally {
      delete process.env.MYCO_DAEMON_MANAGED;
    }
  });

  test('managed daemon ignores cwd inside a project (home-scoped, null)', () => {
    // A hook running inside a project cwd lazy-spawns the managed daemon.
    // cwd-walk would otherwise resolve to that project's vault. The
    // managed daemon ignores cwd AND the registry entirely — it has no
    // bootstrap project, returns null, and runs phantom from MYCO_HOME.
    const prodGrove = 'grove_ffffffffffffffffffffffffffffffff';
    const devGrove = 'grove_99999999999999999999999999999999';
    const prodRoot = makeProject('prod-cwd');
    const devRoot = makeProject('dev-target');
    writeRegistry(prodGrove);
    writeGroveToml(prodGrove);
    writeGroveToml(devGrove);
    writeProjectsToml(prodGrove, [{ id: 'proj_prod', root: prodRoot }]);
    writeProjectsToml(devGrove, [{ id: 'proj_dev', root: devRoot }]);

    process.env.MYCO_DAEMON_MANAGED = '1';
    try {
      // cwd is inside a real project — but the managed daemon has no
      // current project regardless.
      expect(resolveBootstrapVaultDir(prodRoot)).toBeNull();
    } finally {
      delete process.env.MYCO_DAEMON_MANAGED;
    }
  });

  test('sandbox-mode daemon refuses to bind to a real project via cwd-walk', () => {
    // Smoke-test daemons are spawned with MYCO_LAUNCH_AGENTS_DIR set
    // and an isolated MYCO_HOME under /tmp. Their cwd usually lands
    // inside the developer's real repo (the foreground spawn starts
    // from a project tree). Without this guard, the cwd-walk branch
    // would happily bind the sandbox daemon's vault to the real
    // project's `.myco/`, writing the real `.myco/myco.db` from a
    // sandbox-locked daemon. Confirmed in the wild: a sandbox smoke
    // daemon (lock under /tmp/myco-smoke2-xxx) had the developer's
    // real `Repos/myco/.myco/myco.db` open for writes.
    //
    // The guard: when MYCO_LAUNCH_AGENTS_DIR is set, skip cwd-walk
    // entirely. Registry path only; sandbox HOME has an empty registry
    // so we fall through to null → phantom-bootstrap.
    const realProject = makeProject('real-repo');
    process.env.MYCO_LAUNCH_AGENTS_DIR = path.join(tmpHome, 'Library', 'LaunchAgents');
    try {
      // Cwd inside the real project — without the guard, this would
      // return the real project's .myco/ vault, escaping the sandbox.
      expect(resolveBootstrapVaultDir(realProject)).toBeNull();
    } finally {
      delete process.env.MYCO_LAUNCH_AGENTS_DIR;
    }
  });

  test('sandbox-mode + sandbox-registry still binds to sandbox-internal projects', () => {
    // Sandbox-mode guard MUST NOT block legitimate sandbox project
    // resolution. If the sandbox's own registry has a project (e.g.
    // a smoke test that registered one during setup), the daemon
    // binds to it.
    const sandboxGrove = 'grove_99999999999999999999999999999999';
    const sandboxProject = makeProject('sandbox-internal');
    writeRegistry(sandboxGrove);
    writeGroveToml(sandboxGrove);
    writeProjectsToml(sandboxGrove, [{ id: 'proj_sandbox', root: sandboxProject }]);

    const realProject = makeProject('real-but-cwd');
    process.env.MYCO_LAUNCH_AGENTS_DIR = path.join(tmpHome, 'Library', 'LaunchAgents');
    try {
      // Even though cwd is the real project, sandbox mode goes
      // straight to the registry and finds the sandbox-internal one.
      expect(resolveBootstrapVaultDir(realProject)).toBe(path.join(sandboxProject, '.myco'));
    } finally {
      delete process.env.MYCO_LAUNCH_AGENTS_DIR;
    }
  });
});

describe('resolvePhantomBootstrapVaultDir — single dirname per home', () => {
  beforeEach(() => {
    setUpTmpHome();
  });

  afterEach(() => {
    tearDownTmpHome();
  });

  test('managed daemon anchors to _unbound-bootstrap', () => {
    process.env.MYCO_DAEMON_MANAGED = '1';
    try {
      expect(resolvePhantomBootstrapVaultDir(tmpHome)).toBe(path.join(tmpHome, '_unbound-bootstrap'));
    } finally {
      delete process.env.MYCO_DAEMON_MANAGED;
    }
  });

  test('non-managed daemon also uses _unbound-bootstrap (home separation removes any variant suffix)', () => {
    // resolvePhantomBootstrapVaultDir is pure over mycoHome — no env signal matters.
    expect(resolvePhantomBootstrapVaultDir(tmpHome)).toBe(path.join(tmpHome, '_unbound-bootstrap'));
  });

  test('same phantom dir regardless of managed flag', () => {
    const withoutManaged = resolvePhantomBootstrapVaultDir(tmpHome);
    process.env.MYCO_DAEMON_MANAGED = '1';
    try {
      const withManaged = resolvePhantomBootstrapVaultDir(tmpHome);
      expect(withManaged).toBe(withoutManaged);
    } finally {
      delete process.env.MYCO_DAEMON_MANAGED;
    }
  });
});
