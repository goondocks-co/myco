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
    const raw = projectPin ? readApprovedProjectPin(filePath) : fs.readFileSync(filePath, 'utf-8').trim();
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
const PROJECT_PIN_GIT_TRUST_DIRECTORY = 'myco-project-pin-trust';
const PROJECT_PIN_MODE = 0o644;
const PROJECT_PIN_APPROVAL_MODE = 0o600;
const PROJECT_PIN_DIRECTORY_MODE = 0o700;
const PROJECT_PIN_UNSAFE_MODE = 0o022;
const pinUserHome = () => process.env.HOME || process.env.USERPROFILE || pinOs.homedir();
const pinDigest = value => pinHash('sha256').update(value).digest('hex');

function pinObjectIdentity(directory) {
  const stat = pinFs.statSync(directory);
  return [pinFs.realpathSync(directory), stat.dev, stat.ino, stat.birthtimeMs];
}

function projectPinContext(filePath) {
  const directory = pinPath.dirname(filePath);
  const root = pinFs.realpathSync(pinPath.dirname(directory));
  let repo = root;
  while (true) {
    const dotGit = pinPath.join(repo, '.git');
    if (pinFs.existsSync(dotGit)) {
      const stat = pinFs.lstatSync(dotGit);
      if (stat.isSymbolicLink()) throw new Error('git directory is a symlink');
      let common = dotGit;
      let linked = false;
      if (!stat.isDirectory()) {
        const match = /^gitdir: (.+)\s*$/.exec(pinFs.readFileSync(dotGit, 'utf8').trim());
        if (!match) throw new Error('invalid git directory');
        const admin = pinFs.realpathSync(pinPath.resolve(repo, match[1]));
        const commonFile = pinPath.join(admin, 'commondir');
        common = admin;
        if (pinFs.existsSync(commonFile)) {
          common = pinFs.realpathSync(pinPath.resolve(admin, pinFs.readFileSync(commonFile, 'utf8').trim()));
          const backlink = pinFs.realpathSync(pinPath.resolve(admin, pinFs.readFileSync(pinPath.join(admin, 'gitdir'), 'utf8').trim()));
          if (backlink !== pinFs.realpathSync(dotGit) || pinPath.dirname(admin) !== pinPath.join(common, 'worktrees')) throw new Error('unregistered worktree');
          linked = true;
        }
      }
      return { identity: JSON.stringify([pinObjectIdentity(common), pinPath.relative(repo, root), pinPath.basename(filePath)]), root: repo, linked };
    }
    const parent = pinPath.dirname(repo);
    if (parent === repo) return { identity: JSON.stringify([pinObjectIdentity(root), pinPath.basename(filePath)]), root, linked: false };
    repo = parent;
  }
}

function pinTrustLocation(homeDir) {
  const dotGit = pinPath.join(homeDir, '.git');
  if (!pinFs.existsSync(dotGit)) return { directory: pinPath.join(homeDir, '.myco', PROJECT_PIN_TRUST_DIRECTORY), anchor: homeDir };
  const stat = pinFs.lstatSync(dotGit);
  let metadata;
  if (stat.isDirectory()) metadata = pinFs.realpathSync(dotGit);
  else if (stat.isFile()) {
    const match = /^gitdir: (.+)\s*$/.exec(pinFs.readFileSync(dotGit, 'utf8').trim());
    if (!match) throw new Error('invalid user-home Git metadata pointer');
    metadata = pinFs.realpathSync(pinPath.resolve(homeDir, match[1]));
  } else throw new Error('user-home Git metadata must not be a symlink');
  let current = metadata;
  while (pinPath.basename(current) !== '.git') {
    if (pinFs.existsSync(pinPath.join(current, '.git'))) throw new Error('user-home Git metadata must be outside working trees');
    const parent = pinPath.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { directory: pinPath.join(metadata, PROJECT_PIN_GIT_TRUST_DIRECTORY), anchor: metadata };
}

function projectPinRecord(filePath, homeDir, value) {
  return pinPath.join(pinTrustLocation(homeDir).directory, `${pinDigest(projectPinContext(filePath).identity)}${value === undefined ? "" : "-" + pinDigest(value.trim())}.json`);
}

/** Approval files stay within private user state, including protected metadata for a home checkout. */
function assertPinTrustDirectory(directory, homeDir) {
  const { anchor } = pinTrustLocation(homeDir);
  const authority = pinFs.realpathSync(anchor);
  let current = pinPath.resolve(directory);
  while (current !== pinPath.resolve(anchor)) {
    if (pinFs.existsSync(current)) {
      if (!pinFs.statSync(current).isDirectory()) throw new Error('project pin approval path is not a directory');
      const physical = pinFs.realpathSync(current);
      const relative = pinPath.relative(authority, physical);
      if (relative === '..' || relative.startsWith(`..${pinPath.sep}`) || pinPath.isAbsolute(relative)) throw new Error('project pin trust must remain in private user state');
      if (pinFs.lstatSync(current).isSymbolicLink() || pinFs.existsSync(pinPath.join(current, '.git'))) throw new Error('project pin trust must be outside project checkouts');
    }
    const parent = pinPath.dirname(current);
    if (parent === current) throw new Error('project pin trust must remain in private user state');
    current = parent;
  }
}

function assertProjectPinDirectory(filePath) {
  const directory = pinPath.dirname(filePath);
  if (pinFs.existsSync(directory) && pinFs.realpathSync(directory) !== pinPath.join(pinFs.realpathSync(pinPath.dirname(directory)), '.myco')) throw new Error('pin directory is a symlink');
}

function assertPinStat(stat, safeMode = true) {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('pin must be a regular file');
  if (process.platform !== 'win32' && ((safeMode && (stat.mode & PROJECT_PIN_UNSAFE_MODE)) || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))) throw new Error('pin ownership or permissions are unsafe');
}

/** One approved value, read once from the checked file, or no authority to follow it. */
function readApprovedProjectPin(filePath, homeDir = pinUserHome()) {
  try {
    const base = projectPinRecord(filePath, homeDir);
    assertPinTrustDirectory(pinPath.dirname(base), homeDir);
    const prefix = pinPath.basename(base, '.json') + '-';
    if (!pinFs.readdirSync(pinPath.dirname(base)).some(name => name.startsWith(prefix) && name.endsWith('.json'))) return null;
    const context = projectPinContext(filePath);
    assertProjectPinDirectory(filePath);
    const fd = pinFs.openSync(filePath, pinFs.constants.O_RDONLY | (pinFs.constants.O_NOFOLLOW ?? 0));
    try {
      assertPinStat(pinFs.fstatSync(fd));
      const value = pinFs.readFileSync(fd, 'utf8').trim();
      if (!value) return null;
      const record = projectPinRecord(filePath, homeDir, value);
      assertPinStat(pinFs.lstatSync(record));
      const approved = JSON.parse(pinFs.readFileSync(record, 'utf8'));
      return approved.identity === context.identity && (context.linked || approved.roots?.includes(context.root))
        && approved.valueDigest === pinDigest(value) ? value : null;
    } finally { pinFs.closeSync(fd); }
  } catch {
    return null;
  }
}

function projectPinIsTrusted(filePath, homeDir = pinUserHome()) {
  return readApprovedProjectPin(filePath, homeDir) !== null;
}

/** Validate the pin and approval destinations without changing either one. */
function preflightProjectPinWrite(filePath, homeDir = pinUserHome()) {
  assertProjectPinDirectory(filePath);
  projectPinContext(filePath);
  if (pinFs.existsSync(filePath)) assertPinStat(pinFs.lstatSync(filePath), false);
  const record = projectPinRecord(filePath, homeDir);
  assertPinTrustDirectory(pinPath.dirname(record), homeDir);
  for (const target of [pinPath.dirname(filePath), pinPath.dirname(record)]) {
    let ancestor = target;
    while (!pinFs.existsSync(ancestor)) ancestor = pinPath.dirname(ancestor);
    pinFs.accessSync(ancestor, pinFs.constants.W_OK);
  }
}

function approvalData(filePath, value, homeDir, ownerHome) {
  const context = projectPinContext(filePath);
  const record = projectPinRecord(filePath, homeDir, value);
  let roots = [];
  if (pinFs.existsSync(record)) {
    assertPinStat(pinFs.lstatSync(record));
    const approved = JSON.parse(pinFs.readFileSync(record, 'utf8'));
    if (approved.identity === context.identity && approved.valueDigest === pinDigest(value.trim())) roots = approved.roots ?? [];
  }
  return JSON.stringify({ identity: context.identity, roots: [...new Set([...roots, context.root])], valueDigest: pinDigest(value.trim()), ownerHome: pinPath.resolve(ownerHome ?? process.env.MYCO_HOME ?? pinPath.join(homeDir, '.myco')) }) + '\n';
}

function withPinApproval(filePath, value, homeDir, ownerHome, writePin) {
  preflightProjectPinWrite(filePath, homeDir);
  if (!value.trim()) throw new Error('pin is empty');
  const record = projectPinRecord(filePath, homeDir, value);
  pinFs.mkdirSync(pinPath.dirname(record), { recursive: true, mode: PROJECT_PIN_DIRECTORY_MODE });
  const lock = pinPath.join(pinPath.dirname(record), '.write.lock');
  pinFs.mkdirSync(lock, { mode: PROJECT_PIN_DIRECTORY_MODE });
  const temporary = pinPath.join(lock, 'approval.json');
  try {
    pinFs.writeFileSync(temporary, approvalData(filePath, value, homeDir, ownerHome), { mode: PROJECT_PIN_APPROVAL_MODE, flag: 'wx' });
    pinFs.chmodSync(temporary, PROJECT_PIN_APPROVAL_MODE);
    return writePin(() => pinFs.renameSync(temporary, record));
  } finally { pinFs.rmSync(lock, { recursive: true, force: true }); }
}

/** Explicit approval of an existing pin never changes the pin itself. */
function trustProjectPin(filePath, homeDir = pinUserHome(), ownerHome) {
  assertPinStat(pinFs.lstatSync(filePath));
  const value = pinFs.readFileSync(filePath, 'utf8').trim();
  const record = projectPinRecord(filePath, homeDir, value);
  if (readApprovedProjectPin(filePath, homeDir) === value) {
    const approved = JSON.parse(pinFs.readFileSync(record, 'utf8'));
    const owner = pinPath.resolve(ownerHome ?? process.env.MYCO_HOME ?? pinPath.join(homeDir, '.myco'));
    if (approved.ownerHome === owner) return;
  }
  withPinApproval(filePath, value, homeDir, ownerHome, publish => {
    if (pinFs.readFileSync(filePath, 'utf8').trim() !== value) throw new Error('pin changed during approval');
    publish();
  });
}

/** Publish the pin and its approval together; a failed approval leaves the prior pin intact. */
function writeTrustedProjectPin(filePath, value, options = {}) {
  const homeDir = options.homeDir ?? pinUserHome();
  return withPinApproval(filePath, value, homeDir, options.ownerHome, publish => {
    const previous = pinFs.existsSync(filePath) ? { bytes: pinFs.readFileSync(filePath), mode: pinFs.statSync(filePath).mode & 0o777 } : null;
    const mode = previous ? previous.mode & ~PROJECT_PIN_UNSAFE_MODE : PROJECT_PIN_MODE;
    const staged = `${filePath}.${pinNonce()}`;
    let changed = false;
    try {
      pinFs.mkdirSync(pinPath.dirname(filePath), { recursive: true });
      if (options.replace) {
        pinFs.writeFileSync(staged, value, { mode, flag: 'wx' });
        pinFs.chmodSync(staged, mode);
        pinFs.renameSync(staged, filePath);
        changed = true;
      } else {
        const fd = pinFs.openSync(filePath, 'wx', PROJECT_PIN_MODE);
        changed = true;
        try { pinFs.writeFileSync(fd, value); pinFs.fchmodSync(fd, PROJECT_PIN_MODE); } finally { pinFs.closeSync(fd); }
      }
      publish();
    } catch (error) {
      if (changed) {
        try {
          if (previous) { pinFs.writeFileSync(staged, previous.bytes, { mode: previous.mode, flag: 'wx' }); pinFs.chmodSync(staged, previous.mode); pinFs.renameSync(staged, filePath); }
          else pinFs.rmSync(filePath);
        } catch (rollback) { throw new AggregateError([error, rollback], 'project pin publication and rollback failed'); }
      }
      throw error;
    } finally { pinFs.rmSync(staged, { force: true }); }
  });
}

function projectPinTrustFiles(ownerHome, homeDir = pinUserHome()) {
  const { directory } = pinTrustLocation(homeDir);
  if (!pinFs.existsSync(directory)) return [];
  assertPinTrustDirectory(directory, homeDir);
  return pinFs.readdirSync(directory).filter(name => name.endsWith('.json')).flatMap(name => {
    const file = pinPath.join(directory, name);
    assertPinStat(pinFs.lstatSync(file));
    const record = JSON.parse(pinFs.readFileSync(file, 'utf8'));
    return record.ownerHome === pinPath.resolve(ownerHome) ? [file] : [];
  });
}

/** Purge only this installation's grants from the user's shared approval store. */
function removeProjectPinTrust(ownerHome, homeDir = pinUserHome()) {
  const { directory } = pinTrustLocation(homeDir);
  if (!pinFs.existsSync(directory)) return;
  assertPinTrustDirectory(directory, homeDir);
  const lock = pinPath.join(directory, '.write.lock');
  pinFs.mkdirSync(lock, { mode: PROJECT_PIN_DIRECTORY_MODE });
  try {
    for (const file of projectPinTrustFiles(ownerHome, homeDir)) pinFs.unlinkSync(file);
  } finally { pinFs.rmSync(lock, { recursive: true, force: true }); }
  if (pinFs.readdirSync(directory).length === 0) pinFs.rmdirSync(directory);
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
