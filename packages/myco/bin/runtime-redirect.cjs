// Machine-scope runtime redirect for the myco CLI shim.
//
// When the machine has `~/.myco/runtime.command` set (managed beta runtime
// or `make dev-link`), this helper re-execs into that binary so the
// interactive CLI matches the binary the daemon, hooks, and MCP server
// already use. Without it, `myco doctor`, `myco update`, etc. resolve to
// the global binary while every other dispatch path resolves to the pin —
// producing version skew between CLI and daemon.
//
// `~/.myco/runtime.command` is the single source of truth for "which myco
// does this machine use." File absent → bare `myco` from PATH.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * Read `~/.myco/runtime.command` (honoring `MYCO_HOME` when set). Returns
 * the trimmed file contents, or null when the file is missing or empty.
 *
 * Filename literal mirrors `MACHINE_RUNTIME_COMMAND_FILENAME` from
 * `src/constants/update.ts`. This file is plain CJS (runs before bun) so
 * it can't import the TS source of truth.
 */
function readMachineRuntimeCommand(env = process.env) {
  try {
    const home = env.MYCO_HOME ? expandHome(env.MYCO_HOME) : path.join(os.homedir(), '.myco');
    const raw = fs.readFileSync(path.join(home, 'runtime.command'), 'utf-8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * True when `target` and `selfPath` resolve (through symlinks) to the same
 * binary — used to skip a redirect that would just re-exec into ourselves.
 * Returns false on any filesystem error (target missing, permission, etc.)
 * so the caller proceeds to attempt the exec and handles ENOENT there.
 */
function pointsAtSelf(target, selfPath) {
  // Unqualified PATH commands (`myco`, `myco-dev`) can't be self-redirects:
  // selfPath is always absolute, so realpathSync(target) would either fail or
  // resolve to a different binary. Skip the syscall on the common case.
  if (!target.includes(path.sep)) return false;
  try {
    return fs.realpathSync(target) === fs.realpathSync(selfPath);
  } catch {
    return false;
  }
}

/**
 * If a machine-scope runtime pin applies and points at a different binary
 * than ourselves, re-exec into it with forwarded argv and an env var set
 * to prevent infinite redirect loops. Exits the process on successful
 * redirect (propagating the child's exit code).
 *
 * Returns `false` when no redirect happens, so the caller falls through
 * to its normal dispatch. Skip reasons: `MYCO_REDIRECTED` already set,
 * no pin found, pin points at self, or pin target is missing.
 *
 * When `MYCO_DEBUG_REDIRECT` is set in env, each redirect and each skip
 * emits a single-line trace to stderr — useful when `which myco` reports
 * one binary but `myco --version` seems to run a different one.
 */
function maybeRedirect(selfPath, env = process.env) {
  const debug = Boolean(env.MYCO_DEBUG_REDIRECT);
  const trace = (msg) => {
    if (debug) process.stderr.write(`[myco] redirect: ${msg}\n`);
  };

  if (env.MYCO_REDIRECTED) {
    trace('skip (MYCO_REDIRECTED already set)');
    return false;
  }
  const pin = readMachineRuntimeCommand(env);
  if (!pin) {
    trace('skip (no ~/.myco/runtime.command pin found)');
    return false;
  }
  if (pointsAtSelf(pin, selfPath)) {
    trace(`skip (pin points at self: ${pin})`);
    return false;
  }

  trace(`${selfPath} → ${pin}`);
  try {
    execFileSync(pin, process.argv.slice(2), {
      stdio: 'inherit',
      env: { ...env, MYCO_REDIRECTED: '1' },
    });
    process.exit(0);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      trace(`fallback to normal dispatch (pin target missing: ${pin})`);
      return false;
    }
    process.exit((err && typeof err.status === 'number') ? err.status : 1);
  }
}

module.exports = {
  readMachineRuntimeCommand,
  pointsAtSelf,
  maybeRedirect,
};
