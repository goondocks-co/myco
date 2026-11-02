// Standalone binary resolution for existing package dispatch and runtime redirect fixtures.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PIN_INSECURE_MODE_MASK = 0o022;
const PIN_FILENAME = 'runtime.command';

// G7 pin trust: refuse a pin owned by another uid, writable by group/other, or
// reached through a symlink — the pin is exec'd as the user's `myco`. 0o644 is
// trusted. Win32 has no POSIX modes; always trusted. The stat is an `lstat`:
// following the link would report the target's owner and mode.
function checkPinTrust(filePath) {
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
  const mode = stat.mode & 0o777;
  if (mode & PIN_INSECURE_MODE_MASK) {
    return { ok: false, reason: `pin file mode 0${mode.toString(8)} is writable by group/other` };
  }
  return { ok: true };
}

// Trusted pin read: null when absent, untrusted, or empty.
function readTrustedPin(filePath, projectPin = false) {
  const trust = checkPinTrust(filePath);
  if (!trust.ok) {
    // A real refusal is warned unconditionally: a silently ignored pin is
    // indistinguishable from no pin. A missing file stays silent.
    if (trust.reason !== 'pin file missing') {
      try {
        process.stderr.write(`[myco] ignoring runtime pin (${trust.reason}): ${filePath}\n`);
      } catch {
        // stderr unavailable
      }
    }
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8').trim();
    if (projectPin && raw && !projectPinIsTrusted(filePath)) return null;
    return raw || null;
  } catch {
    return null;
  }
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

// `$MYCO_HOME` (with `~` expansion), else `~/.myco`.
function resolveMycoHome() {
  const configured = (process.env.MYCO_HOME || '').trim();
  if (!configured) return path.join(os.homedir(), '.myco');
  return path.resolve(expandHome(configured));
}

// Managed layout; mirrors scripts/managed-paths.mjs (win32 roots at
// %LOCALAPPDATA%, never under the myco-home).
function managedBinDir(mycoHome, platform, localAppData) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    const appDataLocal = localAppData || path.win32.join(os.homedir(), 'AppData', 'Local');
    return p.join(appDataLocal, 'Myco', 'bin');
  }
  return p.join(mycoHome, 'bin');
}

function managedBinaryPath(mycoHome, platform, localAppData) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const binaryName = platform === 'win32' ? 'myco.exe' : 'myco';
  return p.join(managedBinDir(mycoHome, platform, localAppData), binaryName);
}

// Layered pin: project pin by upward filesystem walk from `from` (when given),
// then the machine pin. Returns { pin, pinPath, pinScope } or null.
function readLayeredPin(from) {
  if (from) {
    let dir = path.resolve(from);
    while (true) {
      const candidate = path.join(dir, '.myco', PIN_FILENAME);
      const pin = readTrustedPin(candidate, path.dirname(path.dirname(candidate)) !== os.homedir());
      if (pin) return { pin, pinPath: candidate, pinScope: 'project' };
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const machinePath = path.join(resolveMycoHome(), PIN_FILENAME);
  const pin = readTrustedPin(machinePath);
  return pin ? { pin, pinPath: machinePath, pinScope: 'machine' } : null;
}

// A file that exists and (on POSIX) is executable. Mode-0644 binaries fail.
function isRunnableBinary(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function bareCommandName(platform) {
  return (platform || process.platform) === 'win32' ? 'myco.exe' : 'myco';
}

module.exports = {
  PIN_INSECURE_MODE_MASK,
  checkPinTrust,
  readTrustedPin,
  projectPinIsTrusted,
  expandHome,
  resolveMycoHome,
  managedBinDir,
  managedBinaryPath,
  readLayeredPin,
  isRunnableBinary,
  bareCommandName,
};

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
