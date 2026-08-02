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
// `runtime.home` (a sibling of the winning `runtime.command` in the same dir)
// is a plaintext, single-line, absolute home path. When present and trusted it
// sets `MYCO_HOME` on the re-exec'd child so a project pinned to a dev home
// routes every CLI invocation at the matching daemon. It shares the winning-pin
// dir and the G7 trust check below.
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
const resolution = require('./binary-resolution.cjs');

const RUNTIME_COMMAND_FILENAME = 'runtime.command';
const RUNTIME_HOME_FILENAME = 'runtime.home';

// Trust semantics live in the shared module; this name survives for callers.
function checkRuntimeCommandTrust(filePath) {
  return resolution.checkPinTrust(filePath);
}

function readPinAt(filePath, traceRefusal) {
  const trust = resolution.checkPinTrust(filePath);
  if (!trust.ok) {
    if (typeof traceRefusal === 'function') traceRefusal(`${filePath}: ${trust.reason}`);
    return null;
  }
  return resolution.readTrustedPin(filePath);
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
  return resolution.expandHome(value);
}

/**
 * Read the `runtime.home` pin that sits beside the winning `runtime.command`
 * file. A project pinned to a dev home (`~/.myco-dev`) writes both files in the
 * same `.myco/` dir; the home pin is the sibling of the command pin so it
 * inherits the SAME winning-layer resolution and the SAME G7 trust check.
 *
 * Returns the absolute `MYCO_HOME` value (a plain single-line path) when a
 * trusted pin is present, or null when absent / untrusted (untrusted pins are
 * refused exactly like an untrusted `runtime.command`).
 */
function readRuntimeHomeBeside(commandSource, traceRefusal) {
  const filePath = path.join(path.dirname(commandSource), RUNTIME_HOME_FILENAME);
  const home = readPinAt(filePath, traceRefusal);
  return home ? expandHome(home) : null;
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

  // A trusted `runtime.home` beside the winning command pin redirects this
  // invocation's home to a non-default daemon (e.g. a dogfood `~/.myco-dev`).
  // Absent → leave MYCO_HOME as-is (prod default). Untrusted → refused inside
  // readRuntimeHomeBeside, same as an untrusted runtime.command.
  const pinnedHome = readRuntimeHomeBeside(found.source, (reason) => trace(`home refused (${reason})`));
  const childEnv = { ...env, MYCO_REDIRECTED: '1' };
  if (pinnedHome) {
    trace(`MYCO_HOME → ${pinnedHome} (via ${path.join(path.dirname(found.source), RUNTIME_HOME_FILENAME)})`);
    childEnv.MYCO_HOME = pinnedHome;
  }

  trace(`${selfPath} → ${found.pin} (via ${found.source})`);
  try {
    execFileSync(found.pin, process.argv.slice(2), {
      stdio: 'inherit',
      env: childEnv,
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
  readRuntimeHomeBeside,
  pointsAtSelf,
  maybeRedirect,
  checkRuntimeCommandTrust,
};
