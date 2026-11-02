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
// installed users is the file's absence) or an absolute command path.
// Absolute paths bypass PATH entirely, which matters because GUI-
// launched agents (Cursor, Claude Code desktop, etc.) run under macOS
// launchd and inherit a minimal PATH that typically doesn't include
// `~/.local/bin`.
//
// Machine-scoped: there's exactly one daemon per machine, and the runtime
// that backs it is a machine-level choice, not per-project.
//
// `runtime.home` sits beside the winning `runtime.command` in the same dir: a
// plaintext, single-line, absolute home path. When present and trusted it sets
// MYCO_HOME before exec so a project pinned to a non-default home
// reaches the matching daemon. Shares the winning-pin dir and the G7 trust
// check below — identical to the CLI shim's runtime-redirect.cjs.
//
// An MYCO_HOME already in the environment wins: explicit beats implicit at
// every layer, which is the order `src/paths/home.ts` applies. A value that is
// not an absolute path is refused — a relative one would resolve against
// whatever directory this process stands in.
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
    stat = fs.lstatSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, reason: 'pin file missing' };
    return { ok: false, reason: `stat failed: ${(err && err.message) || 'unknown'}` };
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: 'pin file is a symlink' };
  const myUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (myUid !== null && stat.uid !== myUid) {
    return { ok: false, reason: `pin file owned by uid ${stat.uid}, expected ${myUid}` };
  }
  if ((stat.mode & 0o777) & RUNTIME_COMMAND_INSECURE_MODE_MASK) {
    return { ok: false, reason: 'pin file writable by group/other' };
  }
  return { ok: true };
}

function readPinFile(filePath, projectPin = false) {
  if (!checkRuntimePinTrust(filePath).ok) return null;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (projectPin && raw && !projectPinIsTrusted(filePath)) return null;
    return raw || null;
  } catch { return null; }
}

function readProjectRuntimeCommand(startDir) {
  let dir = path.resolve(startDir);
  while (true) {
    const source = path.join(dir, '.myco', 'runtime.command');
    const pin = readPinFile(source, dir !== os.homedir());
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

// A trusted pin whose value names an absolute path. A relative value would
// resolve against this process's cwd, so a `runtime.home` committed into a
// repository could redirect a clone's capture at a directory that repository
// controls.
function readAbsolutePinValue(filePath) {
  const raw = readPinFile(filePath, path.dirname(path.dirname(filePath)) !== os.homedir());
  if (!raw) return null;
  const expanded = expandHome(raw);
  return path.isAbsolute(expanded) ? expanded : null;
}

// <myco:project-pin-trust>
const pinFs = require('node:fs');
const pinOs = require('node:os');
const pinPath = require('node:path');
const { createHash: pinHash, randomUUID: pinNonce } = require('node:crypto');

const PROJECT_PIN_TRUST_DIRECTORY = 'project-pin-trust';

function pinDigest(value) {
  return pinHash('sha256').update(value).digest('hex');
}

function projectPinIdentity(filePath) {
  const directory = pinPath.dirname(filePath);
  const root = pinFs.realpathSync(pinPath.dirname(directory));
  if (pinFs.realpathSync(directory) !== pinPath.join(root, '.myco')) throw new Error('pin directory is a symlink');
  let repo = root;
  while (true) {
    const dotGit = pinPath.join(repo, '.git');
    if (pinFs.existsSync(dotGit)) {
      const stat = pinFs.lstatSync(dotGit);
      if (stat.isSymbolicLink()) throw new Error('git directory is a symlink');
      let common = dotGit;
      if (!stat.isDirectory()) {
        const match = /^gitdir: (.+)\s*$/.exec(pinFs.readFileSync(dotGit, 'utf8').trim());
        if (!match) throw new Error('invalid git directory');
        const admin = pinFs.realpathSync(pinPath.resolve(repo, match[1]));
        common = pinFs.realpathSync(pinPath.resolve(admin, pinFs.readFileSync(pinPath.join(admin, 'commondir'), 'utf8').trim()));
        const backlink = pinFs.realpathSync(pinPath.resolve(admin, pinFs.readFileSync(pinPath.join(admin, 'gitdir'), 'utf8').trim()));
        if (backlink !== pinFs.realpathSync(dotGit) || pinPath.dirname(admin) !== pinPath.join(common, 'worktrees')) throw new Error('unregistered worktree');
      }
      return JSON.stringify([pinFs.realpathSync(common), pinPath.relative(repo, root), pinPath.basename(filePath)]);
    }
    const parent = pinPath.dirname(repo);
    if (parent === repo) return JSON.stringify([root, pinPath.basename(filePath)]);
    repo = parent;
  }
}

function projectPinRecord(filePath, homeDir) {
  const base = pinPath.join(homeDir, '.myco', PROJECT_PIN_TRUST_DIRECTORY);
  return pinPath.join(base, `${pinDigest(projectPinIdentity(filePath))}.json`);
}

function outsideCheckout(directory) {
  let dir = pinFs.realpathSync(directory);
  while (true) {
    if (pinFs.existsSync(pinPath.join(dir, '.git'))) throw new Error('project pin trust must live outside a checkout');
    const parent = pinPath.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** Project pins require this user's approval of the local repository and pin path. */
function projectPinIsTrusted(filePath, homeDir = process.env.HOME || process.env.USERPROFILE || pinOs.homedir()) {
  try {
    const record = projectPinRecord(filePath, homeDir);
    outsideCheckout(pinPath.dirname(record));
    const stat = pinFs.lstatSync(record);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    if (process.platform !== 'win32' && ((stat.mode & 0o022) || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))) return false;
    const approved = JSON.parse(pinFs.readFileSync(record, 'utf8'));
    return approved.identity === projectPinIdentity(filePath);
  } catch {
    return false;
  }
}

/** Explicit pin-writing and approval commands are the only callers of this writer. */
function trustProjectPin(filePath, homeDir = process.env.HOME || process.env.USERPROFILE || pinOs.homedir()) {
  const stat = pinFs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('pin must be a regular file');
  if (process.platform !== 'win32' && ((stat.mode & 0o022) || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))) throw new Error('pin ownership or permissions are unsafe');
  const value = pinFs.readFileSync(filePath, 'utf8').trim();
  if (!value) throw new Error('pin is empty');
  const record = projectPinRecord(filePath, homeDir);
  pinFs.mkdirSync(pinPath.dirname(record), { recursive: true, mode: 0o700 });
  outsideCheckout(pinPath.dirname(record));
  const temporary = `${record}.${pinNonce()}`;
  try {
    pinFs.writeFileSync(temporary, JSON.stringify({ identity: projectPinIdentity(filePath) }) + '\n', { mode: 0o600, flag: 'wx' });
    pinFs.renameSync(temporary, record);
  } finally {
    pinFs.rmSync(temporary, { force: true });
  }
}
// </myco:project-pin-trust>

const found = readLayeredRuntimeCommand();
const bin = found ? found.pin : 'myco';

// Read the trusted `runtime.home` beside the winning `runtime.command` and set
// MYCO_HOME before exec. Absent, refused, or already set → leave it as-is.
if (found && !(process.env.MYCO_HOME || '').trim()) {
  const homePin = readAbsolutePinValue(path.join(path.dirname(found.source), 'runtime.home'));
  if (homePin) process.env.MYCO_HOME = homePin;
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
