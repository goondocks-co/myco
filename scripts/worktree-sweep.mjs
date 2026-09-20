#!/usr/bin/env node
// Retires worktrees and branches whose pull request has already merged.
//
// Cleanup done as the last step of a lane is unreliable: a lane that dies
// mid-flight — a rate limit, a lost session — leaves its worktree and branch
// behind, and the next lane has no reason to notice. This sweep does not
// depend on the lane that made the mess still being alive. It is safe to run
// at any time, by anyone, as many times as wanted.
//
// A worktree is retired only when every one of these holds:
//   - its branch's pull request state is MERGED
//   - its working tree is clean (no tracked modifications, no stash)
//   - it holds no `.worktree-keep` marker
//   - it is not the main checkout and not on the keep list
//
// The marker is how a lane preserves a worktree whose work has landed but
// whose build output is still evidence — a signed binary a handoff cites, a
// fixture a later run compares against. A merged pull request and a clean
// tree say the code is finished; they do not say the directory is disposable.
// Touching `.worktree-keep` is the lane's own declaration, which keeps that
// knowledge next to the thing preserved instead of in a list someone has to
// maintain elsewhere.
//
// Anything else is left alone and reported, because "I could not prove this
// is finished" is the only safe default when other sessions create worktrees
// while the sweep runs. State is read at execution time rather than from a
// precomputed plan for the same reason.
//
//   node scripts/worktree-sweep.mjs [--dry-run] [--keep <branch>]...

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Branches the sweep never retires, whatever their pull request says. */
const ALWAYS_KEEP = new Set(['main', 'release/1.4']);

/** A worktree holding this file is preserved; see the note at the top. */
const KEEP_MARKER = '.worktree-keep';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const keep = new Set(ALWAYS_KEEP);
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--keep' && args[i + 1]) keep.add(args[i + 1]);
}

function git(...a) {
  return execFileSync('git', a, { encoding: 'utf8' }).trim();
}

/** Worktrees as `git worktree list --porcelain` reports them, main checkout first. */
function worktrees() {
  const out = [];
  let cur = null;
  for (const line of git('worktree', 'list', '--porcelain').split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), branch: null };
      out.push(cur);
    } else if (line.startsWith('branch refs/heads/') && cur) {
      cur.branch = line.slice('branch refs/heads/'.length);
    }
  }
  return out;
}

/** Head-branch → pull request state, for every pull request the repo has. */
function prStates() {
  const raw = execFileSync(
    'gh',
    ['pr', 'list', '--state', 'all', '--limit', '500', '--json', 'number,state,headRefName'],
    { encoding: 'utf8' },
  );
  const byBranch = new Map();
  for (const pr of JSON.parse(raw)) {
    // An open pull request on a branch outranks any earlier merged one.
    const held = byBranch.get(pr.headRefName);
    if (!held || pr.state === 'OPEN') byBranch.set(pr.headRefName, pr);
  }
  return byBranch;
}

/** Untracked build output is not work; tracked edits and stashes are. */
function isClean(path) {
  const status = execFileSync('git', ['-C', path, 'status', '--porcelain'], { encoding: 'utf8' })
    .split('\n')
    .filter((l) => l.trim() && !l.startsWith('?? '));
  if (status.length > 0) return false;
  const stash = execFileSync('git', ['-C', path, 'stash', 'list'], { encoding: 'utf8' }).trim();
  return stash === '';
}

const prs = prStates();
const [mainCheckout, ...rest] = worktrees();
const retire = [];
const held = [];

for (const wt of rest) {
  if (!wt.branch) {
    held.push([wt.path, 'detached HEAD']);
    continue;
  }
  if (keep.has(wt.branch)) {
    held.push([wt.branch, 'keep list']);
    continue;
  }
  const pr = prs.get(wt.branch);
  if (!pr) {
    held.push([wt.branch, 'no pull request']);
    continue;
  }
  if (pr.state !== 'MERGED') {
    held.push([wt.branch, `pull request #${pr.number} is ${pr.state}`]);
    continue;
  }
  if (fs.existsSync(path.join(wt.path, KEEP_MARKER))) {
    held.push([wt.branch, `${KEEP_MARKER} marker`]);
    continue;
  }
  if (!isClean(wt.path)) {
    held.push([wt.branch, 'uncommitted work']);
    continue;
  }
  retire.push({ ...wt, pr: pr.number });
}

for (const [name, why] of held) console.log(`  held    ${name} — ${why}`);

for (const wt of retire) {
  if (dryRun) {
    console.log(`  would retire ${wt.branch} (#${wt.pr})`);
    continue;
  }
  execFileSync('git', ['worktree', 'remove', '--force', wt.path], { stdio: 'ignore' });
  execFileSync('git', ['branch', '-D', wt.branch], { stdio: 'ignore' });
  try {
    execFileSync('git', ['push', 'origin', '--delete', wt.branch], { stdio: 'ignore' });
  } catch {
    // The remote branch is usually already gone: `gh pr merge --delete-branch`
    // removes it at merge time. Its absence is the desired end state, not a
    // failure, and the worktree and local branch are retired either way.
  }
  console.log(`  retired ${wt.branch} (#${wt.pr})`);
}

if (!dryRun && retire.length > 0) execFileSync('git', ['worktree', 'prune'], { stdio: 'ignore' });

// Local branches whose pull request merged but that never had a worktree, or
// whose worktree was removed by hand, accumulate the same way.
const live = new Set(worktrees().map((w) => w.branch).filter(Boolean));
const staleBranches = git('for-each-ref', '--format=%(refname:short)', 'refs/heads/')
  .split('\n')
  .filter((b) => b && !keep.has(b) && !live.has(b))
  .filter((b) => prs.get(b)?.state === 'MERGED');

for (const b of staleBranches) {
  if (dryRun) {
    console.log(`  would delete branch ${b} (#${prs.get(b).number})`);
    continue;
  }
  execFileSync('git', ['branch', '-D', b], { stdio: 'ignore' });
  console.log(`  deleted branch ${b} (#${prs.get(b).number})`);
}

const n = retire.length + staleBranches.length;
console.log(
  dryRun
    ? `${n} to retire, ${held.length} held (dry run) — main checkout ${mainCheckout.path}`
    : `${n} retired, ${held.length} held`,
);
