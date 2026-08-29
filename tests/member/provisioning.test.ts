/**
 * Provisioning: the `member-project` install scope writes the member's hooks
 * into the symbiont's own member target and nothing else — never the file a
 * 1.4 project or global install owns — preserving foreign hooks and the
 * file's other keys, asserting the target is git-ignored; `myco settings`
 * prints the same block with `--credential env`; `myco member join` verifies
 * without writing to the server and never takes a token on the command line;
 * `myco member leave --purge` removes what provisioning wrote.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { runJoin, runLeave } from '@myco/cli/member.js';
import { run as runSettings } from '@myco/cli/settings.js';
import { CREDENTIAL_FLAG, NEVER_DRAINS_HOOK, hookNameInCommand } from '@myco/member/constants.js';
import { readRegistryEntry } from '@myco/member/registry.js';
import { MemberSpool } from '@myco/member/spool.js';
import { loadManifests } from '@myco/symbionts/detect.js';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { hookCommands } from '@myco/symbionts/member-hooks.js';
import { memberRig, tempMycoHome, type MemberRig } from './helpers/server.js';

const PKG_ROOT = path.resolve(__dirname, '..', '..', 'packages', 'myco');
const MEMBER_TARGET = path.join('.claude', 'settings.local.json');
const PROJECT_TARGET = path.join('.claude', 'settings.json');
const PROJECT = 'proj_1';

let mycoHome: string;
let home: string;
let projectRoot: string;
const saved = { home: process.env.HOME, mycoHome: process.env.MYCO_HOME };

const claudeCode = () => loadManifests().find((m) => m.name === 'claude-code')!;
const memberInstaller = (root = projectRoot) => new SymbiontInstaller(claudeCode(), root, PKG_ROOT, false, undefined, null, 'member-project');
const readTarget = (root = projectRoot): Record<string, unknown> => JSON.parse(fs.readFileSync(path.join(root, MEMBER_TARGET), 'utf-8'));

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
  mycoHome = tempMycoHome();
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-home-dir-'));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-project-'));
  process.env.MYCO_HOME = mycoHome;
  process.env.HOME = home;
  resetMachineIdCache();
});
afterEach(() => {
  if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  if (saved.mycoHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = saved.mycoHome;
  resetMachineIdCache();
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('the member-project install scope', () => {
  it('writes the member hooks to the manifest\'s member target and touches no other settings file', () => {
    expect(memberInstaller().install().hooks).toBe(true);

    const commands = hookCommands(readTarget().hooks);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toContain(`${CREDENTIAL_FLAG} registry`);
      expect(command).toContain('--myco-managed');
      expect(command).toContain('--symbiont claude-code');
      expect(path.isAbsolute(command.split(' ')[0])).toBe(true);
      expect(hookNameInCommand(command)).not.toBe(NEVER_DRAINS_HOOK);
    }
    expect(Object.keys(readTarget().hooks as object)).not.toContain('PreToolUse');
    expect(JSON.stringify(readTarget())).not.toContain('allowedEnvVars');

    // The 1.4 project file and the user-global file are the two a member install must never reach.
    expect(fs.existsSync(path.join(projectRoot, PROJECT_TARGET))).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
    // The member scope writes two files for an mcp-transport symbiont: the hooks target and the MCP server list.
    expect(fs.readdirSync(projectRoot).sort()).toEqual(['.claude', '.mcp.json']);
    expect(fs.readdirSync(path.join(projectRoot, '.claude'))).toEqual(['settings.local.json']);
    const mcp = JSON.parse(fs.readFileSync(path.join(projectRoot, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(Object.keys(mcp.mcpServers)).toEqual(['myco']);
    expect(mcp.mcpServers.myco.args).toEqual(['mcp', CREDENTIAL_FLAG, 'registry']);
    expect(path.isAbsolute(mcp.mcpServers.myco.command)).toBe(true);
  });

  it('preserves the file\'s other keys and every hook it does not own', () => {
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, MEMBER_TARGET), JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      enabledMcpjsonServers: ['someone-else'],
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: '/usr/local/bin/their-tool' }] }] },
    }));

    expect(memberInstaller().install().hooks).toBe(true);

    const settings = readTarget();
    expect(settings.permissions).toEqual({ allow: ['Bash(ls:*)'] });
    expect(settings.enabledMcpjsonServers).toEqual(['someone-else']);
    const stop = (settings.hooks as Record<string, unknown[]>).Stop;
    expect(hookCommands(stop)).toContain('/usr/local/bin/their-tool');
    expect(hookCommands(stop).some((c) => c.includes(`${CREDENTIAL_FLAG} registry`))).toBe(true);

    // A second pass replaces Myco's groups without duplicating them or the foreign one.
    memberInstaller().install();
    expect(hookCommands((readTarget().hooks as Record<string, unknown[]>).Stop).length).toBe(2);
  });

  it('adds an unignored member target to .git/info/exclude', () => {
    initRepo(projectRoot);
    memberInstaller().install();
    const exclude = fs.readFileSync(path.join(projectRoot, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude.split('\n')).toContain('.claude/settings.local.json');

    // Already ignored the second time: the entry is not repeated.
    memberInstaller().install();
    expect(fs.readFileSync(path.join(projectRoot, '.git', 'info', 'exclude'), 'utf-8')).toBe(exclude);
  });

  it('installs nothing for a symbiont whose hooks are a plugin file, and none declares a member target', () => {
    const pluginFile = loadManifests().filter((m) => m.registration?.hooksFormat === 'plugin-file');
    expect(pluginFile.length).toBeGreaterThan(0);
    for (const manifest of pluginFile) {
      expect({ agent: manifest.name, memberTarget: manifest.registration?.memberHooksTarget }).toEqual({ agent: manifest.name, memberTarget: undefined });
      const installer = new SymbiontInstaller(manifest, projectRoot, PKG_ROOT, false, undefined, null, 'member-project');
      expect({ agent: manifest.name, hooks: installer.install().hooks }).toEqual({ agent: manifest.name, hooks: false });
    }
    expect(fs.readdirSync(projectRoot)).toEqual([]);
  });

  it('leaves .git/info/exclude alone when the repository already ignores the target', () => {
    initRepo(projectRoot);
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), '.claude/\n');
    const before = fs.readFileSync(path.join(projectRoot, '.git', 'info', 'exclude'), 'utf-8');
    memberInstaller().install();
    expect(fs.readFileSync(path.join(projectRoot, '.git', 'info', 'exclude'), 'utf-8')).toBe(before);
  });
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

  const join = (args: string[], deps: Record<string, unknown> = {}) =>
    runJoin(args, { mycoHome, cwd: projectRoot, fetch: rig.fetch, packageRoot: PKG_ROOT, stdout: () => {}, stderr: () => {}, ...deps });

  it('verifies without writing to the server, records the entry, and provisions the agent', async () => {
    const seen: string[] = [];
    const watching = async (input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init);
      seen.push(`${req.method} ${new URL(req.url).pathname}`);
      return rig.fetch(req);
    };
    const out: string[] = [];

    const entry = await join(['https://server.example', '--project', PROJECT, '--token-env', 'JOIN_TOKEN', '--root', projectRoot, '--provision', 'claude-code'], {
      fetch: watching, env: { JOIN_TOKEN: rig.token }, stdout: (l: string) => out.push(l),
    });

    expect(seen).toEqual(['GET /health']);
    expect(entry!.token).toBe(rig.token);
    expect(readRegistryEntry(projectRoot, mycoHome)!.projectId).toBe(PROJECT);
    expect(out.join('\n')).toContain(`joined ${PROJECT} at https://server.example`);
    expect(out.join('\n')).toContain('provisioned Claude Code');
    expect(hookCommands(readTarget().hooks).length).toBeGreaterThan(0);
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

  it('refuses a non-https server, a bad token, both token sources, and neither', async () => {
    const err: string[] = [];
    const deps = { stderr: (l: string) => err.push(l) };
    expect(await join(['http://server.example', '--project', PROJECT, '--token-stdin'], { ...deps, stdin: () => rig.token })).toBeNull();
    expect(await join(['https://server.example', '--project', PROJECT, '--token-stdin'], { ...deps, stdin: () => 'not-a-token' })).toBeNull();
    expect(await join(['https://server.example', '--project', PROJECT, '--token-stdin', '--token-env', 'X'], { ...deps, stdin: () => rig.token })).toBeNull();
    expect(await join(['https://server.example', '--project', PROJECT], deps)).toBeNull();
    expect(err.join('\n')).toContain('is not an https server URL');
    expect(err.join('\n')).toContain('that is not a member token');
    expect(err.join('\n')).toContain('exactly one of --token-stdin or --token-env');
    expect(readRegistryEntry(projectRoot, mycoHome)).toBeNull();
    process.exitCode = 0;
  });

  it('leave forgets the membership, keeps the spool, and --purge removes the spool and the hooks', async () => {
    await join(['https://server.example', '--project', PROJECT, '--token-env', 'JOIN_TOKEN', '--root', projectRoot, '--provision', 'claude-code'], { env: { JOIN_TOKEN: rig.token } });
    const spool = new MemberSpool(PROJECT, { mycoHome });
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
    expect(runLeave(['--purge'], deps)).toBe(true);
    expect(fs.existsSync(spool.dir)).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, MEMBER_TARGET))).toBe(false);
    expect(out.join('\n')).toContain('removed Claude Code hooks');
  });
});
