#!/usr/bin/env node
// Myco hook guard — silently no-ops when myco is not installed.
// MYCO_LAUNCHER_PROTOCOL=v2
//
// This file is committed to the repo so open-source contributors without
// Myco don't see hook errors in their agent sessions. It stays deliberately
// thin: its only jobs are (1) provide a cross-platform entry point that
// works under every shell our symbionts fire hooks from, and (2) resolve
// which myco binary to exec via the layered runtime.command pin
// (project-scope `<project>/.myco/runtime.command` first, then machine-scope
// `~/.myco/runtime.command`).
//
// The `MYCO_LAUNCHER_PROTOCOL=v2` sentinel above is read by the global
// launcher (~/.myco/launcher.cjs) before delegating to this file. Pre-
// upgrade brownfield stubs lack the sentinel — the global launcher refuses
// to delegate to them and queues the project for walker cleanup instead.
// Bumping the version (v2 → v3) requires teaching the global launcher
// to accept the new value.
//
// Managed by: myco update. Safe to delete: myco remove.
'use strict';

// Skip hooks for Myco's own agent pipeline sessions — they are internal
// and should not be captured as user sessions.
if (process.env.MYCO_AGENT_SESSION) process.exit(0);

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Defensively pin cwd to the project root. Cursor's hook spawn drops stdin
// when the command uses shell operators, so our installed hook commands
// invoke this guard directly (no `cd "$(...)" &&` prefix). The chdir keeps
// vault resolution working even when the spawning agent's cwd isn't set.
try { process.chdir(path.resolve(__dirname, '..')); } catch { /* best effort */ }

// Resolve which myco binary to invoke.
//
// `~/.myco/runtime.command` is the source of truth — a one-line plain-text
// file holding either a PATH-resolvable name (the default for globally-
// installed users is the file's absence) or an absolute path to a managed/
// dev binary (what `make dev-link` writes; what the beta-channel installer
// writes). Absolute paths bypass PATH entirely, which matters because GUI-
// launched agents (Cursor, Claude Code desktop, etc.) run under macOS
// launchd and inherit a minimal PATH that typically doesn't include
// `~/.local/bin`.
//
// Machine-scoped: there's exactly one daemon per machine, and the runtime
// that backs it is a machine-level choice, not per-project.
//
// `runtime.home` sits beside the winning `runtime.command` in the same dir: a
// plaintext, single-line, absolute home path. When present and trusted it sets
// MYCO_HOME before exec so a project pinned to a dev home (`~/.myco-dev`)
// reaches the matching daemon. Shares the winning-pin dir and the G7 trust
// check below — identical to the CLI shim's runtime-redirect.cjs.
const args = process.argv.slice(2);

// G7 (security): pin files are exec'd as the user's `myco` binary, so a
// group/other-writable or foreign-owned pin would let a hostile local user
// redirect every hook invocation. Refuse any such pin — matches
// checkRuntimeCommandTrust in bin/runtime-redirect.cjs.
const RUNTIME_COMMAND_INSECURE_MODE_MASK = 0o022;

function checkRuntimePinTrust(filePath) {
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
  if ((stat.mode & 0o777) & RUNTIME_COMMAND_INSECURE_MODE_MASK) {
    return { ok: false, reason: 'pin file writable by group/other' };
  }
  return { ok: true };
}

function readPinFile(filePath) {
  if (!checkRuntimePinTrust(filePath).ok) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    return raw || null;
  } catch { return null; }
}

function readProjectRuntimeCommand(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    const source = path.join(dir, '.myco', 'runtime.command');
    const pin = readPinFile(source);
    if (pin) return { pin, source };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function readMachineRuntimeCommand() {
  const home = process.env.MYCO_HOME ? expandHome(process.env.MYCO_HOME) : path.join(os.homedir(), '.myco');
  const source = path.join(home, 'runtime.command');
  const pin = readPinFile(source);
  return pin ? { pin, source } : null;
}

function readLayeredRuntimeCommand() {
  return readProjectRuntimeCommand(process.cwd()) ?? readMachineRuntimeCommand();
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return value;
}

const found = readLayeredRuntimeCommand();
const bin = found ? found.pin : 'myco';

// Read the trusted `runtime.home` beside the winning `runtime.command` and set
// MYCO_HOME before exec. Absent → leave MYCO_HOME as-is (prod default).
if (found) {
  const homePin = readPinFile(path.join(path.dirname(found.source), 'runtime.home'));
  if (homePin) process.env.MYCO_HOME = expandHome(homePin);
}

function toolNameFromArgs(args) {
  if (args[0] !== 'tool' || args[1] !== 'call') return undefined;
  for (let idx = 2; idx < args.length; idx++) {
    const arg = args[idx];
    if (arg === '--json') continue;
    if (arg === '--input') {
      idx++;
      continue;
    }
    if (arg && !arg.startsWith('-')) return arg;
  }
  return undefined;
}

function writeToolRuntimeUnavailable(command, args) {
  const tool = toolNameFromArgs(args);
  const envelope = {
    ok: false,
    ...(tool ? { tool } : {}),
    error: {
      code: 'runtime_unavailable',
      message: `Myco runtime command '${command}' could not be found. Check <project>/.myco/runtime.command and ~/.myco/runtime.command, or run Myco update from a shell where Myco is installed.`,
    },
  };
  process.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
}

try {
  execFileSync(bin, args, { stdio: 'inherit' });
} catch (e) {
  if (e.code === 'ENOENT') {
    if (args[0] === 'tool') {
      writeToolRuntimeUnavailable(bin, args);
      process.exit(1);
    }
    process.exit(0);
  }
  process.exit(e.status ?? 1);
}
