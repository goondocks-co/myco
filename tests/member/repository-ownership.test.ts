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
function fixture(): { root: string; env: NodeJS.ProcessEnv } {
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
  expect(entries.map(({ file, entry }) => [path.relative(root, file), entry])).toEqual(expect.arrayContaining([
    ['.mcp.json', 'mcpServers.myco'], ['.codex/config.toml', 'mcp_servers.myco'],
    ['.claude/settings.local.json', 'hooks.Stop (Myco commands)'], ['.opencode/plugins/myco.ts', 'Myco plugin'],
  ]));
  expect(entries.filter(entry => entry.entry === 'mcpServers.myco')).toHaveLength(1);
  expect(tracked.map(file => fs.readFileSync(path.join(root, file), 'utf8'))).toEqual(before);
  fs.writeFileSync(path.join(root, '.mcp.json'), '{broken');
  expect(repositoryMycoEntries([root])).toContainEqual({ root, file: path.join(root, '.mcp.json'), entry: 'unreadable (entries unknown)' });
});

it('uses the common exclude file for a linked worktree and preserves existing lines', () => {
  const { root, env } = fixture();
  const worktree = path.join(path.dirname(root), 'worktree');
  execFileSync('git', ['worktree', 'add', '-qb', 'fixture-worktree', worktree], { cwd: root, env });
  const exclude = path.join(root, '.git', 'info', 'exclude');
  fs.appendFileSync(exclude, 'other-machine-file');
  ensureGitIgnored(worktree, path.join(worktree, '.myco/runtime.home'));
  const once = fs.readFileSync(exclude, 'utf8');
  expect(once).toContain('other-machine-file\n.myco/runtime.home\n');
  ensureGitIgnored(worktree, path.join(worktree, '.myco/runtime.home'));
  expect(fs.readFileSync(exclude, 'utf8')).toBe(once);
});
