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
    writeGroveToml(groveId, 'service');
    writeProjectsToml(groveId, [{ id: 'proj_test', root: projRoot }]);
    // cwd has no enclosing project, registry has one
    expect(resolveBootstrapVaultDir(tmpCwd)).toBe(path.join(projRoot, '.myco'));
  });

  test('skips registered projects whose root no longer exists on disk', () => {
    const groveId = 'grove_65b606b9665228ac5f1812d645cdf6fe';
    const goodRoot = makeProject('good');
    const ghostRoot = '/this/path/does/not/exist';
    writeRegistry(groveId);
    writeGroveToml(groveId, 'service');
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

  function writeGroveToml(groveId: string, servedBy: 'service' | 'service-dev'): void {
    const dir = path.join(tmpHome, 'groves', groveId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'grove.toml'),
      `[grove]\nid = "${groveId}"\nname = "${groveId}"\nslug = "${groveId}"\nmode = "local"\ncreated_at = "2026-01-01T00:00:00.000Z"\nserved_by = "${servedBy}"\n`,
    );
  }

  test('global dev daemon ignores the registry and stays home-scoped (null)', () => {
    // The global, multi-tenant daemon has no bootstrap project. Even with
    // a matching-variant Grove + project registered on disk, the variant
    // path returns null so startup materializes the phantom MYCO_HOME and
    // the daemon serves tenants by request context. Picking the first
    // registered project — the old behavior — was the tenant-scope-leak
    // bug-attractor this change removes.
    const prodGrove = 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const devGrove = 'grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const prodRoot = makeProject('prod');
    const devRoot = makeProject('dev');
    writeRegistry(prodGrove); // default = prod
    writeGroveToml(prodGrove, 'service');
    writeGroveToml(devGrove, 'service-dev');
    writeProjectsToml(prodGrove, [{ id: 'proj_prod', root: prodRoot }]);
    writeProjectsToml(devGrove, [{ id: 'proj_dev', root: devRoot }]);
    process.env.MYCO_SERVICE_VARIANT = 'dev';
    try {
      expect(resolveBootstrapVaultDir(tmpCwd)).toBeNull();
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
    }
  });

  test('global service-dev daemon ignores the registry and stays home-scoped (null)', () => {
    const prodGrove = 'grove_1111111111111111111111111111111a';
    const devGrove = 'grove_1111111111111111111111111111111b';
    const prodRoot = makeProject('prod-service-name');
    const devRoot = makeProject('dev-service-name');
    writeRegistry(prodGrove);
    writeGroveToml(prodGrove, 'service');
    writeGroveToml(devGrove, 'service-dev');
    writeProjectsToml(prodGrove, [{ id: 'proj_prod_service_name', root: prodRoot }]);
    writeProjectsToml(devGrove, [{ id: 'proj_dev_service_name', root: devRoot }]);
    process.env.MYCO_SERVICE_VARIANT = 'service-dev';
    try {
      expect(resolveBootstrapVaultDir(tmpCwd)).toBeNull();
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
    }
  });

  test('global prod daemon ignores a registered default Grove and stays home-scoped (null)', () => {
    // Even with a fully-registered prod default Grove on disk, the global
    // prod daemon returns null and runs phantom from MYCO_HOME. The anchor
    // is gone from the global path entirely — no project, dev or prod, is
    // ever selected for the global daemon.
    const prodGrove = 'grove_2222222222222222222222222222222a';
    const prodRoot = makeProject('global-prod-default');
    writeRegistry(prodGrove);
    writeGroveToml(prodGrove, 'service');
    writeProjectsToml(prodGrove, [{ id: 'proj_prod', root: prodRoot }]);
    process.env.MYCO_SERVICE_VARIANT = 'prod';
    try {
      expect(resolveBootstrapVaultDir(tmpCwd)).toBeNull();
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
    }
  });

  test('variant-less daemon (no MYCO_SERVICE_VARIANT) still picks the default Grove', () => {
    const prodGrove = 'grove_cccccccccccccccccccccccccccccccc';
    const devGrove = 'grove_dddddddddddddddddddddddddddddddd';
    const prodRoot = makeProject('prod2');
    const devRoot = makeProject('dev2');
    writeRegistry(prodGrove);
    writeGroveToml(prodGrove, 'service');
    writeGroveToml(devGrove, 'service-dev');
    writeProjectsToml(prodGrove, [{ id: 'proj_prod', root: prodRoot }]);
    writeProjectsToml(devGrove, [{ id: 'proj_dev', root: devRoot }]);
    // MYCO_SERVICE_VARIANT unset — should pick prod
    expect(resolveBootstrapVaultDir(tmpCwd)).toBe(path.join(prodRoot, '.myco'));
  });

  test('variant-pinned greenfield (no registry at all) returns null for phantom-mode bootstrap', () => {
    // Production user path: `npm install -g` → postinstall registers a
    // service → launchd/systemd spawns the daemon with the variant env
    // set BEFORE any project exists. Throwing here would respawn-loop
    // the supervisor. The variant safety invariant is preserved by
    // firstProjectVaultFromRegistry()'s served_by filter: when a Grove
    // eventually registers, the dev daemon binds only to dev Groves
    // and the prod daemon binds only to prod Groves.
    process.env.MYCO_SERVICE_VARIANT = 'prod';
    try {
      expect(resolveBootstrapVaultDir(tmpCwd)).toBeNull();
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
    }
  });

  test('dev variant in greenfield with prod-only Groves returns null (does not bind to prod)', () => {
    // The variant filter must hold even when a non-matching Grove is
    // registered. A dev-variant daemon must not silently bootstrap onto
    // a prod Grove just because no dev Grove exists yet — the rebind
    // watcher waits for a dev Grove to appear.
    const prodGrove = 'grove_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const prodRoot = makeProject('prod3');
    writeRegistry(prodGrove);
    writeGroveToml(prodGrove, 'service');
    writeProjectsToml(prodGrove, [{ id: 'proj_prod', root: prodRoot }]);
    process.env.MYCO_SERVICE_VARIANT = 'dev';
    try {
      expect(resolveBootstrapVaultDir(tmpCwd)).toBeNull();
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
    }
  });

  test('variant-pinned greenfield routes through phantom helper without throw', () => {
    // End-to-end: the daemon's actual startup path. Combined with the
    // phantom helper, variant-pinned supervisor spawns get a usable
    // bootstrap dir instead of a respawn loop.
    process.env.MYCO_SERVICE_VARIANT = 'dev';
    try {
      const result = resolveBootstrapVaultDirOrPhantom(tmpCwd);
      expect(result.isPhantom).toBe(true);
      expect(result.vaultDir).toBe(resolvePhantomBootstrapVaultDir(tmpHome));
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
    }
  });

  test('global dev daemon ignores cwd inside a prod-grove project (home-scoped, null)', () => {
    // The original regression: a hook running inside /Users/x/unifi-mcp
    // lazy-spawns the dev daemon. cwd-walk would resolve to unifi-mcp's
    // vault, but unifi-mcp belongs to the prod Grove. The global daemon
    // now ignores cwd AND the registry entirely — it has no bootstrap
    // project, so it returns null and runs phantom from MYCO_HOME. No
    // cross-Grove anchor can be selected because no anchor is selected
    // at all.
    const prodGrove = 'grove_ffffffffffffffffffffffffffffffff';
    const devGrove = 'grove_99999999999999999999999999999999';
    const prodRoot = makeProject('prod-cwd');
    const devRoot = makeProject('dev-target');
    writeRegistry(prodGrove);
    writeGroveToml(prodGrove, 'service');
    writeGroveToml(devGrove, 'service-dev');
    writeProjectsToml(prodGrove, [{ id: 'proj_prod', root: prodRoot }]);
    writeProjectsToml(devGrove, [{ id: 'proj_dev', root: devRoot }]);

    process.env.MYCO_SERVICE_VARIANT = 'dev';
    try {
      // cwd is inside the prod-grove project — but the global daemon has
      // no current project regardless.
      expect(resolveBootstrapVaultDir(prodRoot)).toBeNull();
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
    }
  });

  test('global prod daemon ignores cwd inside a dev-grove project (home-scoped, null)', () => {
    // Symmetric: the prod global daemon isn't hijacked by a cwd inside the
    // dogfood project, and doesn't anchor to a registered prod project
    // either — it stays home-scoped.
    const prodGrove = 'grove_88888888888888888888888888888888';
    const devGrove = 'grove_77777777777777777777777777777777';
    const prodRoot = makeProject('prod-target');
    const devRoot = makeProject('dev-cwd');
    writeRegistry(prodGrove);
    writeGroveToml(prodGrove, 'service');
    writeGroveToml(devGrove, 'service-dev');
    writeProjectsToml(prodGrove, [{ id: 'proj_prod', root: prodRoot }]);
    writeProjectsToml(devGrove, [{ id: 'proj_dev', root: devRoot }]);

    process.env.MYCO_SERVICE_VARIANT = 'prod';
    try {
      expect(resolveBootstrapVaultDir(devRoot)).toBeNull();
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
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
    writeGroveToml(sandboxGrove, 'service');
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

describe('resolvePhantomBootstrapVaultDir — per-variant isolation', () => {
  let savedVariant: string | undefined;

  beforeEach(() => {
    setUpTmpHome();
    savedVariant = process.env.MYCO_SERVICE_VARIANT;
  });

  afterEach(() => {
    tearDownTmpHome();
    if (savedVariant === undefined) delete process.env.MYCO_SERVICE_VARIANT;
    else process.env.MYCO_SERVICE_VARIANT = savedVariant;
  });

  test('prod variant anchors to _unbound-bootstrap', () => {
    process.env.MYCO_SERVICE_VARIANT = 'service';
    expect(resolvePhantomBootstrapVaultDir(tmpHome)).toBe(path.join(tmpHome, '_unbound-bootstrap'));
  });

  test('dev variant anchors to a separate _unbound-bootstrap-dev', () => {
    process.env.MYCO_SERVICE_VARIANT = 'service-dev';
    expect(resolvePhantomBootstrapVaultDir(tmpHome)).toBe(path.join(tmpHome, '_unbound-bootstrap-dev'));
  });

  test('dev alias resolves to the same dev anchor', () => {
    process.env.MYCO_SERVICE_VARIANT = 'dev';
    expect(resolvePhantomBootstrapVaultDir(tmpHome)).toBe(path.join(tmpHome, '_unbound-bootstrap-dev'));
  });

  test('variant-less daemon uses the prod anchor', () => {
    delete process.env.MYCO_SERVICE_VARIANT;
    expect(resolvePhantomBootstrapVaultDir(tmpHome)).toBe(path.join(tmpHome, '_unbound-bootstrap'));
  });

  test('dev and prod anchors never collide', () => {
    process.env.MYCO_SERVICE_VARIANT = 'service';
    const prod = resolvePhantomBootstrapVaultDir(tmpHome);
    process.env.MYCO_SERVICE_VARIANT = 'service-dev';
    const dev = resolvePhantomBootstrapVaultDir(tmpHome);
    expect(prod).not.toBe(dev);
  });
});
