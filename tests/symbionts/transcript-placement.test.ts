/**
 * Placing a transcript under the project it belongs to when the directory it
 * records is not inside a connected checkout: a worktree beside the checkout
 * (live capture resolves those to the main checkout, so an import must too), a
 * worktree since removed, a root spelled in another case.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalPath, mappingCovers, parseDirectoryMapping, transcriptPlacer, type PlacementGit,
} from '@myco/symbionts/transcript-attribution.js';
import { collectCandidates } from '@myco/member/import.js';
import { resolveMemberProjectRoot } from '@myco/member/credential.js';

const line = (o: Record<string, unknown>): string => `${JSON.stringify(o)}\n`;

function claudeTranscript(dir: string, cwd: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${crypto.randomUUID()}.jsonl`);
  fs.writeFileSync(file, line({ type: 'user', cwd, message: { content: 'hi' } }));
  return file;
}

function codexTranscript(dir: string, cwd: string, meta: Record<string, unknown> = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-01T10-00-00-${crypto.randomUUID()}.jsonl`);
  fs.writeFileSync(file, line({ type: 'session_meta', payload: { cwd, source: 'cli', ...meta } }));
  return file;
}

const noGit: PlacementGit = { mainCheckout: () => null };

describe('placing a transcript', () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-place-')));
  const root = path.join(base, 'Repos', 'myco');
  const worktree = path.join(base, 'Repos', 'myco-lane-x');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  const store = path.join(base, 'store');

  it('places a worktree that still exists under its main checkout', () => {
    const git: PlacementGit = { mainCheckout: (dir) => (dir === worktree ? root : null) };
    const place = transcriptPlacer([root], { git });
    expect(place('claude-code', claudeTranscript(store, worktree))).toEqual({ kind: 'bound', root });
  });

  it('places a removed worktree through an explicit mapping, and a family of them through a trailing *', () => {
    const gone = path.join(base, 'Repos', 'myco-worker-readiness');
    const exact = transcriptPlacer([root], { git: noGit, mappings: [{ from: gone, to: root }] });
    expect(exact('claude-code', claudeTranscript(store, gone))).toEqual({ kind: 'bound', root });
    const family = transcriptPlacer([root], { git: noGit, mappings: [{ from: `${path.join(base, 'Repos', 'myco-')}*`, to: root }] });
    expect(family('claude-code', claudeTranscript(store, path.join(gone, 'sub')))).toEqual({ kind: 'bound', root });
    expect(family('claude-code', claudeTranscript(store, path.join(base, 'Repos', 'other')))).toMatchObject({ kind: 'elsewhere', directory: path.join(base, 'Repos', 'other') });
  });

  it('never maps a nested repository or an unresolved target onto an ancestor Project', () => {
    const personal = path.join(root, 'homelab');
    const gone = path.join(base, 'removed');
    for (const git of [noGit, { mainCheckout: (dir: string) => dir === personal ? personal : null }]) {
      const place = transcriptPlacer([root], { git, repositoryRoots: [root, personal], mappings: [{ from: gone, to: personal }] });
      expect(place('claude-code', claudeTranscript(store, gone))).toMatchObject({ kind: 'elsewhere', directory: gone });
    }
  });

  it('never maps a directory that is still a repository of its own', () => {
    const other = path.join(base, 'Repos', 'myco-unrelated');
    fs.mkdirSync(other, { recursive: true });
    expect(Bun.spawnSync(['git', 'init', '-q', other], { stdout: 'ignore', stderr: 'ignore' }).exitCode).toBe(0);
    const family = transcriptPlacer([root], { mappings: [{ from: `${path.join(base, 'Repos', 'myco-')}*`, to: root }] });
    expect(family('claude-code', claudeTranscript(store, other))).toMatchObject({ kind: 'elsewhere', directory: other });
    expect(family('claude-code', claudeTranscript(store, path.join(base, 'Repos', 'myco-gone')))).toEqual({ kind: 'bound', root });
  });

  it('reports a removed worktree with only a recorded remote, requiring an explicit map', () => {
    const git: PlacementGit = noGit;
    const place = transcriptPlacer([root], { git });
    const gone = path.join(base, 'herdr', 'worktrees', 'myco', 'review-1');
    expect(place('codex', codexTranscript(store, gone, { git: { repository_url: 'https://github.com/goondocks-co/myco.git' } }))).toMatchObject({ kind: 'elsewhere', directory: gone });
    expect(place('codex', codexTranscript(store, gone, { git: { repository_url: 'https://github.com/someone/else.git' } }))).toMatchObject({ kind: 'elsewhere', directory: gone });
  });

  it('live capture and import resolve a real worktree to the same main checkout', () => {
    const repo = path.join(base, 'real-repo');
    const tree = path.join(base, 'real-repo-wt');
    fs.mkdirSync(repo, { recursive: true });
    const git = (args: string, cwd: string) => Bun.spawnSync(['git', ...args.split(' ')], { cwd, stdout: 'ignore', stderr: 'ignore' }).exitCode;
    expect(git('init -q -b main', repo)).toBe(0);
    expect(git('-c user.email=t@t -c user.name=t commit -q --allow-empty -m init', repo)).toBe(0);
    expect(git(`worktree add -q ${tree}`, repo)).toBe(0);
    fs.mkdirSync(path.join(tree, 'packages'), { recursive: true });
    const place = transcriptPlacer([repo]);
    expect(place('claude-code', claudeTranscript(store, tree))).toEqual({ kind: 'bound', root: repo });
    expect(place('claude-code', claudeTranscript(store, path.join(tree, 'packages')))).toEqual({ kind: 'bound', root: repo });
    expect(resolveMemberProjectRoot(path.join(tree, 'packages'))).toBe(repo);
    fs.appendFileSync(path.join(repo, '.git', 'config'), '\n[include]\n path = extra-config\n[extensions]\n worktreeConfig = true\n');
    fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'real-repo-wt', 'config.worktree'), '[core]\n autocrlf = false\n');
    expect(resolveMemberProjectRoot(path.join(tree, 'packages'))).toBe(repo);
    expect(transcriptPlacer([repo])('claude-code', claudeTranscript(store, tree))).toEqual({ kind: 'bound', root: repo });
    fs.rmSync(tree, { recursive: true });
    expect(transcriptPlacer([repo])('claude-code', claudeTranscript(store, path.join(tree, 'packages')))).toEqual({ kind: 'bound', root: repo });
    fs.mkdirSync(tree);
    expect(git('init -q', tree)).toBe(0);
    expect(transcriptPlacer([repo])('claude-code', claudeTranscript(store, path.join(tree, 'gone')))).toMatchObject({ kind: 'elsewhere', directory: path.join(tree, 'gone') });
    fs.rmSync(tree, { recursive: true });
    expect(git('worktree prune', repo)).toBe(0);
    expect(transcriptPlacer([repo])('claude-code', claudeTranscript(store, tree))).toMatchObject({ kind: 'elsewhere', directory: tree });
  });

  it('excludes agent scratch directories even when a mapping or recorded remote would bind them', () => {
    const cwd = path.join(os.tmpdir(), 'claude-501', 'project', 'scratchpad', 'repo');
    const place = transcriptPlacer([root], { mappings: [{ from: os.tmpdir(), to: root }] });
    expect(place('codex', codexTranscript(store, cwd, { git: { repository_url: 'https://github.com/goondocks-co/myco.git' } }))).toEqual({ kind: 'excluded' });
    const held = process.env.MYCO_TEMPORARY_FOLDERS;
    process.env.MYCO_TEMPORARY_FOLDERS = path.join(os.tmpdir(), 'claude-501');
    try {
      expect(place('claude-code', claudeTranscript(store, cwd))).toEqual({ kind: 'excluded' });
    } finally {
      if (held === undefined) delete process.env.MYCO_TEMPORARY_FOLDERS; else process.env.MYCO_TEMPORARY_FOLDERS = held;
    }
  });

  it('does not attribute a pruned nested worktree by its containing checkout', () => {
    const gone = path.join(root, '.worktrees', 'personal', 'src');
    expect(transcriptPlacer([root])('claude-code', claudeTranscript(store, gone))).toMatchObject({ kind: 'elsewhere', directory: gone });
  });

  it('excludes a missing scratchpad under a temporary-folder alias', () => {
    if (process.platform === 'win32') return;
    const physical = path.join(base, 'temporary-storage');
    const alias = path.join(base, 'temporary-alias');
    fs.mkdirSync(physical);
    fs.symlinkSync(physical, alias);
    const cwd = path.join(alias, 'claude-501', 'project', 'scratchpad', 'gone');
    const held = process.env.MYCO_TEMPORARY_FOLDERS;
    process.env.MYCO_TEMPORARY_FOLDERS = alias;
    try {
      const place = transcriptPlacer([root], { mappings: [{ from: alias, to: root }] });
      expect(place('claude-code', claudeTranscript(store, cwd))).toEqual({ kind: 'excluded' });
    } finally {
      if (held === undefined) delete process.env.MYCO_TEMPORARY_FOLDERS; else process.env.MYCO_TEMPORARY_FOLDERS = held;
    }
  });

  it('reports an existing nested directory whose repository identity cannot be read', () => {
    const unresolved = path.join(root, '.worktrees', 'unresolved');
    fs.mkdirSync(unresolved, { recursive: true });
    fs.writeFileSync(path.join(unresolved, '.git'), 'gitdir: missing-record');
    expect(transcriptPlacer([root])('claude-code', claudeTranscript(store, unresolved))).toMatchObject({ kind: 'elsewhere', directory: unresolved });
  });

  it('follows a symlinked cwd to its physical repository for live capture and import', () => {
    if (process.platform === 'win32') return;
    const other = path.join(base, 'other-repo');
    fs.mkdirSync(path.join(other, 'src', 'nested'), { recursive: true });
    expect(Bun.spawnSync(['git', 'init', '-q', other], { stdout: 'ignore', stderr: 'ignore' }).exitCode).toBe(0);
    fs.symlinkSync(path.join(other, 'src'), path.join(root, 'linked-src'));
    const cwd = path.join(root, 'linked-src', 'nested');
    expect(resolveMemberProjectRoot(cwd)).toBe(other);
    expect(transcriptPlacer([root, other])('claude-code', claudeTranscript(store, cwd))).toEqual({ kind: 'bound', root: other });
    expect(transcriptPlacer([root])('claude-code', claudeTranscript(store, cwd))).toMatchObject({ kind: 'elsewhere', directory: cwd });
  });

  it('indexes retained records once across distinct missing directories', () => {
    const repo = path.join(base, 'indexed');
    fs.mkdirSync(repo);
    expect(Bun.spawnSync(['git', 'init', '-q', repo], { stdout: 'ignore', stderr: 'ignore' }).exitCode).toBe(0);
    const gone = path.join(base, 'indexed-gone');
    const record = path.join(repo, '.git', 'worktrees', 'gone');
    fs.mkdirSync(record, { recursive: true });
    fs.writeFileSync(path.join(record, 'gitdir'), `${gone}/.git\n`);
    fs.writeFileSync(path.join(record, 'commondir'), '../..\n');
    const original = fs.readdirSync;
    let scans = 0;
    const spy = spyOn(fs, 'readdirSync').mockImplementation((...args) => {
      if (String(args[0]) === path.join(repo, '.git', 'worktrees')) scans += 1;
      return Reflect.apply(original, fs, args);
    });
    try {
      const place = transcriptPlacer([repo]);
      for (const sub of ['one', 'two', 'three']) expect(place('claude-code', claudeTranscript(store, path.join(gone, sub)))).toEqual({ kind: 'bound', root: repo });
      expect(scans).toBe(1);
    } finally { spy.mockRestore(); }
  });

  it('spells paths the way the filesystem stores them', () => {
    expect(canonicalPath(path.join(root, 'not', 'there'))).toBe(path.join(root, 'not', 'there'));
    if (process.platform !== 'darwin') return;
    const shouted = root.replace('/Repos/', '/repos/');
    expect(canonicalPath(shouted)).toBe(root);
    expect(transcriptPlacer([shouted], { git: noGit })('claude-code', claudeTranscript(store, root))).toEqual({ kind: 'bound', root: shouted });
  });

  it('leaves missing paths unresolved without canonicalizing filesystem ancestors', () => {
    const missing = path.resolve('/home', `myco-unresolved-${crypto.randomUUID()}`, 'src');
    const module = path.resolve('packages/myco/src/utils/git-files.ts');
    const probe = Bun.spawnSync([process.execPath, '-e', `
      import { canonicalPath, resolveRepositoryRoot } from ${JSON.stringify(module)};
      console.log(JSON.stringify([canonicalPath(${JSON.stringify(missing)}), resolveRepositoryRoot(${JSON.stringify(missing)})]));
    `], { stdout: 'pipe', stderr: 'pipe', timeout: 5_000 });
    expect(probe.exitCode).toBe(0);
    expect(JSON.parse(probe.stdout.toString())).toEqual([missing, null]);
    expect(transcriptPlacer([root])('claude-code', claudeTranscript(store, missing))).toMatchObject({ kind: 'elsewhere', directory: missing });
  });

  it('reads mappings', () => {
    expect(parseDirectoryMapping('/a/b=/c')).toEqual({ from: '/a/b', to: '/c' });
    expect(parseDirectoryMapping('a=/c')).toBeNull();
    expect(parseDirectoryMapping('/a=')).toBeNull();
    expect(mappingCovers({ from: '/r/myco-*', to: '/r/myco' }, '/r/myco-x/y')).toBe(true);
    expect(mappingCovers({ from: '/r/myco-*', to: '/r/myco' }, '/r/other')).toBe(false);
  });
});

describe('what the transcript import leaves out', () => {
  it('drops the sub-agent threads and exec runs live capture drops', () => {
    const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-drop-')));
    const root = path.join(base, 'repo');
    fs.mkdirSync(root, { recursive: true });
    const held = process.env.HOME;
    process.env.HOME = base;
    try {
      const day = path.join(base, '.codex', 'sessions', '2026', '09', '01');
      const files = [
        codexTranscript(day, root),
        codexTranscript(day, root, { source: { subagent: { thread_spawn: { parent_thread_id: 'p' } } } }),
        codexTranscript(day, root, { source: 'exec' }),
      ];
      const old = new Date(Date.now() - 60 * 60_000);
      for (const f of files) fs.utimesSync(f, old, old);
      const collected = collectCandidates(['codex'], [root], 'machine_1', path.join(base, 'myco-home'), Date.now());
      expect(collected.dropped).toBe(2);
      expect(collected.candidates.map((c) => c.filePath)).toEqual([files[0]]);
    } finally {
      if (held === undefined) delete process.env.HOME; else process.env.HOME = held;
    }
  });
});
