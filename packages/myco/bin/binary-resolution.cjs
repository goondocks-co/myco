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
    const raw = projectPin ? readApprovedProjectPin(filePath) : fs.readFileSync(filePath, 'utf-8').trim();
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
  readApprovedProjectPin,
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
