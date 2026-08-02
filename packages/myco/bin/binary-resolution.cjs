// Shared binary-resolution primitives for the npm-shipped shims.
//
// CJS mirror of `src/runtime/binary-resolution.ts` for the entry points that
// cannot import TS: `bin/myco.cjs` and `bin/runtime-redirect.cjs` require()
// this file; `bin/myco-run` (ESM) imports it. Agreement with the TS contract
// is gated by tests/runtime/binary-resolution-cjs-agreement.test.ts.
//
// Ships in the npm tarball and versions independently of the compiled binary,
// so it must stay self-contained: no requires beyond node builtins, and no
// assumption that a same-version binary is installed.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PIN_INSECURE_MODE_MASK = 0o022;
const PIN_FILENAME = 'runtime.command';

// G7 pin trust: refuse a pin owned by another uid or writable by group/other —
// the pin is exec'd as the user's `myco`. 0o644 is trusted. Win32 has no POSIX
// modes; always trusted.
function checkPinTrust(filePath) {
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
  if (mode & PIN_INSECURE_MODE_MASK) {
    return { ok: false, reason: `pin file mode 0${mode.toString(8)} is writable by group/other` };
  }
  return { ok: true };
}

// Trusted pin read: null when absent, untrusted, or empty.
function readTrustedPin(filePath) {
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
      const pin = readTrustedPin(candidate);
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
  expandHome,
  resolveMycoHome,
  managedBinDir,
  managedBinaryPath,
  readLayeredPin,
  isRunnableBinary,
  bareCommandName,
};
