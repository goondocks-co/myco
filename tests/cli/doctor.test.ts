import { afterEach, beforeEach, describe, it, expect, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type DoctorCheck, checkCaptureFlow, checkMigrationStatus, checkSymbiontEdgeCases, fix, isSymbiontRegistered, isSymbiontRegisteredGlobally, run, runChecks } from '@myco/cli/doctor';
import { loadManifests } from '@myco/symbionts/detect';
import { manifestToolTransport } from '@myco/symbionts/capabilities';
import { expandHome } from '@myco/grove/paths';
import { openDatabase, withDatabase, initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { resolveDaemonDataPaths } from '@myco/daemon/data-paths.js';
import { resolveDaemonServiceState } from '@myco/daemon/service-state.js';
import { recordMigrationPass, listMigrationErrors } from '@myco/db/queries/migration-log.js';
import { clearGroveRegistryCaches, createGrove, registerProjectInGrove } from '@myco/grove/registry.js';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

function findManifest(name: string) {
  const manifest = loadManifests().find((entry) => entry.name === name);
  expect(manifest, `manifest ${name} should exist`).toBeDefined();
  return manifest!;
}

describe('runChecks', () => {
  it('reports a missing myco.yaml as warn (not fail) so doctor outside a project exits 0', async () => {
    // RC-6: a missing vault config is the documented "run doctor from
    // $HOME after install" flow, not a failure. Only an unparseable
    // config fails the Vault row.
    const checks = await runChecks(
      '/tmp/nonexistent-vault-' + Date.now(),
      testPerUserLockNamespace,
    );
    const vaultCheck = checks.find((c) => c.name === 'Vault');
    expect(vaultCheck).toBeDefined();
    expect(vaultCheck!.status).toBe('warn');
    expect(checks.every((c) => c.status !== 'fail' || c.name === 'Daemon')).toBe(true);
  });

  it('reports an unparseable myco.yaml as a Vault failure', async () => {
    const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-badyaml-'));
    try {
      fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: [unclosed\n', 'utf-8');
      const checks = await runChecks(vaultDir, testPerUserLockNamespace);
      const vaultCheck = checks.find((c) => c.name === 'Vault');
      expect(vaultCheck!.status).toBe('fail');
    } finally {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
  });

  it('returns all expected check names', async () => {
    const checks = await runChecks(
      '/tmp/nonexistent-vault-' + Date.now(),
      testPerUserLockNamespace,
    );
    const names = checks.map((c) => c.name);
    expect(names).toContain('Vault');
    expect(names).toContain('Database');
    expect(names).toContain('Embeddings');
    expect(names).toContain('Agents');
    expect(names).toContain('Daemon');
  });
});

describe('doctor exit codes', () => {
  let vaultDir: string;
  let savedMycoHome: string | undefined;
  let mycoHome: string;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-exit-'));
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-exit-home-'));
    savedMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(mycoHome, { recursive: true, force: true });
    if (savedMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = savedMycoHome;
    process.exitCode = 0;
  });

  async function runDoctorQuietly(args: string[]): Promise<void> {
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await run(args, vaultDir, testPerUserLockNamespace);
    } finally {
      logSpy.mockRestore();
    }
  }

  it('exits 0 from a non-project directory (healthy machine, warn rows only)', async () => {
    await runDoctorQuietly([]);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('sets exit code 1 when a check fails', async () => {
    // Unparseable config → Vault check fails.
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: [unclosed\n', 'utf-8');
    await runDoctorQuietly([]);
    expect(process.exitCode).toBe(1);
  });

  it('reports a malformed daemon.json as a fixable failure', async () => {
    const statePath = resolveDaemonServiceState(vaultDir, { env: process.env }).statePath;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{not json', 'utf-8');

    const checks = await runChecks(vaultDir, testPerUserLockNamespace);
    const daemon = checks.find((c) => c.name === 'Daemon');
    expect(daemon!.status).toBe('fail');
    expect(daemon!.fixable).toBe(true);
    expect(daemon!.detail).toContain('parse error');
  });

  it('exits 0 when --fix repairs the only failing check (exit code reflects post-fix state)', async () => {
    // Malformed daemon.json → Daemon fail (fixable). fix() deletes it via
    // deleteIfMalformed; the recheck then sees a clean machine.
    const statePath = resolveDaemonServiceState(vaultDir, { env: process.env }).statePath;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{not json', 'utf-8');

    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await runDoctorQuietly(['--fix']);
    } finally {
      errorSpy.mockRestore();
    }

    expect(fs.existsSync(statePath)).toBe(false);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('keeps exit code 1 when --fix cannot repair the failure', async () => {
    // Unparseable myco.yaml is not auto-fixable.
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: [unclosed\n', 'utf-8');
    await runDoctorQuietly(['--fix']);
    expect(process.exitCode).toBe(1);
  });

  it('rejects an unknown flag with exit code 2', async () => {
    const exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(run(['--fxi'], vaultDir, testPerUserLockNamespace))
      .rejects.toThrow(/process\.exit\(2\)/);
    expect(stderrSpy.mock.calls.flat().join('')).toContain("unknown flag '--fxi'");

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});

describe('doctor fix registry dispatch', () => {
  let vaultDir: string;
  let mycoHome: string;
  let savedMycoHome: string | undefined;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-registry-'));
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-registry-home-'));
    savedMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(mycoHome, { recursive: true, force: true });
    if (savedMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = savedMycoHome;
  });

  it('takes no action for a fixable check that carries no fixId — the registry is the only dispatch path', async () => {
    const actions = await fix(vaultDir, [{
      name: 'Daemon',
      status: 'warn',
      detail: 'Stale daemon.json (PID 424242 not running)',
      fixable: true,
    }]);
    expect(actions).toEqual([]);
  });

  it('reports a daemon state with no PID as not fixable (restart rewrites it)', async () => {
    const statePath = resolveDaemonServiceState(vaultDir, { env: process.env }).statePath;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ pid: 0, port: 12345 }), 'utf-8');

    const checks = await runChecks(vaultDir, testPerUserLockNamespace);
    const daemon = checks.find((c) => c.name === 'Daemon');
    expect(daemon).toBeDefined();
    expect(daemon!.status).toBe('warn');
    expect(daemon!.fixable).toBe(false);
    expect(daemon!.fixId).toBeUndefined();
    expect(daemon!.detail).toContain('records no PID');
  });

  it('daemon-stale fixer deletes via fixData.stalePid even when the detail omits the PID text', async () => {
    const statePath = resolveDaemonServiceState(vaultDir, { env: process.env }).statePath;
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ pid: 424242, port: 1 }), 'utf-8');

    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const actions = await fix(vaultDir, [{
        name: 'Daemon',
        status: 'warn',
        // Deliberately no "PID <n> not running" text — proves the fixer
        // reads structured fixData, not a detail regex.
        detail: 'Stale daemon state',
        fixable: true,
        fixId: 'daemon-stale',
        fixData: { stalePid: 424242 },
      }]);
      expect(actions).toContain('Removed stale daemon state (PID 424242)');
    } finally {
      errorSpy.mockRestore();
    }
    expect(fs.existsSync(statePath)).toBe(false);
  });
});

describe('Edge-case detector (R4.7)', () => {
  async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-edge-'));
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      return await fn(home);
    } finally {
      if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  it('flags cursor settings containing a shell-cd prefix', async () => {
    await withFakeHome(async (home) => {
      const cursor = path.join(home, '.cursor', 'settings.json');
      fs.mkdirSync(path.dirname(cursor), { recursive: true });
      fs.writeFileSync(cursor, JSON.stringify({
        hooks: { sessionStart: [{ command: 'cd "${CURSOR_PROJECT_DIR:-.}" && node /Users/me/.myco/launcher.cjs hook session-start --symbiont cursor' }] },
      }), 'utf-8');
      const rows = await checkSymbiontEdgeCases();
      const fails = rows.filter((c) => c.status === 'fail');
      expect(fails.some((c) => c.detail.includes('shell-cd prefix'))).toBe(true);
    });
  });

  it('flags claude hook groups missing a matcher field', async () => {
    await withFakeHome(async (home) => {
      const claude = path.join(home, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(claude), { recursive: true });
      fs.writeFileSync(claude, JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ command: 'node x' }] }] }, // missing matcher
      }), 'utf-8');
      const rows = await checkSymbiontEdgeCases();
      const fails = rows.filter((c) => c.status === 'fail');
      expect(fails.some((c) => c.detail.includes('missing `matcher`'))).toBe(true);
    });
  });

  it('flags hybrid-TOML codex config (file starts with JSON brace)', async () => {
    await withFakeHome(async (home) => {
      const codex = path.join(home, '.codex', 'config.toml');
      fs.mkdirSync(path.dirname(codex), { recursive: true });
      fs.writeFileSync(codex, '{\n  "hooks": {}\n}\n', 'utf-8');
      const rows = await checkSymbiontEdgeCases();
      const fails = rows.filter((c) => c.status === 'fail');
      expect(fails.some((c) => c.detail.includes('starts with JSON'))).toBe(true);
    });
  });

  it('flags stale escaped smoke-launcher hooks as fixable', async () => {
    await withFakeHome(async (home) => {
      const claude = path.join(home, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(claude), { recursive: true });
      fs.writeFileSync(claude, JSON.stringify({
        hooks: {
          UserPromptSubmit: [
            { matcher: '', hooks: [{ type: 'command', command: 'cd "${CLAUDE_PROJECT_DIR:-.}" && node /tmp/myco-final-smoke-AAAA/home/launcher.cjs hook user-prompt-submit --symbiont claude-code' }] },
            { matcher: '', hooks: [{ type: 'command', command: 'cd "${CLAUDE_PROJECT_DIR:-.}" && node /Users/test/.myco/launcher.cjs hook user-prompt-submit --symbiont claude-code' }] },
          ],
        },
      }), 'utf-8');
      const rows = await checkSymbiontEdgeCases();
      const warnings = rows.filter((c) => c.status === 'warn');
      expect(warnings.some((c) => c.fixable && c.detail.includes('Stale escaped smoke-launcher hooks'))).toBe(true);
    });
  });

  it('keeps the cursor shell-cd row non-fixable (legacy settings.json — the global refresh writes hooks.json)', async () => {
    await withFakeHome(async (home) => {
      const cursor = path.join(home, '.cursor', 'settings.json');
      fs.mkdirSync(path.dirname(cursor), { recursive: true });
      fs.writeFileSync(cursor, JSON.stringify({
        hooks: { sessionStart: [{ command: 'cd "${CURSOR_PROJECT_DIR:-.}" && node /Users/me/.myco/launcher.cjs hook session-start --symbiont cursor' }] },
      }), 'utf-8');
      const rows = await checkSymbiontEdgeCases();
      const row = rows.find((c) => c.detail.includes('shell-cd prefix'));
      expect(row).toBeDefined();
      expect(row!.fixable).toBe(false);
      expect(row!.fixId).toBeUndefined();
      expect(row!.detail).not.toContain('--fix');
      expect(row!.detail).toContain('legacy file — current installs use hooks.json');
    });
  });

  it('marks the claude matcher row fixable and notes foreign groups need manual edits', async () => {
    await withFakeHome(async (home) => {
      const claude = path.join(home, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(claude), { recursive: true });
      fs.writeFileSync(claude, JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ command: 'node x' }] }] }, // missing matcher
      }), 'utf-8');
      const rows = await checkSymbiontEdgeCases();
      const row = rows.find((c) => c.detail.includes('missing `matcher`'));
      expect(row).toBeDefined();
      expect(row!.fixable).toBe(true);
      expect(row!.fixId).toBe('symbiont-global-refresh');
      expect(row!.detail).toContain('foreign groups need manual edits');
    });
  });

  it('keeps the hybrid-TOML codex row non-fixable and no longer suggests doctor --fix', async () => {
    await withFakeHome(async (home) => {
      const codex = path.join(home, '.codex', 'config.toml');
      fs.mkdirSync(path.dirname(codex), { recursive: true });
      fs.writeFileSync(codex, '{\n  "hooks": {}\n}\n', 'utf-8');
      const rows = await checkSymbiontEdgeCases();
      const row = rows.find((c) => c.detail.includes('starts with JSON'));
      expect(row).toBeDefined();
      expect(row!.fixable).toBe(false);
      expect(row!.fixId).toBeUndefined();
      expect(row!.detail).not.toContain('doctor --fix');
      expect(row!.detail).toContain('Restore valid TOML by hand');
    });
  });

  it('emits ok row when no edge cases are present', async () => {
    await withFakeHome(async () => {
      const rows = await checkSymbiontEdgeCases();
      expect(rows.length).toBeGreaterThan(0);
      // First (and likely only) row when nothing is wrong: the ok summary.
      expect(rows[0]!.status).toBe('ok');
      expect(rows[0]!.detail).toContain('No known broken-edge states');
    });
  });
});

describe('checkMigrationStatus', () => {
  async function withScopedDb<T>(fn: (db: ReturnType<typeof openDatabase>) => Promise<T>): Promise<T> {
    const db = openDatabase(':memory:');
    try {
      createSchema(db);
      return await withDatabase(db, () => fn(db));
    } finally {
      db.close();
    }
  }

  it('reports greenfield state when the migration log is empty', async () => {
    await withScopedDb(async () => {
      const rows = await checkMigrationStatus('/tmp/unused');
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('ok');
      expect(rows[0]!.detail).toContain('greenfield');
    });
  });

  it('emits one warning per failed project with root, error, and doctor --fix hint', async () => {
    await withScopedDb(async (db) => {
      // Seed a pass with two erroring projects + one clean one. The
      // recorder persists only the summary row + one error row per
      // failed project; checkMigrationStatus must surface a separate
      // warning per error row, each carrying the project's root and the
      // underlying error message.
      recordMigrationPass(db, {
        passId: 'test-pass',
        passedAt: 0,
        projectsVisited: 3,
        projectsCleaned: 1,
        projectsErrored: 2,
        outcomes: [
          {
            groveId: 'g1',
            projectId: 'proj_clean',
            projectRoot: '/tmp/clean',
            alreadyDone: false,
            noLegacyArtifacts: false,
            archivedFiles: [],
            cleanedSymbionts: ['claude-code'],
            machineIdPropagated: false,
          },
          {
            groveId: 'g1',
            projectId: 'proj_locked',
            projectRoot: '/tmp/locked-proj',
            alreadyDone: false,
            noLegacyArtifacts: false,
            archivedFiles: [],
            cleanedSymbionts: [],
            machineIdPropagated: false,
            error: 'EBUSY: resource busy',
          },
          {
            groveId: 'g1',
            projectId: 'proj_denied',
            projectRoot: '/tmp/denied-proj',
            alreadyDone: false,
            noLegacyArtifacts: false,
            archivedFiles: [],
            cleanedSymbionts: [],
            machineIdPropagated: false,
            error: 'EACCES: permission denied',
          },
        ],
      });

      const rows = await checkMigrationStatus('/tmp/unused');
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.status).toBe('warn');
        expect(row.fixable).toBe(true);
        expect(row.detail).toContain('myco doctor --fix');
      }
      const detailsByRoot = new Map(rows.map((r) => [r.detail.match(/project (\/[^:]+):/)?.[1] ?? '', r.detail]));
      expect(detailsByRoot.get('/tmp/locked-proj')).toContain('EBUSY');
      expect(detailsByRoot.get('/tmp/denied-proj')).toContain('EACCES');
    });
  });
});

describe('doctor --fix stale smoke-launcher scrub', () => {
  async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-fix-smoke-'));
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      return await fn(home);
    } finally {
      if (prev === undefined) delete process.env.HOME; else process.env.HOME = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  it('scrubs stale escaped smoke-launcher hooks from global settings files', async () => {
    await withFakeHome(async (home) => {
      const claude = path.join(home, '.claude', 'settings.json');
      fs.mkdirSync(path.dirname(claude), { recursive: true });
      fs.writeFileSync(claude, JSON.stringify({
        hooks: {
          Stop: [
            { matcher: '', hooks: [{ type: 'command', command: 'cd "${CLAUDE_PROJECT_DIR:-.}" && node /tmp/myco-wave2-smoke-BBBB/home/launcher.cjs hook stop --symbiont claude-code' }] },
            // NEW marker-bearing binary form (no `.cjs`) — the current install,
            // which the scrub must preserve.
            { matcher: '', hooks: [{ type: 'command', command: 'cd "${CLAUDE_PROJECT_DIR:-.}" && /Users/test/.local/bin/myco hook stop --symbiont claude-code --myco-managed' }] },
            { matcher: '', hooks: [{ type: 'command', command: 'echo user-tenant' }] },
          ],
        },
      }), 'utf-8');

      const actions = await fix('/tmp/unused', [{
        name: 'Edge cases',
        status: 'warn',
        detail: `Stale escaped smoke-launcher hooks in ${claude} (1 group(s)). Run \`myco doctor --fix\` to scrub them.`,
        fixable: true,
        fixId: 'smoke-launcher-scrub',
      }]);

      expect(actions.some((action) => action.includes('Scrubbed 1 stale smoke-launcher hook group'))).toBe(true);
      const after = JSON.parse(fs.readFileSync(claude, 'utf-8'));
      expect(after.hooks.Stop).toHaveLength(2);
      expect(after.hooks.Stop[0].hooks[0].command).toContain('--myco-managed');
      expect(after.hooks.Stop[1].hooks[0].command).toBe('echo user-tenant');
    });
  });
});

describe('doctor --fix migration retry', () => {
  async function withScopedDb<T>(fn: (db: ReturnType<typeof openDatabase>) => Promise<T>): Promise<T> {
    const db = openDatabase(':memory:');
    try {
      createSchema(db);
      return await withDatabase(db, () => fn(db));
    } finally {
      db.close();
    }
  }

  let tmpHome: string;
  let projectRoot: string;
  let prevHome: string | undefined;
  let prevMycoHome: string | undefined;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-fix-'));
    projectRoot = fs.mkdtempSync(path.join(tmpHome, 'proj-'));
    fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, '.myco', 'myco.yaml'),
      'version: 3\nconfig_version: 9\n',
      'utf-8',
    );
    prevHome = process.env.HOME;
    prevMycoHome = process.env.MYCO_HOME;
    process.env.HOME = tmpHome;
    process.env.MYCO_HOME = path.join(tmpHome, '.myco');
    clearGroveRegistryCaches();
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevMycoHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = prevMycoHome;
    clearGroveRegistryCaches();
  });

  it('re-runs the walker per failed project and reports succeeded when the prior error clears', async () => {
    await withScopedDb(async (db) => {
      const mycoHome = path.join(tmpHome, '.myco');
      const grove = createGrove('default', mycoHome);
      registerProjectInGrove(grove.id, {
        projectId: 'proj_retry_ok',
        projectName: 'retry-ok',
        projectRoot,
      }, mycoHome);

      // Seed a stuck error row for this project — the walker on the next
      // pass will visit it (its .agents/myco-run.cjs doesn't exist, so
      // there's nothing to clean up; cleanedSymbionts and removedFiles
      // stay empty, noOp is true, no error thrown).
      recordMigrationPass(db, {
        passId: 'prior-pass',
        passedAt: 0,
        projectsVisited: 1,
        projectsCleaned: 0,
        projectsErrored: 1,
        outcomes: [{
          groveId: grove.id,
          project: { project_id: 'proj_retry_ok', name: 'retry-ok', root: projectRoot, created_at: '', updated_at: '' },
          cleanedSymbionts: [],
          removedFiles: [],
          noOp: false,
          error: 'EBUSY: resource busy (transient)',
        }],
      });

      const stuckCheck: DoctorCheck = {
        name: 'Migration',
        status: 'warn',
        detail: `Migration failed for project ${projectRoot}: EBUSY: resource busy (transient). Retry with \`myco doctor --fix\`.`,
        fixable: true,
        fixId: 'migration-retry',
        fixData: { projectRoot },
      };

      const actions = await fix(path.join(projectRoot, '.myco'), [stuckCheck]);
      expect(actions.some((a) => a === `Retried migration for ${projectRoot}: succeeded`)).toBe(true);

      // Audit-log dedup: the prior error row should now be gone since
      // the new pass visited the same project_id and produced no error.
      const remainingErrors = listMigrationErrors(db);
      expect(remainingErrors.some((r) => r.affected_project_id === 'proj_retry_ok')).toBe(false);
    });
  });

  it('returns no migration actions when no Migration checks are fixable', async () => {
    await withScopedDb(async () => {
      const actions = await fix('/tmp/unused', [
        { name: 'Migration', status: 'ok', detail: 'No issues.', fixable: false },
      ]);
      expect(actions.some((a) => a.startsWith('Retried migration'))).toBe(false);
    });
  });
});

describe('isSymbiontRegistered', () => {
  it('treats Pi plugin-file hooks as a valid registration surface', () => {
    const manifest = findManifest('pi');
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-pi-'));
    try {
      const pluginPath = path.join(projectRoot, manifest.registration!.hooksTarget!);
      fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
      fs.writeFileSync(pluginPath, '// myco:plugin-marker:pi\n', 'utf-8');

      expect(isSymbiontRegistered({
        manifest,
        binaryFound: false,
        configDirFound: true,
      }, projectRoot)).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('treats a cli-transport symbiont (codex) as registered via hooks, ignoring its (absent) MCP server', () => {
    const manifest = findManifest('codex');
    expect(manifestToolTransport(manifest)).toBe('cli');
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-codex-'));
    try {
      // Install codex's hooks but write NO `[mcp_servers.myco]` into its
      // config.toml — the post-feature steady state for a cli-transport
      // symbiont. Registration must be decided by hooks, not MCP.
      const hooksPath = path.join(projectRoot, manifest.registration!.hooksTarget!);
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(hooksPath, JSON.stringify({
        hooks: {
          Stop: [
            { command: 'node .agents/myco-run.cjs hook stop --symbiont codex' },
          ],
        },
      }), 'utf-8');
      const mcpPath = path.join(projectRoot, manifest.registration!.mcpTarget!);
      fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
      fs.writeFileSync(mcpPath, 'model = "gpt-5"\n', 'utf-8'); // TOML, no [mcp_servers.myco]

      expect(isSymbiontRegistered({
        manifest,
        binaryFound: false,
        configDirFound: true,
      }, projectRoot)).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('leaves an mcp-transport symbiont (claude-code) deciding on its MCP server', () => {
    const manifest = findManifest('claude-code');
    expect(manifestToolTransport(manifest)).toBe('mcp');
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-claude-'));
    try {
      // Hooks installed, but no MCP server: an mcp-transport symbiont keys
      // registration off the MCP target, so this stays unregistered —
      // unchanged by the cli-transport gate.
      const hooksPath = path.join(projectRoot, manifest.registration!.hooksTarget!);
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(hooksPath, JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ command: 'node .agents/myco-run.cjs hook stop --symbiont claude-code' }] },
          ],
        },
      }), 'utf-8');

      expect(isSymbiontRegistered({
        manifest,
        binaryFound: false,
        configDirFound: true,
      }, projectRoot)).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('treats Windsurf hook JSON as a valid registration surface', () => {
    const manifest = findManifest('windsurf');
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-windsurf-'));
    try {
      const hooksPath = path.join(projectRoot, manifest.registration!.hooksTarget!);
      fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
      fs.writeFileSync(hooksPath, JSON.stringify({
        hooks: {
          pre_user_prompt: [
            {
              command: 'cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && node .agents/myco-run.cjs hook user-prompt-submit --symbiont windsurf',
            },
          ],
        },
      }), 'utf-8');

      expect(isSymbiontRegistered({
        manifest,
        binaryFound: false,
        configDirFound: true,
      }, projectRoot)).toBe(true);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('isSymbiontRegisteredGlobally', () => {
  let savedHome: string | undefined;
  let home: string;

  beforeEach(() => {
    savedHome = process.env.HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-global-'));
    process.env.HOME = home;
  });
  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('returns false when no global agent config has Myco wired in', () => {
    const manifest = findManifest('windsurf');
    expect(isSymbiontRegisteredGlobally({
      manifest,
      binaryFound: false,
      configDirFound: true,
    })).toBe(false);
  });

  it('treats a cli-transport symbiont (codex) as globally registered via hooks, not MCP', () => {
    const manifest = findManifest('codex');
    expect(manifestToolTransport(manifest)).toBe('cli');
    const target = manifest.registration!.globalHooksTarget;
    expect(target, 'codex should declare a globalHooksTarget').toBeTruthy();
    const file = expandHome(target!);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      hooks: {
        Stop: [
          { command: 'node /Users/test/.myco/launcher.cjs hook stop --symbiont codex' },
        ],
      },
    }), 'utf-8');
    // No global config.toml MCP server written — the cli-transport steady
    // state. Global registration is decided by hooks.
    expect(isSymbiontRegisteredGlobally({
      manifest,
      binaryFound: false,
      configDirFound: true,
    })).toBe(true);
  });

  it('returns true when the global hooks file carries a Myco hook group', () => {
    const manifest = findManifest('windsurf');
    const target = manifest.registration!.globalHooksTarget;
    expect(target, 'windsurf should declare a globalHooksTarget').toBeTruthy();
    const file = expandHome(target!);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      hooks: {
        pre_user_prompt: [
          { command: 'cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" && node .myco/launcher.cjs hook user-prompt-submit --symbiont windsurf' },
        ],
      },
    }), 'utf-8');

    // Project-scope check is false (no project config), but global is wired —
    // the exact post-migration state that used to produce a false
    // "enabled but not registered" warning.
    expect(isSymbiontRegisteredGlobally({
      manifest,
      binaryFound: false,
      configDirFound: true,
    })).toBe(true);
  });
});

describe('checkCaptureFlow', () => {
  const roots: string[] = [];
  let savedMycoHome: string | undefined;

  afterEach(() => {
    closeDatabase();
    clearGroveRegistryCaches();
    if (savedMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = savedMycoHome;
    savedMycoHome = undefined;
    for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
    roots.length = 0;
  });

  /**
   * Provision a grove-bound vault (myco.yaml + project.toml + registry entry)
   * the way production does, then seed its Grove DB with sessions of the given
   * ages (in days). Returns the vault dir checkCaptureFlow reads.
   */
  function seedVault(ages: number[]): string {
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-capture-'));
    roots.push(vaultRoot);
    const mycoHome = path.join(vaultRoot, 'home');
    fs.mkdirSync(mycoHome, { recursive: true });
    savedMycoHome ??= process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    const vaultDir = path.join(vaultRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), 'version: 3\n');

    const grove = createGrove('cap', mycoHome);
    const manifest = ensureProjectManifest(vaultDir, {
      projectName: 'cap',
      groveId: grove.id,
      groveSlug: grove.slug,
      groveName: grove.name,
    });
    registerProjectInGrove(grove.id, {
      projectId: manifest.project.id,
      projectName: 'cap',
      projectRoot: vaultRoot,
      bindingId: manifest.grove?.binding_id,
    }, mycoHome);

    const { databasePath } = resolveDaemonDataPaths(vaultDir);
    const db = initDatabase(databasePath);
    createSchema(db);
    const now = Math.floor(Date.now() / 1000);
    ages.forEach((ageDays, i) => {
      const at = now - ageDays * 86_400;
      upsertSession({ id: `cap-${i}`, agent: 'claude-code', started_at: at, created_at: at });
    });
    closeDatabase();
    return vaultDir;
  }

  it('reports ok with a friendly nudge for a vault that has captured nothing yet', async () => {
    const check = await checkCaptureFlow(seedVault([]), testPerUserLockNamespace);
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('No sessions captured yet');
  });

  it('reports ok when a session landed within the freshness window', async () => {
    const check = await checkCaptureFlow(seedVault([1]), testPerUserLockNamespace);
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('in the last 7 days');
  });

  it('warns when the newest session is stale (silent-capture-loss signature)', async () => {
    const check = await checkCaptureFlow(seedVault([30, 45]), testPerUserLockNamespace);
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('No sessions in the last 7 days');
  });
});
