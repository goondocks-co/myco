import { afterEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';
import { repositoryMycoEntries } from '@myco/symbionts/repository-entries.js';
import { ensureGitIgnored } from '@myco/utils/git-exclude.js';

const repo = path.resolve(import.meta.dir, '../..');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(leftovers = true): { root: string; env: NodeJS.ProcessEnv } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-repository-ownership-'));
  roots.push(dir);
  const root = path.join(dir, 'repository');
  fs.mkdirSync(root);
  const env = sandboxChildEnv(dir);
  env.MYCO_HOME = path.join(dir, 'non-default-myco');
  env.MYCO_FIXTURE_PACKAGE_ROOT = path.join(repo, 'packages/myco');
  for (const [file, content] of Object.entries({
    '.gitignore': '# Myco managed (machine-specific)\ndocs/plans/\n',
    'AGENTS.md': '# Rules\n<!-- myco:managed:start -->\nkeep this\n<!-- myco:managed:end -->\n',
    'CLAUDE.md': 'Edit AGENTS.md, not this file\n',
    '.myco/.gitignore': '# legacy vault rules\nruntime.home\n',
    '.mcp.json': JSON.stringify({ mcpServers: { myco: { command: 'early-alpha', args: ['mcp', '--credential', 'registry'] }, other: { command: 'other' } } }),
    '.codex/config.toml': '[mcp_servers.myco]\ncommand = "early-alpha"\nargs = ["mcp", "--credential", "registry"]\n',
    '.claude/settings.local.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'early-alpha hook stop --credential registry --myco-managed' }] }] } }),
    '.opencode/plugins/myco.ts': '// myco:member-plugin\n',
  })) {
    if (!leftovers && ['.mcp.json', '.codex/config.toml', '.claude/settings.local.json', '.opencode/plugins/myco.ts'].includes(file)) continue;
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'core.excludesFile', path.join(root, '.git', 'empty-excludes'));
  fs.writeFileSync(path.join(root, '.git', 'empty-excludes'), '');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  return { root, env };
}

it('leaves repository state clean throughout the member lifecycle with a non-default home', () => {
  const { root, env } = fixture();
  const ran = spawnSync(process.execPath, ['--tsconfig-override', path.join(repo, 'tsconfig.json'), path.join(repo, 'tests/fixtures/retirement/repository-lifecycle.ts')], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  expect({ status: ran.status, stderr: ran.stderr, stdout: ran.stdout }).toMatchObject({ status: 0 });
  for (const step of ['join', 'provision', 'refresh', 'update', 'doctor', 'leave', 'logout']) expect(ran.stdout).toContain(`clean: ${step}`);
}, 90_000);

it('reports leftover MCP, hook and plugin entries by file and name, preserving every byte', () => {
  const { root } = fixture();
  const tracked = ['.mcp.json', '.codex/config.toml', '.claude/settings.local.json', '.opencode/plugins/myco.ts'];
  const before = tracked.map(file => fs.readFileSync(path.join(root, file), 'utf8'));
  const entries = repositoryMycoEntries([root, root]);
  expect(entries.filter(item => item.kind === 'found').map(({ file, entry }) => [path.relative(root, file), entry])).toEqual(expect.arrayContaining([
    ['.mcp.json', 'mcpServers.myco'], ['.codex/config.toml', 'mcp_servers.myco'],
    ['.claude/settings.local.json', 'hooks: Stop (Myco commands)'], ['.opencode/plugins/myco.ts', 'Myco plugin'],
  ]));
  expect(entries.filter(entry => entry.kind === 'found' && entry.entry === 'mcpServers.myco')).toHaveLength(1);
  expect(tracked.map(file => fs.readFileSync(path.join(root, file), 'utf8'))).toEqual(before);
  fs.writeFileSync(path.join(root, '.mcp.json'), '{broken');
  expect(repositoryMycoEntries([root])).toContainEqual({ root, file: path.join(root, '.mcp.json'), kind: 'unreadable' });
});

it('uses the common exclude file for a linked worktree and preserves existing lines', () => {
  const { root, env } = fixture();
  const worktree = path.join(path.dirname(root), 'worktree');
  execFileSync('git', ['worktree', 'add', '-qb', 'fixture-worktree', worktree], { cwd: root, env });
  const exclude = path.join(root, '.git', 'info', 'exclude');
  fs.appendFileSync(exclude, 'other-machine-file');
  ensureGitIgnored(worktree, path.join(worktree, '.myco/runtime.home'));
  const once = fs.readFileSync(exclude, 'utf8');
  expect(once).toContain('other-machine-file\n/.myco/runtime.home\n');
  ensureGitIgnored(worktree, path.join(worktree, '.myco/runtime.home'));
  expect(fs.readFileSync(exclude, 'utf8')).toBe(once);
});

it('never reports live global registrations from home, including a dotfiles repository', () => {
  const { root, env } = fixture(false);
  env.MYCO_FIXTURE_HOME_DOCTOR = '1';
  const ran = spawnSync(process.execPath, ['--tsconfig-override', path.join(repo, 'tsconfig.json'), path.join(repo, 'tests/fixtures/retirement/repository-lifecycle.ts')], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  expect({ status: ran.status, stderr: ran.stderr, stdout: ran.stdout }).toMatchObject({ status: 0 });
  expect(ran.stdout).toContain('quiet: home doctor non-repository');
  expect(ran.stdout).toContain('quiet: home doctor dotfiles');
}, 90_000);

it('keeps a join pin below the git top level excluded', () => {
  const { root, env } = fixture();
  const nested = path.join(root, 'pkg');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, '.keep'), '');
  execFileSync('git', ['add', 'pkg/.keep'], { cwd: root, env });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'nested root'], { cwd: root, env });
  env.MYCO_FIXTURE_JOIN_ROOT = nested;
  const ran = spawnSync(process.execPath, ['--tsconfig-override', path.join(repo, 'tsconfig.json'), path.join(repo, 'tests/fixtures/retirement/repository-lifecycle.ts')], { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
  expect({ status: ran.status, stderr: ran.stderr, stdout: ran.stdout }).toMatchObject({ status: 0 });
  expect(ran.stdout).toContain('clean: join');
  expect(fs.readFileSync(path.join(root, '.git/info/exclude'), 'utf8')).toContain('/pkg/.myco/runtime.home\n');
}, 90_000);

it('ignores non-repositories, home ancestors, and aliases of global target files', () => {
  const { root, env } = fixture(false);
  const home = env.HOME!;
  fs.mkdirSync(home, { recursive: true });
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex/config.toml'), '[mcp_servers.myco]\ncommand = "global"\n');
    expect(repositoryMycoEntries([home])).toEqual([]);
    fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
    fs.symlinkSync(path.join(home, '.codex/config.toml'), path.join(root, '.codex/config.toml'));
    expect(repositoryMycoEntries([root])).toEqual([]);
    const outside = path.join(path.dirname(root), 'not-a-repository');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, '.mcp.json'), '{"mcpServers":{"myco":{}}}');
    expect(repositoryMycoEntries([outside])).toEqual([]);
    process.env.HOME = path.join(root, 'nested-home');
    expect(repositoryMycoEntries([root])).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
  }
});

it('accepts JSONC with no Myco entry and groups all hook events into one file row', () => {
  const { root } = fixture(false);
  fs.mkdirSync(path.join(root, '.vscode'), { recursive: true });
  fs.writeFileSync(path.join(root, '.vscode/mcp.json'), '{\n// GitHub only\n"servers": {"github": {"url": "https://example.invalid/a//b,}",},},\n}');
  expect(repositoryMycoEntries([root])).toEqual([]);
  const target = path.join(root, '.claude/settings.local.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const hooks = Object.fromEntries(['SessionStart', 'Stop', 'SessionEnd'].map(event => [event, [{ hooks: [{ command: 'myco hook stop --credential registry --myco-managed' }] }]]));
  fs.writeFileSync(target, JSON.stringify({ hooks, mcpServers: { myco: {} } }));
  expect(repositoryMycoEntries([root])).toEqual([{ root, file: target, kind: 'found', entry: 'mcpServers.myco; hooks: SessionStart, Stop, SessionEnd (Myco commands)' }]);
});

it('words an unparseable repository file as could not check, with no removal advice', async () => {
  const { root, env } = fixture(false);
  fs.writeFileSync(path.join(root, '.mcp.json'), '{broken');
  const { homeReport } = await import('@myco/cli/member-doctor.js');
  const { recordingPlatform } = await import('./helpers/service-platform.js');
  const platform = recordingPlatform();
  const report = await homeReport(env.MYCO_HOME!, { cwd: root, packageRoot: path.join(repo, 'packages/myco'),
    worker: { mycoHome: env.MYCO_HOME!, home: env.HOME!, platform: 'darwin', runner: platform.runner, ownDeploymentUrls: async () => [], harnessDirs: () => [] } });
  const rows = report.filter(check => check.name === 'Repository entries');
  expect(rows).toHaveLength(1);
  expect(rows[0].detail).toContain('could not check ' + path.join(root, '.mcp.json'));
  expect(rows[0].detail).not.toContain('remove');
  expect(platform.commands).toEqual([]);
});

it('excludes pins through repository aliases and escapes literal directory names', () => {
  const { root, env } = fixture(false);
  const nested = path.join(root, 'pkg[1] folder');
  fs.mkdirSync(nested);
  fs.writeFileSync(path.join(nested, '.keep'), '');
  execFileSync('git', ['add', '.'], { cwd: root, env });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'literal directory'], { cwd: root, env });
  const alias = path.join(path.dirname(root), 'alias');
  fs.symlinkSync(root, alias, 'dir');
  const aliasNested = path.join(alias, 'pkg[1] folder');
  fs.mkdirSync(path.join(aliasNested, '.myco'));
  const pin = path.join(aliasNested, '.myco/runtime.home');
  ensureGitIgnored(aliasNested, pin);
  fs.writeFileSync(pin, env.MYCO_HOME!);
  expect(execFileSync('git', ['status', '--porcelain'], { cwd: root, env, encoding: 'utf8' })).toBe('');
  expect(fs.readFileSync(path.join(root, '.git/info/exclude'), 'utf8')).toContain('/pkg\\[1\\]\\ folder/.myco/runtime.home\n');
});
