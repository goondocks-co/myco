/**
 * The home a capture invocation reads is the one the project is pinned to.
 *
 * A GUI-launched agent inherits no `MYCO_HOME` from any shell. Every one of its
 * hooks, and its MCP server, therefore resolved `~/.myco`, found no registry
 * entry for a project joined under another home, printed one line and exited 0 —
 * capture silently off, `hook_success` in the harness. These drive the entry
 * points with `MYCO_HOME` unset from a project carrying a trusted
 * `.myco/runtime.home` pin, and hold the precedence, the trust check, and the
 * count a missed membership leaves behind.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _resetPinRefusalReports, defaultMycoHome, resolveMycoHome, resolveMycoHomeWithSource } from '@myco/paths/home.js';
import { resolveMemberProjectRoot } from '@myco/member/credential.js';
import { resolveDeploymentUpstream } from '@myco/mcp/deployment-upstream.js';
import {
  listMissingMemberships,
  missingMembershipPath,
  MISSING_MEMBERSHIP_RETENTION_MS,
  pruneMissingMemberships,
  readMissingMembership,
  readMissingMemberships,
  recordMissingMembership,
} from '@myco/member/no-membership.js';
import { runJoin, runLeave, runStatus } from '@myco/cli/member.js';
import { RUNTIME_HOME_FILENAME } from '@myco/paths/home.js';
import { resolvePackageRoot } from '@myco/symbionts/detect.js';
import { spoolDirFor } from '@myco/member/spool.js';
import { mintMemberToken } from '@myco-server-worker/auth/tokens.js';
import { memberRig, tempMycoHome } from './helpers/server.js';
import { recordingFetch, registerTestMember, runHook } from './helpers/hooks.js';

const tmpDirs: string[] = [];
const originalCwd = process.cwd();
let savedMycoHome: string | undefined;
let savedHomeDir: string | undefined;
/** The `~` every unpinned resolution in this file falls back to, so nothing reaches the real one. */
let homeDir: string;

function tmpdir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

/** A project directory with a `runtime.home` pin, written at the mode a pin must have to be honoured. */
function pinnedProject(home: string, mode = 0o644): string {
  const project = tmpdir('myco-pinned-project-');
  fs.mkdirSync(path.join(project, '.myco'), { recursive: true });
  const pin = path.join(project, '.myco', 'runtime.home');
  fs.writeFileSync(pin, `${home}\n`, { mode });
  fs.chmodSync(pin, mode);
  return project;
}

/** A home directory whose `.myco/runtime.home` names another home — the machine-scope pin. */
function machinePinnedHomeDir(target: string): string {
  const homeDir = tmpdir('myco-fake-homedir-');
  fs.mkdirSync(path.join(homeDir, '.myco'), { recursive: true });
  fs.writeFileSync(path.join(homeDir, '.myco', 'runtime.home'), `${target}\n`, { mode: 0o644 });
  return homeDir;
}

beforeEach(() => {
  savedMycoHome = process.env.MYCO_HOME;
  savedHomeDir = process.env.HOME;
  delete process.env.MYCO_HOME;
  homeDir = tmpdir('myco-fallback-homedir-');
  process.env.HOME = homeDir;
  _resetPinRefusalReports();
});

afterEach(() => {
  process.chdir(originalCwd);
  if (savedMycoHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = savedMycoHome;
  if (savedHomeDir === undefined) delete process.env.HOME;
  else process.env.HOME = savedHomeDir;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('resolveMycoHome precedence', () => {
  it('takes the project pin found by walking up from the working directory', () => {
    const home = tmpdir('myco-pinned-home-');
    const project = pinnedProject(home);
    const nested = path.join(project, 'packages', 'thing');
    fs.mkdirSync(nested, { recursive: true });
    expect(resolveMycoHomeWithSource({ cwd: nested, env: {} })).toEqual({
      home,
      source: 'project-pin',
      pinPath: path.join(project, '.myco', 'runtime.home'),
    });
  });

  it('honours the machine pin at ~/.myco/runtime.home when no project pin exists', () => {
    const home = tmpdir('myco-machine-pinned-home-');
    const pinnedHomeDir = machinePinnedHomeDir(home);
    const unpinned = tmpdir('myco-unpinned-project-');
    expect(resolveMycoHomeWithSource({ cwd: unpinned, env: {}, homeDir: pinnedHomeDir })).toEqual({
      home,
      source: 'machine-pin',
      pinPath: path.join(pinnedHomeDir, '.myco', 'runtime.home'),
    });
  });

  it('falls back to ~/.myco when nothing is pinned', () => {
    const unpinned = tmpdir('myco-unpinned-project-');
    expect(resolveMycoHomeWithSource({ cwd: unpinned, env: {}, homeDir })).toEqual({
      home: path.join(homeDir, '.myco'),
      source: 'default',
    });
  });

  it('env beats the project pin beats the machine pin', () => {
    const fromEnv = tmpdir('myco-env-home-');
    const fromProject = tmpdir('myco-project-home-');
    const fromMachine = tmpdir('myco-machine-home-');
    const pinnedHomeDir = machinePinnedHomeDir(fromMachine);
    const project = pinnedProject(fromProject);

    expect(resolveMycoHomeWithSource({ cwd: project, homeDir: pinnedHomeDir, env: { MYCO_HOME: fromEnv } }))
      .toEqual({ home: fromEnv, source: 'env' });
    expect(resolveMycoHome({ cwd: project, homeDir: pinnedHomeDir, env: {} })).toBe(fromProject);
    expect(resolveMycoHome({ cwd: tmpdir('myco-unpinned-project-'), homeDir: pinnedHomeDir, env: {} })).toBe(fromMachine);
  });

  it('refuses a group-writable pin and a pin owned by another user, naming the reason', () => {
    const home = tmpdir('myco-pinned-home-');
    const loose = pinnedProject(home, 0o664);
    const refusals: Array<[string, string]> = [];
    const reportPinRefusal = (pinPath: string, reason: string): void => { refusals.push([pinPath, reason]); };

    expect(resolveMycoHome({ cwd: loose, homeDir, env: {}, reportPinRefusal })).toBe(path.join(homeDir, '.myco'));
    expect(refusals.map(([, reason]) => reason)).toEqual(['pin file mode 0664 is writable by group/other']);

    refusals.length = 0;
    const owned = pinnedProject(home);
    const foreignUid = (process.getuid?.() ?? 0) + 1;
    expect(resolveMycoHome({ cwd: owned, homeDir, env: {}, reportPinRefusal, getuid: () => foreignUid })).toBe(path.join(homeDir, '.myco'));
    expect(refusals).toEqual([[path.join(owned, '.myco', 'runtime.home'), `pin file owned by uid ${process.getuid?.()}, expected ${foreignUid}`]]);
  });

  it('reports one refused pin once, however often the home is resolved', () => {
    const home = tmpdir('myco-pinned-home-');
    const loose = pinnedProject(home, 0o664);
    const lines: string[] = [];
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: unknown) => boolean }).write = ((c: unknown) => { lines.push(String(c)); return true; }) as never;
    try {
      for (let i = 0; i < 5; i++) resolveMycoHome({ cwd: loose, homeDir, env: {} });
    } finally {
      (process.stderr as unknown as { write: unknown }).write = origErr;
    }
    expect(lines.filter((l) => l.includes('ignoring runtime home pin'))).toHaveLength(1);
  });
});

describe('a hook launched with no MYCO_HOME', () => {
  it('captures into the home the project pin names, from the directory the payload names', async () => {
    const home = tempMycoHome();
    tmpDirs.push(home);
    const project = pinnedProject(home);
    // The process runs somewhere else entirely: the payload's `cwd` is what
    // names the project, and the project's pin is what names the home.
    process.chdir(tmpdir('myco-elsewhere-'));
    const root = resolveMemberProjectRoot(project);
    const rig = await memberRig();
    registerTestMember({ mycoHome: home, token: rig.token, tokenId: rig.tokenId, expiresAt: rig.expiresAt, projectId: 'proj_1', root });
    const { fetch, requests } = recordingFetch(rig.fetch);

    const result = await runHook(
      'post-tool-use',
      { session_id: 'sess-pinned', cwd: project, tool_name: 'Read', tool_input: { file_path: '/a' } },
      { fetch, credential: 'registry' },
    );

    expect(result.stderr).not.toContain('no registry entry');
    expect(requests.map((r) => r.path)).toContain('/events');
    expect(rig.rows('events')).toBe(1);
    // The spool is under the pinned home, not under `~/.myco`.
    expect(fs.existsSync(spoolDirFor('proj_1', home))).toBe(true);
  });

  it('ignores an untrusted pin, captures nothing, and counts the loss under the home it did resolve', async () => {
    const pinned = tempMycoHome();
    tmpDirs.push(pinned);
    // The membership is real and sits in the pinned home; the pin is group-writable.
    const project = pinnedProject(pinned, 0o664);
    process.chdir(project);
    const root = resolveMemberProjectRoot(project);
    const rig = await memberRig();
    registerTestMember({ mycoHome: pinned, token: mintMemberToken(), projectId: 'proj_1', root });
    const { fetch, requests } = recordingFetch(rig.fetch);

    const result = await runHook(
      'post-tool-use',
      { session_id: 'sess-untrusted', cwd: project, tool_name: 'Read', tool_input: { file_path: '/a' } },
      { fetch, credential: 'registry' },
    );

    expect(result.stderr).toContain('pin file mode 0664 is writable by group/other');
    expect(result.stderr).toContain('no registry entry');
    expect(requests).toEqual([]);
    expect(rig.rows('events')).toBe(0);
    // Counted in the fallback home the refusal left it in, not in the pinned one.
    expect(readMissingMembership(root, path.join(homeDir, '.myco'))).toMatchObject({ count: 1 });
    expect(readMissingMembership(root, pinned)).toBeNull();
  });
});

describe('the MCP bridge with no MYCO_HOME', () => {
  it('resolves its Deployment upstream from the pinned home', () => {
    const home = tempMycoHome();
    tmpDirs.push(home);
    const project = pinnedProject(home);
    process.chdir(project);
    registerTestMember({
      mycoHome: home, token: mintMemberToken(), projectId: 'proj_1',
      serverUrl: 'https://pinned.example', root: resolveMemberProjectRoot(project),
    });

    const upstream = resolveDeploymentUpstream('registry', { cwd: project, env: {}, invokedBy: 'mcp' });
    expect(upstream?.mcpUrl.toString()).toBe('https://pinned.example/mcp');
    expect(upstream?.projectId).toBe('proj_1');
  });
});

describe('hooks that find no membership', () => {
  it('are counted under the resolved home and reported by `myco member status`', async () => {
    const home = tempMycoHome();
    tmpDirs.push(home);
    const project = pinnedProject(home);
    process.chdir(project);
    const root = resolveMemberProjectRoot(project);
    const rig = await memberRig();
    const { fetch, requests } = recordingFetch(rig.fetch);

    for (const sessionId of ['sess-a', 'sess-b']) {
      await runHook(
        'post-tool-use',
        { session_id: sessionId, cwd: project, tool_name: 'Read', tool_input: { file_path: '/a' } },
        { fetch, credential: 'registry' },
      );
    }
    expect(requests).toEqual([]);

    // The count lands under the home the hook resolved — the pinned one.
    expect(fs.existsSync(missingMembershipPath(root, home))).toBe(true);
    expect(readMissingMembership(root, home)).toMatchObject({ root, count: 2, lastInvokedBy: 'hook post-tool-use' });
    expect(listMissingMemberships(home).map((r) => r.root)).toEqual([root]);

    const lines: string[] = [];
    runStatus([], { cwd: project, stdout: (l) => lines.push(l), stderr: () => {} });
    expect(lines.join('\n')).toContain(`2 hook invocation(s) found no registry entry for ${root}`);
  });
});

describe('a resolution that names no directory', () => {
  it('does not walk: only a caller that names a directory gets the project pin', () => {
    // The daemon, a Grove read, anything serving another project — none of them
    // are "about" the directory the process happens to stand in, and a walk
    // there would hand them whichever home that directory is pinned to.
    const home = tmpdir('myco-pinned-home-');
    const project = pinnedProject(home);
    const previous = process.cwd();
    process.chdir(project);
    try {
      expect(resolveMycoHomeWithSource({ env: {}, homeDir })).toEqual({
        home: path.join(homeDir, '.myco'),
        source: 'default',
      });
      expect(resolveMycoHome({ cwd: process.cwd(), env: {}, homeDir })).toBe(home);
    } finally {
      process.chdir(previous);
    }
  });
});

describe('a pin value that is not an absolute path', () => {
  it('is refused, so a pin committed into a repository cannot redirect a clone', () => {
    const project = tmpdir('myco-relative-pin-');
    fs.mkdirSync(path.join(project, '.myco'), { recursive: true });
    const pin = path.join(project, '.myco', 'runtime.home');
    fs.writeFileSync(pin, 'vendor/home\n');
    fs.chmodSync(pin, 0o644);
    const refusals: string[] = [];
    expect(resolveMycoHome({ cwd: project, homeDir, env: {}, reportPinRefusal: (_p, reason) => { refusals.push(reason); } }))
      .toBe(path.join(homeDir, '.myco'));
    expect(refusals).toEqual(['home "vendor/home" is not an absolute path']);
  });

  it('is refused when the pin file is a symlink, whoever owns what it points at', () => {
    const home = tmpdir('myco-pinned-home-');
    const target = path.join(tmpdir('myco-link-target-'), 'home-value');
    fs.writeFileSync(target, `${home}\n`, { mode: 0o644 });
    const project = tmpdir('myco-symlink-pin-');
    fs.mkdirSync(path.join(project, '.myco'), { recursive: true });
    fs.symlinkSync(target, path.join(project, '.myco', 'runtime.home'));
    const refusals: string[] = [];
    expect(resolveMycoHome({ cwd: project, homeDir, env: {}, reportPinRefusal: (_p, reason) => { refusals.push(reason); } }))
      .toBe(path.join(homeDir, '.myco'));
    expect(refusals).toEqual(['pin file is a symlink']);
  });
});

describe('`myco member join` under a non-default home', () => {
  /** A project directory a registration site will accept: `isSafeProjectRoot` wants a real repo. */
  const joinableProject = (prefix: string): string => {
    const project = tmpdir(prefix);
    fs.mkdirSync(path.join(project, '.myco'), { recursive: true });
    execFileSync('git', ['init', '--quiet'], { cwd: project, stdio: 'ignore' });
    return project;
  };

  const joinDeps = (project: string, home: string, out: string[]) => ({
    cwd: project,
    mycoHome: home,
    stdout: (l: string) => out.push(l),
    stderr: (l: string) => out.push(l),
    env: { MYCO_TEST_TOKEN: mintMemberToken() } as NodeJS.ProcessEnv,
    fetch: (async () => new Response('{}', { status: 200 })) as never,
    packageRoot: project,
  });

  it('pins the project to that home, so its hooks find the membership with no environment', async () => {
    const home = tempMycoHome();
    tmpDirs.push(home);
    const project = joinableProject('myco-join-project-');
    const out: string[] = [];

    await runJoin(['https://srv.example', '--project', 'proj_1', '--token-env', 'MYCO_TEST_TOKEN'], joinDeps(project, home, out));

    const pin = path.join(project, '.myco', 'runtime.home');
    expect(fs.readFileSync(pin, 'utf-8').trim()).toBe(home);
    expect((fs.statSync(pin).mode & 0o777).toString(8)).toBe('644');
    expect(out.join('\n')).toContain(`pinned this project to ${home}`);
    // And the pin is what a hook with no environment now resolves.
    expect(resolveMycoHome({ cwd: project, homeDir, env: {} })).toBe(home);
  });

  it('keeps the pin out of git: the vault .gitignore is written before it', async () => {
    const home = tempMycoHome();
    tmpDirs.push(home);
    const project = joinableProject('myco-join-gitignore-');
    const out: string[] = [];

    await runJoin(['https://srv.example', '--project', 'proj_1', '--token-env', 'MYCO_TEST_TOKEN'], joinDeps(project, home, out));

    // Asked of git itself: the pin names an absolute path on THIS machine, and a
    // committed one would route a teammate's capture at a home they do not have —
    // trusted, because their clone makes them its owner.
    const ignored = execFileSync('git', ['check-ignore', '-v', path.join('.myco', RUNTIME_HOME_FILENAME)], { cwd: project, encoding: 'utf-8' });
    expect(ignored).toContain(RUNTIME_HOME_FILENAME);
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf-8' }))
      .not.toContain(RUNTIME_HOME_FILENAME);
  });

  it('provisions an MCP entry that names no home, even with the pin already written', async () => {
    const home = tempMycoHome();
    tmpDirs.push(home);
    const project = joinableProject('myco-join-mcp-');
    // The pin FIRST: this is the state every provisioning run meets once join
    // writes one, and the state under which the entry could pick a home up.
    fs.writeFileSync(path.join(project, '.myco', RUNTIME_HOME_FILENAME), `${home}\n`, { mode: 0o644 });
    fs.chmodSync(path.join(project, '.myco', RUNTIME_HOME_FILENAME), 0o644);
    const out: string[] = [];

    await runJoin(
      ['https://srv.example', '--project', 'proj_1', '--token-env', 'MYCO_TEST_TOKEN', '--provision', 'claude-code'],
      { ...joinDeps(project, home, out), packageRoot: resolvePackageRoot() },
    );

    // `.mcp.json` is committed in a normal repo: a machine's home path in it
    // travels to everyone who clones. `myco mcp` reads the pin itself.
    const mcp = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf-8')) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    expect(Object.keys(mcp.mcpServers)).toEqual(['myco']);
    expect(mcp.mcpServers.myco.env?.MYCO_HOME).toBeUndefined();
    expect(JSON.stringify(mcp)).not.toContain(home);
  });

  it('refuses to overwrite a pin naming another home, and says how to settle it', async () => {
    const ours = tempMycoHome();
    const theirs = tmpdir('myco-other-home-');
    tmpDirs.push(ours);
    const project = joinableProject('myco-join-conflict-');
    const pin = path.join(project, '.myco', RUNTIME_HOME_FILENAME);
    fs.writeFileSync(pin, `${theirs}\n`, { mode: 0o644 });
    fs.chmodSync(pin, 0o644);
    const out: string[] = [];

    await runJoin(['https://srv.example', '--project', 'proj_1', '--token-env', 'MYCO_TEST_TOKEN'], joinDeps(project, ours, out));

    // The dogfood hazard: `make dev-link` pinned this project, and a join under
    // another home must not silently move every CLI call and hook in it.
    expect(fs.readFileSync(pin, 'utf-8').trim()).toBe(theirs);
    const said = out.join('\n');
    expect(said).toContain(theirs);
    expect(said).toContain(`MYCO_HOME=${theirs} myco member join`);
    expect(said).toContain('leave --purge');
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });

  it('refuses a stale pin on a join into the default home, rather than reporting a success that captures nowhere', async () => {
    const stale = tmpdir('myco-stale-home-');
    const project = joinableProject('myco-join-stale-');
    const pin = path.join(project, '.myco', RUNTIME_HOME_FILENAME);
    fs.writeFileSync(pin, `${stale}\n`, { mode: 0o644 });
    fs.chmodSync(pin, 0o644);
    const out: string[] = [];

    await runJoin(
      ['https://srv.example', '--project', 'proj_1', '--token-env', 'MYCO_TEST_TOKEN'],
      { ...joinDeps(project, defaultMycoHome(homeDir), out), mycoHome: defaultMycoHome(homeDir) },
    );

    // Nothing is written for the default home — but a pin naming another one is
    // still what every hook here will follow, so the join must not go quiet.
    expect(fs.readFileSync(pin, 'utf-8').trim()).toBe(stale);
    expect(out.join('\n')).toContain(stale);
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });

  it('takes the pin on a plain `leave`, so a left project stops counting misses', async () => {
    const home = tempMycoHome();
    tmpDirs.push(home);
    const project = joinableProject('myco-leave-plain-');
    const out: string[] = [];
    await runJoin(['https://srv.example', '--project', 'proj_1', '--token-env', 'MYCO_TEST_TOKEN'], joinDeps(project, home, out));
    expect(fs.existsSync(path.join(project, '.myco', RUNTIME_HOME_FILENAME))).toBe(true);

    runLeave([], { cwd: project, mycoHome: home, stdout: (l) => out.push(l), stderr: () => {} });

    // The membership is gone; a pin left standing would send every hook here to
    // look for it and count another miss, for ever.
    expect(fs.existsSync(path.join(project, '.myco', RUNTIME_HOME_FILENAME))).toBe(false);
  });

  it('writes no pin for the default home, and `leave --purge` takes the pin it wrote', async () => {
    const project = joinableProject('myco-join-default-');
    const out: string[] = [];
    await runJoin(
      ['https://srv.example', '--project', 'proj_1', '--token-env', 'MYCO_TEST_TOKEN'],
      { ...joinDeps(project, defaultMycoHome(homeDir), out), mycoHome: defaultMycoHome(homeDir) },
    );
    expect(fs.existsSync(path.join(project, '.myco', 'runtime.home'))).toBe(false);

    const home = tempMycoHome();
    tmpDirs.push(home);
    const pinned = joinableProject('myco-join-purge-');
    await runJoin(['https://srv.example', '--project', 'proj_1', '--token-env', 'MYCO_TEST_TOKEN'], joinDeps(pinned, home, out));
    expect(fs.existsSync(path.join(pinned, '.myco', 'runtime.home'))).toBe(true);

    runLeave(['--purge'], { cwd: pinned, mycoHome: home, stdout: (l) => out.push(l), stderr: () => {}, packageRoot: pinned });
    expect(fs.existsSync(path.join(pinned, '.myco', 'runtime.home'))).toBe(false);
  });
});

describe('the record of missed captures', () => {
  it('ages out a root nothing has fired from for the retention window, swept by status', () => {
    const home = tempMycoHome();
    tmpDirs.push(home);
    const project = pinnedProject(home);
    process.chdir(project);
    const stale = '/tmp/some-old-checkout';
    const fresh = resolveMemberProjectRoot(project);
    const now = Date.now();
    recordMissingMembership(stale, { mycoHome: home, now: () => now - MISSING_MEMBERSHIP_RETENTION_MS - 1 });
    recordMissingMembership(fresh, { mycoHome: home, now: () => now });
    // The hook that counted them swept nothing: it has milliseconds, and nothing
    // reads this store until someone asks.
    expect(listMissingMemberships(home).map((r) => r.root).sort()).toEqual([fresh, stale].sort());

    runStatus([], { cwd: project, now: () => now, stdout: () => {}, stderr: () => {} });

    expect(listMissingMemberships(home).map((r) => r.root)).toEqual([fresh]);
  });

  it('prunes the file a record was read from, never a path recomputed from its contents', () => {
    const home = tempMycoHome();
    tmpDirs.push(home);
    const now = Date.now();
    recordMissingMembership('/tmp/a-checkout', { mycoHome: home, now: () => now - MISSING_MEMBERSHIP_RETENTION_MS - 1 });
    const [{ file }] = readMissingMemberships(home);
    // A record whose `root` no longer hashes to the file holding it: recomputing
    // the path would leave this one standing and delete some other root's.
    const tampered = JSON.parse(fs.readFileSync(file, 'utf-8')) as { root: string };
    tampered.root = '/tmp/a-different-checkout';
    fs.writeFileSync(file, JSON.stringify(tampered), { mode: 0o600 });

    expect(pruneMissingMemberships(home, now)).toBe(1);
    expect(readMissingMemberships(home)).toEqual([]);
  });
});
