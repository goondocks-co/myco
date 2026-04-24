// Project-local runtime redirect for the myco CLI shim.
//
// When `myco` is invoked inside a project that pins a specific runtime
// via `.myco/runtime.command` (beta-channel projects and dogfood), this
// helper re-execs into the pinned binary so the interactive CLI matches
// the binary the project's daemon, hooks, and MCP server already use.
// Without this, `myco doctor`, `myco update`, etc. resolve to the global
// binary while every other dispatch path resolves to the local pin —
// producing version skew between CLI and daemon.
//
// This is the same dispatch pattern `myco-run.cjs` (the symbiont hook
// guard) uses for hook invocations, applied to the CLI entry itself.
// `runtime.command` is the single source of truth for "which myco does
// this project use."

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * Walk upward from `cwd` looking for `.myco/runtime.command`. Returns
 * the trimmed file contents (an absolute path or PATH-resolvable name)
 * or null when no pin is found.
 *
 * Worktree-aware: when `cwd` is inside a git worktree, starts the walk
 * at the main repo root, because vaults live with the main repo and
 * worktrees don't carry their own.
 *
 * Filename literals here mirror `PROJECT_RUNTIME_COMMAND_FILENAME` and
 * `.myco` from `src/constants/update.ts`. This file is plain CJS (runs
 * before bun) so it can't import the TS source of truth.
 */
function findProjectRuntimePin(cwd) {
  try {
    let dir = resolveSearchStart(cwd);
    while (true) {
      const pinPath = path.join(dir, '.myco', 'runtime.command');
      try {
        const raw = fs.readFileSync(pinPath, 'utf-8').trim();
        return raw || null;
      } catch {
        // not here
      }
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

/**
 * If `cwd` is inside a git worktree, return the main repo root. Otherwise
 * return `cwd`. Detection is purely filesystem-based (no `git` spawn) so
 * this stays cheap in the shim's startup path.
 *
 * Worktree marker: `.git` is a file (not a directory) whose contents start
 * with `gitdir: <path>`. That path points at `<mainRepo>/.git/worktrees/<name>`;
 * the main repo root is three levels up.
 */
function resolveSearchStart(cwd) {
  let dir = cwd;
  while (true) {
    const gitEntry = path.join(dir, '.git');
    try {
      const stat = fs.lstatSync(gitEntry);
      if (stat.isDirectory()) return dir;
      if (stat.isFile()) {
        const content = fs.readFileSync(gitEntry, 'utf-8').trim();
        const match = content.match(/^gitdir:\s*(.+)$/m);
        if (match && match[1]) {
          const gitdir = path.isAbsolute(match[1]) ? match[1] : path.resolve(dir, match[1]);
          return path.resolve(gitdir, '..', '..', '..');
        }
        return dir;
      }
    } catch {
      // no .git here; keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

/**
 * True when `target` and `selfPath` resolve (through symlinks) to the same
 * binary — used to skip a redirect that would just re-exec into ourselves.
 * Returns false on any filesystem error (target missing, permission, etc.)
 * so the caller proceeds to attempt the exec and handles ENOENT there.
 */
function pointsAtSelf(target, selfPath) {
  try {
    return fs.realpathSync(target) === fs.realpathSync(selfPath);
  } catch {
    return false;
  }
}

/**
 * If a project-local runtime pin applies and points at a different binary
 * than ourselves, re-exec into it with forwarded argv and an env var set
 * to prevent infinite redirect loops. Exits the process on successful
 * redirect (propagating the child's exit code).
 *
 * Returns `false` when no redirect happens, so the caller falls through
 * to its normal dispatch. Skip reasons: `MYCO_REDIRECTED` already set,
 * no pin found, pin points at self, or pin target is missing.
 */
function maybeRedirect(selfPath, cwd = process.cwd(), env = process.env) {
  if (env.MYCO_REDIRECTED) return false;
  const pin = findProjectRuntimePin(cwd);
  if (!pin) return false;
  if (pointsAtSelf(pin, selfPath)) return false;

  try {
    execFileSync(pin, process.argv.slice(2), {
      stdio: 'inherit',
      env: { ...env, MYCO_REDIRECTED: '1' },
    });
    process.exit(0);
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    process.exit((err && typeof err.status === 'number') ? err.status : 1);
  }
}

module.exports = {
  findProjectRuntimePin,
  resolveSearchStart,
  pointsAtSelf,
  maybeRedirect,
};
