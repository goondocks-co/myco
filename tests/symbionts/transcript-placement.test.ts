/**
 * Placing a transcript under the project it belongs to when the directory it
 * records is not inside a connected checkout: a worktree beside the checkout
 * (live capture resolves those to the main checkout, so an import must too), a
 * worktree since removed, a root spelled in another case.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  canonicalPath, mappingCovers, parseDirectoryMapping, remoteIdentity, transcriptPlacer, type PlacementGit,
} from '@myco/symbionts/transcript-attribution.js';
import { collectCandidates } from '@myco/member/import.js';

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

const noGit: PlacementGit = { mainCheckout: () => null, remoteOf: () => null };

describe('placing a transcript', () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-place-')));
  const root = path.join(base, 'Repos', 'myco');
  const worktree = path.join(base, 'Repos', 'myco-lane-x');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  const store = path.join(base, 'store');

  it('places a worktree that still exists under its main checkout', () => {
    const git: PlacementGit = { mainCheckout: (dir) => (dir === worktree ? root : null), remoteOf: () => null };
    const place = transcriptPlacer([root], { git });
    expect(place('claude-code', claudeTranscript(store, worktree))).toEqual({ kind: 'bound', root });
  });

  it('places a removed worktree through an explicit mapping, and a family of them through a trailing *', () => {
    const gone = path.join(base, 'Repos', 'myco-worker-readiness');
    const exact = transcriptPlacer([root], { git: noGit, mappings: [{ from: gone, to: root }] });
    expect(exact('claude-code', claudeTranscript(store, gone))).toEqual({ kind: 'bound', root });
    const family = transcriptPlacer([root], { git: noGit, mappings: [{ from: `${path.join(base, 'Repos', 'myco-')}*`, to: root }] });
    expect(family('claude-code', claudeTranscript(store, path.join(gone, 'sub')))).toEqual({ kind: 'bound', root });
    expect(family('claude-code', claudeTranscript(store, path.join(base, 'Repos', 'other')))).toEqual({ kind: 'elsewhere', directory: path.join(base, 'Repos', 'other') });
  });

  it('never maps a directory that is still a repository of its own', () => {
    const other = path.join(base, 'Repos', 'myco-unrelated');
    fs.mkdirSync(other, { recursive: true });
    expect(Bun.spawnSync(['git', 'init', '-q', other], { stdout: 'ignore', stderr: 'ignore' }).exitCode).toBe(0);
    const family = transcriptPlacer([root], { mappings: [{ from: `${path.join(base, 'Repos', 'myco-')}*`, to: root }] });
    expect(family('claude-code', claudeTranscript(store, other))).toEqual({ kind: 'elsewhere', directory: other });
    expect(family('claude-code', claudeTranscript(store, path.join(base, 'Repos', 'myco-gone')))).toEqual({ kind: 'bound', root });
  });

  it('places a removed worktree by the remote its transcript records', () => {
    const git: PlacementGit = { mainCheckout: () => null, remoteOf: (r) => (r === root ? 'git@github.com:goondocks-co/myco.git' : null) };
    const place = transcriptPlacer([root], { git });
    const gone = path.join(base, 'herdr', 'worktrees', 'myco', 'review-1');
    expect(place('codex', codexTranscript(store, gone, { git: { repository_url: 'https://github.com/goondocks-co/myco.git' } }))).toEqual({ kind: 'bound', root });
    expect(place('codex', codexTranscript(store, gone, { git: { repository_url: 'https://github.com/someone/else.git' } }))).toEqual({ kind: 'elsewhere', directory: gone });
  });

  it('asks git for a real worktree', () => {
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
  });

  it('spells paths the way the filesystem stores them', () => {
    expect(canonicalPath(path.join(root, 'not', 'there'))).toBe(path.join(root, 'not', 'there'));
    if (process.platform !== 'darwin') return;
    const shouted = root.replace('/Repos/', '/repos/');
    expect(canonicalPath(shouted)).toBe(root);
    expect(transcriptPlacer([shouted], { git: noGit })('claude-code', claudeTranscript(store, root))).toEqual({ kind: 'bound', root: shouted });
  });

  it('reads mappings and remotes', () => {
    expect(parseDirectoryMapping('/a/b=/c')).toEqual({ from: '/a/b', to: '/c' });
    expect(parseDirectoryMapping('a=/c')).toBeNull();
    expect(parseDirectoryMapping('/a=')).toBeNull();
    expect(mappingCovers({ from: '/r/myco-*', to: '/r/myco' }, '/r/myco-x/y')).toBe(true);
    expect(mappingCovers({ from: '/r/myco-*', to: '/r/myco' }, '/r/other')).toBe(false);
    expect(remoteIdentity('git@github.com:goondocks-co/myco.git')).toBe(remoteIdentity('https://GitHub.com/goondocks-co/myco/'));
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
