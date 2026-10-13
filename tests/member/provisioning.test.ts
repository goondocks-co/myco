/**
 * Global member provisioning preserves foreign hooks and harness settings.
 * Settings prints the same hook block; join validates membership, and leave
 * preserves repository-level harness files.
 */
import { joinRefusalsDir } from '@myco/member/join-code.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { runJoin, runLeave, runStatus, runProvision } from '@myco/cli/member.js';
import { run as runSettings } from '@myco/cli/settings.js';
import { CREDENTIAL_FLAG, NEVER_DRAINS_HOOK, hookNameInCommand } from '@myco/member/constants.js';
import { readRegistryEntry, REGISTRY_VERSION, writeRegistryEntry } from '@myco/member/registry.js';
import { MemberSpool } from '@myco/member/spool.js';
import { readProvisionRecord } from '@myco/symbionts/member-provision-record.js';
import { loadManifests } from '@myco/symbionts/detect.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { hookCommands } from '@myco/symbionts/member-hooks.js';
import { bindSandboxChildHome } from '../../scripts/test-environment.mjs';
import { memberRig, type MemberRig } from './helpers/server.js';
import { recordingPlatform } from './helpers/service-platform.js';

const PKG_ROOT = path.resolve(__dirname, '..', '..', 'packages', 'myco');
const MEMBER_TARGET = path.join('.claude', 'settings.json');
const PROJECT_TARGET = path.join('.claude', 'settings.json');
const PROJECT = 'proj_1';

let mycoHome: string;
let home: string;
let projectRoot: string;
let fixtureRoot: string;
let restoreHome: () => void;

const claudeCode = () => loadManifests().find((m) => m.name === 'claude-code')!;
const memberInstaller = (root = projectRoot) => new SymbiontInstaller(claudeCode(), root, PKG_ROOT, false);
const readTarget = (): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(home, MEMBER_TARGET), 'utf-8'));

/**
 * A repository whose only ignore rules are its own. `git check-ignore` reads
 * the developer's global excludes file (`~/.config/git/ignore`) whatever HOME
 * says, so a repo-local `core.excludesFile` is what makes "is this ignored?"
 * mean the same thing on every machine.
 */
function initRepo(root: string): void {
  execFileSync('git', ['init', '-q'], { cwd: root });
  const empty = path.join(root, '.git', 'empty-excludes');
  fs.writeFileSync(empty, '');
  execFileSync('git', ['config', 'core.excludesFile', empty], { cwd: root });
}

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-provisioning-'));
  home = path.join(fixtureRoot, 'home');
  mycoHome = path.join(home, '.myco');
  projectRoot = path.join(fixtureRoot, 'project');
  fs.mkdirSync(mycoHome, { recursive: true });
  fs.mkdirSync(projectRoot);
  fs.writeFileSync(path.join(mycoHome, 'machine_id'), 'm1');
  restoreHome = bindSandboxChildHome(fixtureRoot, { HOME: home, MYCO_HOME: mycoHome });
  resetMachineIdCache();
});
afterEach(() => {
  restoreHome();
  resetMachineIdCache();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('myco settings', () => {
  it('prints the same hook block with the sandbox credential source, and never --bare', () => {
    const out: string[] = [];
    const err: string[] = [];
    runSettings(['--harness', 'claude-code', '--project', PROJECT], { cwd: projectRoot, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });

    const printed = JSON.parse(out.join('\n')) as { hooks: Record<string, unknown[]> };
    expect(err).toEqual([]);
    expect(out.join('\n')).not.toContain('--bare');
    expect(Object.keys(printed.hooks)).not.toContain('PreToolUse');
    for (const command of hookCommands(printed.hooks)) {
      expect(command).toContain(`${CREDENTIAL_FLAG} env`);
      expect(command).not.toContain(`${CREDENTIAL_FLAG} registry`);
    }
    // Print-only: nothing on disk, in the project or anywhere else.
    expect(fs.existsSync(path.join(projectRoot, '.claude'))).toBe(false);

    // Same events, same hooks — one emitter, two credential sources.
    memberInstaller().install();
    expect(Object.keys(printed.hooks)).toEqual(Object.keys(readTarget().hooks as object));
  });

  it('refuses an unknown agent and a malformed project id', () => {
    const err: string[] = [];
    runSettings(['--harness', 'nosuch', '--project', PROJECT], { cwd: projectRoot, stderr: (l) => err.push(l) });
    runSettings(['--harness', 'claude-code', '--project', 'not a project id'], { cwd: projectRoot, stderr: (l) => err.push(l) });
    expect(err.join('\n')).toContain('unknown agent "nosuch"');
    expect(err.join('\n')).toContain('is not a project id');
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });
});

describe('myco member join / leave', () => {
  let rig: MemberRig;
  // A member joins a repository: `--root` must name a real project root.
  beforeEach(async () => { rig = await memberRig(); initRepo(projectRoot); });

  const workerFor = (platform = recordingPlatform()) => ({
    mycoHome, home, platform: 'darwin' as const, binaryPath: path.join(home, '.myco', 'bin', 'myco'), runner: platform.runner,
    detect: () => [{ id: 'codex', installed: true, authenticated: true }], admission: async () => 'admitted' as const,
    ownDeploymentUrls: async () => [], harnessDirs: () => [], lockDir: path.join(home, 'locks'),
  });

  const join = (args: string[], deps: Record<string, unknown> = {}) =>
    runJoin(args, { mycoHome, cwd: projectRoot, fetch: rig.fetch, packageRoot: PKG_ROOT, stdout: () => {}, stderr: () => {},
      worker: workerFor(), ...deps });

  it('verifies without writing to the server, records the entry, and provisions the agent', async () => {
    const platform = recordingPlatform();
    const seen: string[] = [];
    const watching = async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      seen.push(`${req.method} ${new URL(req.url).pathname}`);
      return rig.fetch(req);
    };
    const out: string[] = [];

    const entry = await join(['https://server.example', '--project', PROJECT, '--token-env', 'JOIN_TOKEN', '--root', projectRoot, '--provision', 'claude-code'], {
      fetch: watching, env: { JOIN_TOKEN: rig.token }, stdout: (l: string) => out.push(l), worker: workerFor(platform),
    });

    // The health check, the Project's blocks previewed for the cache (recorded for no session), and the read of this
    // machine's settings the join caches (#1393); nothing is written.
    expect(seen).toEqual(['GET /health', 'POST /context/session', 'POST /context/session', 'POST /members/settings']);
    expect(platform.commands).toEqual([]);
    expect(entry!.token).toBe(rig.token);
    expect(readRegistryEntry(projectRoot, mycoHome)!.projectId).toBe(PROJECT);
    expect(out.join('\n')).toContain(`joined ${PROJECT} at https://server.example`);
    expect(out.join('\n')).toContain('provisioned Claude Code');
    expect(readProvisionRecord(mycoHome)?.agents).toEqual(['claude-code']);
    expect(hookCommands(JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8')).hooks).length).toBeGreaterThan(0);
    // Nothing the join printed carries the token.
    expect(out.join('\n')).not.toContain(rig.token);
  });

  it('takes the token from stdin and never from a flag', async () => {
    const err: string[] = [];
    const entry = await join(['https://server.example', '--project', PROJECT, '--token-stdin', '--root', projectRoot], {
      stdin: () => `${rig.token}\n`,
    });
    expect(entry!.token).toBe(rig.token);

    // A flag that would carry the token is not a flag this op has.
    expect(await join(['https://server.example', '--project', PROJECT, '--token', rig.token], { stderr: (l: string) => err.push(l) })).toBeNull();
    expect(err.join('\n')).toContain('unknown option --token');
    // The refusal never echoes what was typed after the flag.
    expect(err.join('\n')).not.toContain(rig.token);
    expect(await join(['https://server.example', '--project', PROJECT, `--token=${rig.token}`], { stderr: (l: string) => err.push(l) })).toBeNull();
    expect(err.join('\n')).not.toContain(rig.token);
    expect(process.exitCode).toBe(2);
    process.exitCode = 0;
  });

  it('refuses plain http off this machine\'s loopback, a bad token, both token sources, and neither', async () => {
    const err: string[] = [];
    const deps = { stderr: (l: string) => err.push(l) };
    expect(await join(['http://server.example', '--project', PROJECT, '--token-stdin'], { ...deps, stdin: () => rig.token })).toBeNull();
    expect(await join(['https://server.example', '--project', PROJECT, '--token-stdin'], { ...deps, stdin: () => 'not-a-token' })).toBeNull();
    expect(await join(['https://server.example', '--project', PROJECT, '--token-stdin', '--token-env', 'X'], { ...deps, stdin: () => rig.token })).toBeNull();
    expect(await join(['https://server.example', '--project', PROJECT], deps)).toBeNull();
    expect(err.join('\n')).toContain("http://server.example is not a server URL a member accepts (https, or http on this machine's loopback)");
    expect(err.join('\n')).toContain('that is not a member token');
    expect(err.join('\n')).toContain('exactly one of --token-stdin or --token-env');
    expect(readRegistryEntry(projectRoot, mycoHome)).toBeNull();
    process.exitCode = 0;
  });

  it('leave forgets the membership and purge removes its spool while preserving global hooks for other projects', async () => {
    await join(['https://server.example', '--project', PROJECT, '--token-env', 'JOIN_TOKEN', '--root', projectRoot, '--provision', 'claude-code'], { env: { JOIN_TOKEN: rig.token } });
    const spool = new MemberSpool({ projectId: PROJECT, serverUrl: 'https://server.example' }, { mycoHome });
    fs.writeFileSync(path.join(spool.dir, 'sess-keep.jsonl'), '{}\n');
    const out: string[] = [];
    const deps = { mycoHome, cwd: projectRoot, packageRoot: PKG_ROOT, stdout: (l: string) => out.push(l), stderr: () => {} };

    expect(runLeave([], deps)).toBe(true);
    expect(readRegistryEntry(projectRoot, mycoHome)).toBeNull();
    expect(fs.existsSync(path.join(spool.dir, 'sess-keep.jsonl'))).toBe(true);
    expect(out.join('\n')).toContain('spool kept');

    // Re-join, then purge: the spool and the provisioned hooks both go.
    await join(['https://server.example', '--project', PROJECT, '--token-env', 'JOIN_TOKEN', '--root', projectRoot], { env: { JOIN_TOKEN: rig.token } });
    out.length = 0;
    fs.mkdirSync(joinRefusalsDir(mycoHome), { recursive: true });
    fs.writeFileSync(path.join(joinRefusalsDir(mycoHome), 'refused.json'), '{}');
    expect(runLeave(['--purge'], deps)).toBe(true);
    expect(fs.existsSync(spool.dir)).toBe(false);
    expect(fs.existsSync(joinRefusalsDir(mycoHome))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, MEMBER_TARGET))).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(true);
  });

  it('join and provision install no executor, and leave preserves existing services', async () => {
    const platform = recordingPlatform();
    const worker = {
      home, platform: 'darwin' as const, binaryPath: path.join(home, '.myco', 'bin', 'myco'),
      runner: platform.runner, detect: () => [{ id: 'codex', installed: true, authenticated: true }],
      admission: async () => 'admitted' as const, ownDeploymentUrls: async () => [], harnessDirs: () => [],
      lockDir: path.join(home, 'locks'),
    };
    const out: string[] = [];
    await join(['https://server.example', '--project', PROJECT, '--token-env', 'JOIN_TOKEN', '--root', projectRoot], {
      env: { JOIN_TOKEN: rig.token }, stdout: (l: string) => out.push(l), worker,
    });
    expect(platform.commands).toEqual([]);
    expect(out.join('\n')).not.toContain('a worker now runs');
    expect(runProvision(['claude-code', '--root', projectRoot], { mycoHome, cwd: projectRoot, packageRoot: PKG_ROOT, stdout: () => {}, stderr: () => {}, worker })).toBe(true);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(platform.commands).toEqual([]);
    const { installWorkerService, workerServiceSpec } = await import('@myco/runner/service.js');
    for (const executor of ['runner', 'legacy-member'] as const) {
      const spec = workerServiceSpec({ ...worker, mycoHome, serverUrl: 'https://server.example', executor }, []);
      installWorkerService({ ...worker, mycoHome, serverUrl: 'https://server.example', executor }, [], { runner: platform.runner });
      expect(platform.running.has(spec.unit.label)).toBe(true);
    }
    const before = [...platform.running];
    platform.commands.length = 0;
    expect(runLeave([], { mycoHome, cwd: projectRoot, packageRoot: PKG_ROOT, stdout: (l: string) => out.push(l), stderr: () => {}, worker })).toBe(true);
    expect(platform.commands).toEqual([]);
    expect([...platform.running]).toEqual(before);
  });

  it('installs no worker when asked not to', async () => {
    const out: string[] = [];
    await join(['https://server.example', '--project', PROJECT, '--token-env', 'JOIN_TOKEN', '--root', projectRoot, '--no-worker'], {
      env: { JOIN_TOKEN: rig.token }, stdout: (l: string) => out.push(l),
      worker: { home, platform: 'darwin', binaryPath: path.join(home, '.myco', 'bin', 'myco'),
        detect: () => [{ id: 'codex', installed: true, authenticated: true }], admission: async () => 'admitted',
        ownDeploymentUrls: async () => [], harnessDirs: () => [], lockDir: path.join(home, 'locks'),
        runner: () => { throw new Error('no platform command runs'); } },
    });
    expect(readRegistryEntry(projectRoot, mycoHome)).not.toBeNull();
    expect(out.join('\n')).not.toMatch(/worker/);
  });
});
