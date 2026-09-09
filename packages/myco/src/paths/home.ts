/**
 * Myco home resolution — the machine-scoped state root and the handful of
 * paths that hang directly off it.
 *
 * A leaf: depends on nothing but Node built-ins and the pin trust check, so a
 * capture hook (and the member seam) can resolve the home without pulling
 * Grove, vault, or daemon code into its import closure. `grove/paths.ts`
 * re-exports everything here for the rest of the binary.
 */
import os from 'node:os';
import path from 'node:path';
import { readTrustedPin, type PinRefusalReporter, type PinTrustOptions } from './pin-trust.js';

export const MYCO_HOME_ENV = 'MYCO_HOME';

/**
 * Filename of the home pin — a plaintext, single-line home path, in a
 * project's `.myco/` or in the default `~/.myco/`, written beside a
 * `runtime.command` pin when there is one.
 */
export const RUNTIME_HOME_FILENAME = 'runtime.home';

/** The `.myco` directory: a project's, and the default home under `~`. */
const MYCO_DIRNAME = '.myco';

export interface MycoHomeOptions extends PinTrustOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /**
   * The directory this invocation belongs to — the hook payload's `cwd` for a
   * hook, `process.cwd()` for a CLI call. The project pin is looked for by
   * walking up from here, and ONLY when a caller names it: a resolution with no
   * directory (the daemon, a Grove read, anything serving another project) is
   * not "about" a directory, and must not inherit a home from wherever the
   * process happens to be standing.
   */
  cwd?: string;
  /** Where an untrusted pin is reported. Defaults to one deduplicated stderr line. */
  reportPinRefusal?: PinRefusalReporter;
}

/** Which rule produced a home, for the caller that wants to say so. */
export type MycoHomeSource = 'env' | 'project-pin' | 'machine-pin' | 'default';

export interface ResolvedMycoHome {
  home: string;
  source: MycoHomeSource;
  /** The pin file that produced the home; absent for `env` and `default`. */
  pinPath?: string;
}

/**
 * This machine's Myco home, under one precedence order for every entry point —
 * hooks, `myco mcp`, `myco member`, `myco import` and the CLI:
 *
 *   1. an explicit `MYCO_HOME` in the environment,
 *   2. a trusted `.myco/runtime.home` pin, found by walking up from `cwd`
 *      (only when the caller names a directory — see {@link MycoHomeOptions}),
 *   3. the machine pin at `~/.myco/runtime.home`,
 *   4. `~/.myco`.
 *
 * The pin is what a project joined to a non-default home carries on disk.
 * Without it a hook launched by a GUI agent — which inherits no `MYCO_HOME`
 * from any shell — reads a different home than the one holding the membership,
 * finds no registry entry, and captures nothing while exiting 0.
 *
 * A pin is honoured only when it passes the trust check the CLI shim applies
 * (`paths/pin-trust.ts`): a group/other-writable, foreign-owned or symlinked
 * pin is refused, as is one whose value is not an absolute path, because a pin
 * decides where a credential is read from. A refusal names its reason on
 * stderr, once per process, and is recorded nowhere else — the home it falls
 * back to is what everything downstream then reports.
 */
export function resolveMycoHome(options: MycoHomeOptions = {}): string {
  return resolveMycoHomeWithSource(options).home;
}

/** {@link resolveMycoHome} with the rule that produced the answer. */
export function resolveMycoHomeWithSource(options: MycoHomeOptions = {}): ResolvedMycoHome {
  const env = options.env ?? process.env;
  const configured = env[MYCO_HOME_ENV]?.trim();
  if (configured) return { home: path.resolve(expandHome(configured, options.homeDir)), source: 'env' };

  const project = findProjectHomePin(options);
  if (project) return { home: project.home, source: 'project-pin', pinPath: project.pinPath };

  const machine = readMachineHomePin(options);
  if (machine) return { home: machine.home, source: 'machine-pin', pinPath: machine.pinPath };

  return { home: defaultMycoHome(options.homeDir), source: 'default' };
}

/** `~/.myco` — the home every machine has when nothing redirects it. */
export function defaultMycoHome(homeDir?: string): string {
  return path.join(homeDir ?? resolveHomeDir(), MYCO_DIRNAME);
}

/**
 * The first trusted `<dir>/.myco/runtime.home` at or above the walk start.
 *
 * A pure filesystem walk, never a git-vault resolution: a worktree's vault
 * resolves to the MAIN repo root, which would skip a worktree-local pin and
 * route that worktree's capture at the wrong home.
 */
export function findProjectHomePin(options: MycoHomeOptions = {}): { home: string; pinPath: string } | null {
  if (options.cwd === undefined) return null;
  let dir = path.resolve(options.cwd);
  while (true) {
    const pinPath = path.join(dir, MYCO_DIRNAME, RUNTIME_HOME_FILENAME);
    const home = readHomePin(pinPath, options);
    if (home) return { home, pinPath };
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The pin path for the machine scope: `<MYCO_HOME or ~/.myco>/runtime.home`. */
export function machineHomePinPath(options: MycoHomeOptions = {}): string {
  const env = options.env ?? process.env;
  const configured = env[MYCO_HOME_ENV]?.trim();
  const base = configured
    ? path.resolve(expandHome(configured, options.homeDir))
    : defaultMycoHome(options.homeDir);
  return path.join(base, RUNTIME_HOME_FILENAME);
}

/** The machine-scope home pin, or null when it is absent or untrusted. */
export function readMachineHomePin(options: MycoHomeOptions = {}): { home: string; pinPath: string } | null {
  const pinPath = machineHomePinPath(options);
  const home = readHomePin(pinPath, options);
  return home ? { home, pinPath } : null;
}

/**
 * One pin file's home value, trust-checked and `~`-expanded, or null.
 *
 * The value must name an absolute path (or a `~`-rooted one). A relative value
 * would resolve against whatever directory the process is standing in, so a
 * `runtime.home` committed into a repository — `vendor/home`, say — would send
 * the reader's credentials and the binary it execs into a directory the
 * repository controls.
 */
export function readHomePin(pinPath: string, options: MycoHomeOptions = {}): string | null {
  const report = options.reportPinRefusal ?? reportPinRefusalOnce;
  const raw = readTrustedPin(pinPath, options, report);
  if (raw === null) return null;
  const expanded = expandHome(raw, options.homeDir);
  if (!path.isAbsolute(expanded)) {
    report(pinPath, `home "${raw}" is not an absolute path`);
    return null;
  }
  return path.resolve(expanded);
}

/**
 * One stderr line per refused pin file per process. The home is resolved on
 * nearly every path through the binary, so an unconditional line would repeat
 * a refusal hundreds of times in one hook run and drown the reason it names.
 */
const refusalsReported = new Set<string>();

function reportPinRefusalOnce(pinPath: string, reason: string): void {
  const key = `${pinPath} ${reason}`;
  if (refusalsReported.has(key)) return;
  refusalsReported.add(key);
  try {
    process.stderr.write(`[myco] ignoring runtime home pin (${reason}): ${pinPath}\n`);
  } catch {
    // stderr unavailable
  }
}

/** Test seam: forget which refusals have already been reported this process. */
export function _resetPinRefusalReports(): void {
  refusalsReported.clear();
}

/**
 * Resolve the canonical path for the cached machine identity. One file
 * per machine, shared across every Grove and every project — the value
 * was previously cached per-project at `<projectVaultDir>/machine_id`,
 * which produced one identity per vault and forced every team-sync /
 * backup-dedup consumer to re-resolve when crossing projects.
 *
 * Post-global-install: `~/.myco/machine_id` is the single source. The
 * value moves on first read after the global-install migration runs
 * (the migration step propagates an existing project-vault value when
 * the global file is absent — see plan §5).
 */
export function resolveMachineIdPath(mycoHome = resolveMycoHome()): string {
  return path.join(mycoHome, 'machine_id');
}

/**
 * The user's home directory. Single source of truth for the entire codebase —
 * every home-relative resolver, every doctor check, every API handler that
 * needs `~` funnels through this (directly, or via {@link expandHome}).
 *
 * Reads `$HOME` first so tests that override the home dir via
 * `process.env.HOME` actually take effect — Bun's `os.homedir()` resolves
 * via `getpwuid_r()` and IGNORES `$HOME` set after process launch, which
 * would otherwise let test pollution from the developer's real `~/...`
 * leak into a tmp-dir scoped test.
 *
 * Cross-platform: `$HOME` is unset on Windows (it uses `%USERPROFILE%`), so
 * the fallback to `os.homedir()` is what resolves there. A bare
 * `process.env.HOME ?? '/'` would read off the filesystem root on Windows.
 */
export function resolveHomeDir(): string {
  return process.env.HOME ?? os.homedir();
}

/**
 * Expand a leading `~` to the user's home dir. Pure path-string helper.
 * Home resolution funnels through {@link resolveHomeDir}.
 */
export function expandHome(value: string, homeDir?: string): string {
  // Non-`~` paths are returned verbatim — no home resolution happens,
  // so the sandbox sentinel has nothing to enforce. Returning early
  // here keeps stray MYCO_SANDBOX_ROOT settings from poisoning
  // unrelated call paths that pass already-absolute values.
  const needsExpansion = value === '~' || value.startsWith(`~${path.sep}`) || value.startsWith('~/');
  if (!needsExpansion) return value;
  const home = homeDir ?? resolveHomeDir();
  assertSandboxedHome(home);
  if (value === '~') return home;
  // Accept both `~/foo` (POSIX shape, what every manifest target uses)
  // and `~\foo` on Windows.
  return path.join(home, value.slice(2));
}

/**
 * Smoke-test sandbox enforcement. When `MYCO_SANDBOX_ROOT` is set, the
 * caller is claiming "this whole process is running inside an isolated
 * filesystem root." In that case `HOME` MUST resolve to a path inside
 * the sandbox — otherwise a smoke test that sandboxed `MYCO_HOME` (the
 * launcher state dir) but forgot to set `HOME` would write to the real
 * `~/.claude/settings.json`, `~/.cursor/hooks.json`, etc. via
 * manifest globalHooksTarget paths. That escape produced 30+ orphan
 * hook entries across five real symbiont config files — the bug this
 * gate exists to prevent recurring.
 *
 * Production calls (no MYCO_SANDBOX_ROOT) are unaffected.
 */
function assertSandboxedHome(home: string): void {
  const sandboxRoot = process.env.MYCO_SANDBOX_ROOT;
  if (!sandboxRoot) return;
  const resolvedRoot = path.resolve(sandboxRoot);
  const resolvedHome = path.resolve(home);
  const sep = path.sep;
  if (resolvedHome !== resolvedRoot && !resolvedHome.startsWith(resolvedRoot + sep)) {
    throw new Error(
      `MYCO_SANDBOX_ROOT=${sandboxRoot} is set but HOME=${home} resolves outside it. ` +
      `Smoke tests must point HOME inside MYCO_SANDBOX_ROOT so manifest `
      + `globalHooksTarget paths (~/.claude/settings.json, ~/.cursor/hooks.json, ...) `
      + `stay sandboxed alongside MYCO_HOME.`,
    );
  }
}
