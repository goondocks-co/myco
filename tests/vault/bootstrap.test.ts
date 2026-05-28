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
    // Manifest is materialized so loadProjectManifest / request-context
    // resolution don't blow up against a vault-less dir.
    const manifestPath = path.join(result.vaultDir, 'project.toml');
    expect(fs.existsSync(manifestPath)).toBe(true);
    expect(fs.readFileSync(manifestPath, 'utf-8')).toMatch(/^\[project\]\nid = "proj_[0-9a-f]{32}"/);
    // myco.yaml is materialized so loadConfigInternal doesn't throw
    // "myco.yaml not found" on the first loadMergedConfig call —
    // greenfield smoke caught this gap before the fix-up.
    const configPath = path.join(result.vaultDir, 'myco.yaml');
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('version: 3\n');
  });

  test('phantom helper is idempotent — manifest id persists across calls', () => {
    const first = resolveBootstrapVaultDirOrPhantom(tmpCwd);
    const firstBody = fs.readFileSync(path.join(first.vaultDir, 'project.toml'), 'utf-8');
    const second = resolveBootstrapVaultDirOrPhantom(tmpCwd);
    const secondBody = fs.readFileSync(path.join(second.vaultDir, 'project.toml'), 'utf-8');
    expect(secondBody).toBe(firstBody);
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

  test('dev variant picks a Grove with served_by = service-dev', () => {
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
      expect(resolveBootstrapVaultDir(tmpCwd)).toBe(path.join(devRoot, '.myco'));
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
    }
  });

  test('documented service-dev variant picks a Grove with served_by = service-dev', () => {
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
      expect(resolveBootstrapVaultDir(tmpCwd)).toBe(path.join(devRoot, '.myco'));
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
    }
  });

  test('prod variant refuses to bind a default Grove with served_by=service-dev (task #9)', () => {
    // The cross-variant escape hatch: a user sets a dev Grove as
    // default_grove_id and then installs the prod daemon. Before
    // task #9 the prod daemon would silently bind to the dev Grove
    // via the default-Grove fast-path, ignoring served_by. The fix
    // makes the prod variant skip a dev-owned default and fall
    // through to the served_by-filtered loop (which finds nothing
    // here), returning null so the rebind watcher keeps waiting.
    const devGrove = 'grove_2222222222222222222222222222222a';
    const devRoot = makeProject('escape-hatch-dev');
    writeRegistry(devGrove); // default points at a dev Grove
    writeGroveToml(devGrove, 'service-dev');
    writeProjectsToml(devGrove, [{ id: 'proj_dev', root: devRoot }]);
    process.env.MYCO_SERVICE_VARIANT = 'prod';
    try {
      expect(resolveBootstrapVaultDir(tmpCwd)).toBeNull();
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
    }
  });

  test('prod variant (default) still picks the default Grove', () => {
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

  test('variant-pinned dev daemon ignores cwd inside a prod-grove project', () => {
    // The regression: a hook running inside /Users/x/unifi-mcp lazy-spawns
    // the dev daemon. cwd-walk would resolve to unifi-mcp's vault, but
    // unifi-mcp belongs to the prod Grove. The dashboard then refuses
    // every cross-Grove request. The fix: when the variant env is set,
    // the cwd is ignored — the variant pins us to its own Grove.
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
      // cwd is inside the prod-grove project — but we are the dev daemon.
      expect(resolveBootstrapVaultDir(prodRoot)).toBe(path.join(devRoot, '.myco'));
    } finally {
      delete process.env.MYCO_SERVICE_VARIANT;
    }
  });

  test('variant-pinned prod daemon ignores cwd inside a dev-grove project', () => {
    // Symmetric: the prod daemon shouldn't be hijacked by a cwd that
    // happens to fall inside the dogfood project either.
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
      expect(resolveBootstrapVaultDir(devRoot)).toBe(path.join(prodRoot, '.myco'));
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
