/**
 * Binary-resolution contract — the single authority for which `myco` binary a
 * call site executes, writes into a config, or names in instruction text.
 *
 * Resolution facts (pin state, managed-binary layout) are computed once here;
 * call sites choose a POLICY that fixes the resolution order for their caller
 * kind. Policies deliberately differ — a service unit must not follow a pin, a
 * self-re-exec must not resolve away from the running code — and the policy
 * name is the record of that difference.
 *
 * The layout itself lives in `scripts/managed-paths.mjs` (shared with the npm
 * postinstall); this module re-uses it via `install/managed-binary.ts`.
 *
 * Standalone mirrors of this contract exist where imports cannot reach:
 * `bin/binary-resolution.cjs` (npm tarball shims) and the Pi plugin template.
 * Each is gated by an agreement test against this module.
 *
 * Set `MYCO_DEBUG_REDIRECT=1` to trace resolution decisions on stderr — the
 * same switch the CJS shims honor.
 */

import fs from 'node:fs';
import path from 'node:path';
import { managedBinDir, managedBinaryPath } from '../install/managed-binary.js';
import { isDefaultMycoHome, resolveMycoHome } from '../grove/paths.js';
import { MACHINE_RUNTIME_COMMAND_FILENAME } from '../constants/update.js';

/**
 * Resolution order per caller kind.
 *
 * - `self-exec` — commands Myco writes for later execution (hook commands, MCP
 *   configs): trusted pin → runnable managed binary → `process.execPath`.
 * - `self-exec-entry` — re-exec of the RUNNING code: `process.execPath` plus
 *   the dev-mode entry script when present. Never consults pin or managed:
 *   a re-exec must run the same code that is already running.
 * - `home-scoped-managed` — OS service units: managed binary only for the
 *   default myco-home, else `process.execPath`. Never consults the pin. A
 *   non-default-home daemon keeps its own binary (home isolation).
 * - `managed-destination` — the managed path as a COPY TARGET: returned
 *   unconditionally, no existence check.
 * - `instruction` — text handed to an agent: trusted pin → runnable managed
 *   binary → the bare command name. Never `process.execPath` — the composing
 *   process is not necessarily the myco binary.
 */
export type ResolutionPolicy =
  | 'self-exec'
  | 'self-exec-entry'
  | 'home-scoped-managed'
  | 'managed-destination'
  | 'instruction';

/**
 * Pin lookup scope. `machine` reads only `<mycoHome>/runtime.command`;
 * `walk-up` checks `<dir>/.myco/runtime.command` upward from `from` first.
 * Config-writing sites use `machine` — a walk-up pin is a per-project dogfood
 * override and must never be embedded into machine-global agent configs.
 */
export type PinScope = { kind: 'machine' } | { kind: 'walk-up'; from: string };

export interface ResolutionFacts {
  binDir: string;
  managedBinary: string;
  managedExists: boolean;
  managedRunnable: boolean;
  pin: string | null;
  pinPath: string | null;
  pinScope: 'project' | 'machine' | null;
  /** Trust refusal for a machine pin FILE that exists but is not honored. */
  pinRefusal: { pinPath: string; reason: string } | null;
}

export interface ResolvedBinary {
  path: string;
  source: 'pin' | 'managed' | 'last-resort';
  /** Extra argv the caller must pass before its own args (`self-exec-entry`). */
  args: string[];
  facts: ResolutionFacts;
}

/** Injectable environment so the full matrix is testable without a real host. */
export interface ResolutionEnv {
  mycoHome?: string;
  platform?: NodeJS.Platform;
  localAppData?: string | undefined;
  execPath?: string;
  argv1?: string | undefined;
  getuid?: (() => number) | undefined;
}

const PIN_INSECURE_MODE_MASK = 0o022;

/**
 * G7 pin trust: refuse a pin owned by another uid or writable by group/other.
 * The pin is exec'd as the user's `myco`, so writability is the threat
 * surface; `0o644` is trusted. Win32 has no POSIX modes — always trusted.
 */
export function checkPinTrust(
  filePath: string,
  env: ResolutionEnv = {},
): { ok: true } | { ok: false; reason: string } {
  const platform = env.platform ?? process.platform;
  if (platform === 'win32') return { ok: true };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: 'pin file missing' };
    return { ok: false, reason: `stat failed: ${(err as Error).message ?? 'unknown'}` };
  }
  const getuid = env.getuid ?? (typeof process.getuid === 'function' ? process.getuid : undefined);
  const myUid = getuid ? getuid() : null;
  if (myUid !== null && stat.uid !== myUid) {
    return { ok: false, reason: `pin file owned by uid ${stat.uid}, expected ${myUid}` };
  }
  const mode = stat.mode & 0o777;
  if (mode & PIN_INSECURE_MODE_MASK) {
    return { ok: false, reason: `pin file mode 0${mode.toString(8)} is writable by group/other` };
  }
  return { ok: true };
}

/** Trusted pin read: null when absent, untrusted, or empty. */
export function readTrustedPin(filePath: string, env: ResolutionEnv = {}): string | null {
  const trust = checkPinTrust(filePath, env);
  if (!trust.ok) {
    // A real refusal (foreign owner / group-other-writable) is warned
    // unconditionally: a silently ignored pin is indistinguishable from no
    // pin. A missing file is the normal no-pin state and stays silent.
    if (trust.reason !== 'pin file missing') {
      warn(`ignoring runtime pin (${trust.reason}): ${filePath}`);
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

/**
 * Layered pin lookup. `walk-up` is a pure filesystem walk — not a git-vault
 * resolution — so a worktree-local pin is honored even though the worktree's
 * vault resolves to the main repo.
 */
export function readLayeredPin(
  scope: PinScope,
  env: ResolutionEnv = {},
): { pin: string; pinPath: string; pinScope: 'project' | 'machine' } | null {
  if (scope.kind === 'walk-up') {
    let dir = path.resolve(scope.from);
    while (true) {
      const candidate = path.join(dir, '.myco', MACHINE_RUNTIME_COMMAND_FILENAME);
      const pin = readTrustedPin(candidate, env);
      if (pin) return { pin, pinPath: candidate, pinScope: 'project' };
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  const home = env.mycoHome ?? resolveMycoHome();
  const machinePath = path.join(home, MACHINE_RUNTIME_COMMAND_FILENAME);
  const pin = readTrustedPin(machinePath, env);
  return pin ? { pin, pinPath: machinePath, pinScope: 'machine' } : null;
}

/** A file that exists and (on POSIX) is executable. Mode-0644 binaries fail. */
export function isRunnableBinary(candidate: string, env: ResolutionEnv = {}): boolean {
  const platform = env.platform ?? process.platform;
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Gather the resolution facts without applying any policy. */
export function gatherFacts(scope: PinScope, env: ResolutionEnv = {}): ResolutionFacts {
  const home = env.mycoHome ?? resolveMycoHome();
  const platform = env.platform ?? process.platform;
  const localAppData = 'localAppData' in env ? env.localAppData : process.env.LOCALAPPDATA;
  const managedBinary = managedBinaryPath(home, platform, localAppData);
  const layered = readLayeredPin(scope, env);
  let pinRefusal: { pinPath: string; reason: string } | null = null;
  if (!layered) {
    const machinePinPath = path.join(home, MACHINE_RUNTIME_COMMAND_FILENAME);
    const trust = checkPinTrust(machinePinPath, env);
    if (!trust.ok && trust.reason !== 'pin file missing') {
      pinRefusal = { pinPath: machinePinPath, reason: trust.reason };
    }
  }
  return {
    binDir: managedBinDir(home, platform, localAppData),
    managedBinary,
    managedExists: fs.existsSync(managedBinary),
    managedRunnable: isRunnableBinary(managedBinary, env),
    pin: layered?.pin ?? null,
    pinPath: layered?.pinPath ?? null,
    pinScope: layered?.pinScope ?? null,
    pinRefusal,
  };
}

/** The bare command name for `instruction`'s last resort. */
export function bareCommandName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'myco.exe' : 'myco';
}

/** Resolve the binary for a call site's policy. See {@link ResolutionPolicy}. */
export function resolveBinary(
  policy: ResolutionPolicy,
  scope: PinScope = { kind: 'machine' },
  env: ResolutionEnv = {},
): ResolvedBinary {
  const platform = env.platform ?? process.platform;
  const execPath = env.execPath ?? process.execPath;
  const facts = gatherFacts(scope, env);

  const done = (path_: string, source: ResolvedBinary['source'], args: string[] = []): ResolvedBinary => {
    trace(env, `${policy}: ${source} -> ${path_}`);
    return { path: path_, source, args, facts };
  };

  switch (policy) {
    case 'self-exec': {
      if (facts.pin) return done(facts.pin, 'pin');
      if (facts.managedRunnable) return done(facts.managedBinary, 'managed');
      return done(execPath, 'last-resort');
    }
    case 'self-exec-entry': {
      const argv1 = 'argv1' in env ? env.argv1 : process.argv[1];
      const entry = !argv1 || argv1.startsWith('/$bunfs/') || argv1.startsWith('B:\\~BUN\\') ? null : argv1;
      return done(execPath, 'last-resort', entry === null ? [] : [entry]);
    }
    case 'home-scoped-managed': {
      const home = env.mycoHome ?? resolveMycoHome();
      if (isDefaultMycoHome(home) && facts.managedRunnable) {
        return done(facts.managedBinary, 'managed');
      }
      return done(execPath, 'last-resort');
    }
    case 'managed-destination':
      return done(facts.managedBinary, 'managed');
    case 'instruction': {
      if (facts.pin) return done(facts.pin, 'pin');
      if (facts.managedRunnable) return done(facts.managedBinary, 'managed');
      return done(bareCommandName(platform), 'last-resort');
    }
  }
}

function trace(env: ResolutionEnv, message: string): void {
  if (process.env.MYCO_DEBUG_REDIRECT !== '1') return;
  warn(`resolve: ${message}`);
}

function warn(message: string): void {
  try {
    process.stderr.write(`[myco] ${message}\n`);
  } catch {
    // stderr unavailable
  }
}
