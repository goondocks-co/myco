import { afterEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOTS: string[] = [];
const SAFE = '{"cwd":"/Users/fixture/repo"}\n';
const SECRET = 'mt_abcdefghijklmnopqrstuv';
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: devNull,
};

function run(cwd: string, command: string, args: string[]) {
  const result = spawnSync(command, args, { cwd, env: ENV, encoding: 'utf8', timeout: 20_000 });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}

function git(cwd: string, ...args: string[]) {
  const result = run(cwd, 'git', args);
  expect(result).toMatchObject({ status: 0 });
  return result.output.trim();
}

function fixture(root: string, content: string, name = 'recording.jsonl') {
  mkdirSync(path.join(root, 'tests/fixtures'), { recursive: true });
  writeFileSync(path.join(root, 'tests/fixtures', name), content);
}

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'myco-fixture-gate-'));
  ROOTS.push(root);
  mkdirSync(path.join(root, 'scripts/hooks'), { recursive: true });
  mkdirSync(path.join(root, 'tests/fixtures'), { recursive: true });
  for (const file of ['fixture-redaction.ts', 'check-fixture-redaction.ts', 'install-fixture-hook.mjs', 'hooks/pre-commit']) {
    copyFileSync(path.join(REPO_ROOT, 'scripts', file), path.join(root, 'scripts', file));
  }
  symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Fixture Test');
  git(root, 'config', 'user.email', 'fixture@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
  return root;
}

function install(root: string) {
  return run(root, 'node', ['scripts/install-fixture-hook.mjs']);
}

function commit(root: string, ...args: string[]) {
  return run(root, 'git', ['commit', '-qm', 'fixture', ...args]);
}

afterEach(() => {
  for (const root of ROOTS.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('fixture pre-commit gate', () => {
  it('rejects staged credentials despite an unstaged cleanup, without printing their value', () => {
    const root = setup();
    const sourceHook = path.join(root, 'scripts/hooks/pre-commit');
    writeFileSync(sourceHook, readFileSync(sourceHook, 'utf8').replace(/\r?\n/g, '\r\n'));
    expect(install(root).status).toBe(0);
    expect(install(root).status).toBe(0);
    fixture(root, `${SAFE}${SECRET}\n`);
    git(root, 'add', 'tests/fixtures');
    fixture(root, SAFE);
    const rejected = commit(root);
    expect(rejected.status).not.toBe(0);
    expect(rejected.output).toContain('recording.jsonl":2: carries a Myco member credential');
    expect(rejected.output).not.toContain(SECRET);
    expect(run(root, 'git', ['rev-parse', '--verify', 'HEAD']).status).not.toBe(0);
    git(root, 'add', 'tests/fixtures');
    fixture(root, SECRET);
    expect(commit(root).status).toBe(0);
    expect(git(root, 'show', 'HEAD:tests/fixtures/recording.jsonl')).toBe(SAFE.trim());
  });

  it('honors the alternate index used by a partial commit and permits staged deletion', () => {
    const root = setup();
    expect(install(root).status).toBe(0);
    fixture(root, SAFE);
    writeFileSync(path.join(root, 'README.md'), 'fixture\n');
    git(root, 'add', 'tests', 'README.md');
    expect(commit(root).status).toBe(0);
    fixture(root, SECRET);
    git(root, 'add', 'tests');
    writeFileSync(path.join(root, 'README.md'), 'updated\n');
    expect(commit(root, '--only', 'README.md').status).toBe(0);
    expect(commit(root).status).not.toBe(0);
    git(root, 'rm', '-f', 'tests/fixtures/recording.jsonl');
    fixture(root, SECRET);
    expect(commit(root).status).toBe(0);
  });

  it('checks renamed files and safely labels filenames containing whitespace', () => {
    const root = setup();
    expect(install(root).status).toBe(0);
    fixture(root, SAFE);
    git(root, 'add', 'tests');
    expect(commit(root).status).toBe(0);
    const name = process.platform === 'win32' ? 'renamed recording.jsonl' : 'renamed recording\n.jsonl';
    git(root, 'mv', 'tests/fixtures/recording.jsonl', `tests/fixtures/${name}`);
    fixture(root, SECRET, name);
    git(root, 'add', 'tests');
    const rejected = commit(root);
    expect(rejected.status).not.toBe(0);
    expect(rejected.output).toContain(JSON.stringify(name).slice(1, -1));
    expect(rejected.output).not.toContain(SECRET);
  });

  it('uses the linked worktree index with the shared installed hook', () => {
    const root = setup();
    expect(install(root).status).toBe(0);
    fixture(root, SAFE);
    git(root, 'add', 'scripts', 'tests');
    expect(commit(root).status).toBe(0);
    const linked = path.join(root, 'linked');
    git(root, 'worktree', 'add', '-qb', 'linked', linked);
    symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(linked, 'node_modules'), 'junction');
    expect(install(linked).status).toBe(0);
    fixture(linked, SECRET);
    git(linked, 'add', 'tests');
    expect(commit(linked).status).not.toBe(0);
    expect(commit(root, '--allow-empty').status).toBe(0);
  });

  it('preserves existing and custom hooks and refuses installation over them', () => {
    const root = setup();
    const hook = path.join(root, '.git/hooks/pre-commit');
    const content = '#!/bin/sh\nexit 23\n';
    writeFileSync(hook, content, { mode: 0o755 });
    expect(install(root).status).not.toBe(0);
    expect(readFileSync(hook, 'utf8')).toBe(content);
    git(root, 'config', 'core.hooksPath', 'custom-hooks');
    expect(install(root).status).not.toBe(0);
    expect(git(root, 'config', 'core.hooksPath')).toBe('custom-hooks');
  });

  it('rejects fixture symlinks in the index without following them', () => {
    const root = setup();
    expect(install(root).status).toBe(0);
    const objectId = git(root, 'hash-object', '-w', 'scripts/hooks/pre-commit');
    git(root, 'update-index', '--add', '--cacheinfo', `120000,${objectId},tests/fixtures/link.jsonl`);
    const rejected = commit(root);
    expect(rejected.status).not.toBe(0);
    expect(rejected.output).toContain('fixtures must be resolved regular files');
  });
});
