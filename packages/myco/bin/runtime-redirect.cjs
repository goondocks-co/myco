// Layered runtime redirect for the myco CLI shim.
//
// Looks up `runtime.command` in two scopes, in order:
//
//   1. **Project**: walk up from cwd looking for `<dir>/.myco/runtime.command`.
//      Written by `make dev-link` so dev-mode applies only when the user is
//      working inside the dogfood project — not machine-wide.
//   2. **Machine**: `~/.myco/runtime.command` (honoring `MYCO_HOME`).
//      Written by the beta-channel installer to redirect every CLI invocation
//      on the host into the managed runtime under `~/.myco/runtime/`.
//
// Either layer's value is the absolute path of the binary to re-exec.
// Falling through both means "no redirect — run the bundled binary."
// This mirrors the layered config hierarchy: project pin overrides machine
// pin, machine pin applies as fallback.
//
// G7 (security): `runtime.command` files are exec'd as the user's `myco`
// binary. A sloppy umask that leaves either file group/other-writable would
// let a hostile local user redirect every `myco` command. Both layers go
// through `checkRuntimeCommandTrust`, which refuses any pin file whose stat
// shows owner != us or whose mode permits group/other write.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RUNTIME_COMMAND_INSECURE_MODE_MASK = 0o022;
const RUNTIME_COMMAND_FILENAME = 'runtime.command';

function checkRuntimeCommandTrust(filePath) {
  if (process.platform === 'win32') return { ok: true };
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, reason: 'pin file missing' };
    return { ok: false, reason: `stat failed: ${(err && err.message) || 'unknown'}` };
  }
  const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (myUid !== null && stat.uid !== myUid) {
    return { ok: false, reason: `pin file owned by uid ${stat.uid}, expected ${myUid}` };
  }
  const mode = stat.mode & 0o777;
  if (mode & RUNTIME_COMMAND_INSECURE_MODE_MASK) {
    return { ok: false, reason: `pin file mode 0${mode.toString(8)} is writable by group/other` };
  }
  return { ok: true };
}

function readPinAt(filePath, traceRefusal) {
  const trust = checkRuntimeCommandTrust(filePath);
  if (!trust.ok) {
    if (typeof traceRefusal === 'function') traceRefusal(`${filePath}: ${trust.reason}`);
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * Walk up from `startDir` looking for `<dir>/.myco/runtime.command`. Returns
 * `{ pin, source }` on the first hit, or null when no project pin exists in
 * any ancestor of `startDir`. Stops at the filesystem root.
 */
function readProjectRuntimeCommand(startDir, traceRefusal) {
  let dir = path.resolve(startDir);
  while (true) {
    const candidate = path.join(dir, '.myco', RUNTIME_COMMAND_FILENAME);
    const pin = readPinAt(candidate, traceRefusal);
    if (pin) return { pin, source: candidate };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readMachineRuntimeCommand(env, traceRefusal) {
  const home = env.MYCO_HOME ? expandHome(env.MYCO_HOME) : path.join(os.homedir(), '.myco');
  const filePath = path.join(home, RUNTIME_COMMAND_FILENAME);
  const pin = readPinAt(filePath, traceRefusal);
  return pin ? { pin, source: filePath } : null;
}

/**
 * Layered lookup: project pin (walking up from `startDir`) wins over machine
 * pin. Returns `{ pin, source }` describing which file produced the value,
 * or null when neither layer has a usable pin.
 */
function readLayeredRuntimeCommand(startDir, env = process.env, traceRefusal) {
  return (
    readProjectRuntimeCommand(startDir, traceRefusal)
    ?? readMachineRuntimeCommand(env, traceRefusal)
  );
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return value;
}

function pointsAtSelf(target, selfPath) {
  if (!target.includes(path.sep)) return false;
  try {
    return fs.realpathSync(target) === fs.realpathSync(selfPath);
  } catch {
    return false;
  }
}

/**
 * If a runtime pin (project or machine) applies and points at a different
 * binary than ourselves, re-exec into it with forwarded argv and an env var
 * set to prevent infinite redirect loops. Exits the process on successful
 * redirect (propagating the child's exit code).
 *
 * Returns `false` when no redirect happens. Skip reasons: `MYCO_REDIRECTED`
 * already set, no pin found in either layer, pin points at self, or pin
 * target is missing.
 *
 * `MYCO_DEBUG_REDIRECT=1` traces each lookup decision on stderr.
 */
function maybeRedirect(selfPath, env = process.env, startDir = process.cwd()) {
  const debug = Boolean(env.MYCO_DEBUG_REDIRECT);
  const trace = (msg) => {
    if (debug) process.stderr.write(`[myco] redirect: ${msg}\n`);
  };

  if (env.MYCO_REDIRECTED) {
    trace('skip (MYCO_REDIRECTED already set)');
    return false;
  }
  const found = readLayeredRuntimeCommand(startDir, env, (reason) => trace(`refused (${reason})`));
  if (!found) {
    trace('skip (no project or machine runtime.command pin)');
    return false;
  }
  if (pointsAtSelf(found.pin, selfPath)) {
    trace(`skip (pin points at self: ${found.pin})`);
    return false;
  }

  trace(`${selfPath} → ${found.pin} (via ${found.source})`);
  try {
    execFileSync(found.pin, process.argv.slice(2), {
      stdio: 'inherit',
      env: { ...env, MYCO_REDIRECTED: '1' },
    });
    process.exit(0);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      trace(`fallback to normal dispatch (pin target missing: ${found.pin})`);
      return false;
    }
    process.exit((err && typeof err.status === 'number') ? err.status : 1);
  }
}

module.exports = {
  readProjectRuntimeCommand,
  readMachineRuntimeCommand,
  readLayeredRuntimeCommand,
  pointsAtSelf,
  maybeRedirect,
  checkRuntimeCommandTrust,
};
