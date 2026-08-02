/** Which daemon variant the service hosts. */
export type ServiceVariant = 'prod' | 'dev';

/**
 * Declared service scope (Overlay Coexistence spec §13): WHEN the service
 * starts and WHO it runs as — two orthogonal facts, both explicit. Root is a
 * VALUE, never an absence. Absence of the whole object means today's
 * behavior exactly: login-scoped, invoking-user (§13.13 gate 1 pins the
 * rendered bytes byte-identical per platform).
 */
export interface ServiceScope {
  /** `login`: starts with the user session (LaunchAgent / systemctl --user /
   *  Task Scheduler logon trigger). `boot`: starts with the machine. */
  startAt: 'login' | 'boot';
  /** `invoking-user`: the service runs as the user who installed it — for
   *  `boot` on macOS that is a LaunchDaemon WITH `UserName`; on Linux the
   *  user manager plus linger. `root` exists for the overlay control-plane
   *  services (headscale) only, never the daemon, and is never config-driven. */
  runAs: 'invoking-user' | 'root';
}

/** Platform-agnostic description of a managed user service. */
export interface ServiceSpec {
  /** Unique label, e.g. `co.goondocks.myco` or `co.goondocks.myco-dev`. */
  label: string;
  variant: ServiceVariant;
  /** Absolute path to the executable. MUST exist on disk at install time. */
  executable: string;
  /** Arguments passed to the executable (after argv[0]). */
  args: string[];
  /** Working directory the service runs in. */
  workingDir: string;
  /** Environment variables exposed to the service. */
  env: Record<string, string>;
  /** Absolute path for stdout. Parent dir is created if missing. */
  stdoutPath: string;
  /** Absolute path for stderr. Parent dir is created if missing. */
  stderrPath: string;
  /** Run at user login (true) or only on-demand (false). */
  runAtLoad: boolean;
  /** Auto-restart on exit. */
  keepAlive: boolean;
  /** Minimum seconds between restart attempts. */
  throttleSeconds: number;
  /** Declared scope (§13). ABSENT means login + invoking-user with today's
   *  exact rendering; see {@link ServiceScope}. The boot backend refuses a
   *  spec whose declared object lacks an explicit `runAs` (the dangerous
   *  input is a forgotten field, §13.13 gate 3) — enforced at runtime by
   *  `resolveScope` because dynamic/cast call paths bypass the type. */
  scope?: ServiceScope;
  /** Human-readable supervisor description. Falls back to the legacy
   *  `Myco daemon (${variant})` when absent — `variant` no longer describes
   *  non-daemon services (a headscale unit is not a "Myco daemon"). */
  description?: string;
}

/** Observed state of an installed service. */
export interface ServiceStatus {
  installed: boolean;
  /** `'unknown'` when the owning domain cannot be read without privilege
   *  (boot-scope status without root). Consumers MUST NOT treat `'unknown'`
   *  as false — starting a live service or reporting "not running" on a
   *  healthy boot-scoped daemon are exactly the failure modes this guards. */
  running: boolean | 'unknown';
  pid: number | null;
  /** Most recent exit code as reported by the platform supervisor. */
  lastExitCode: number | null;
  /** Path to the installed unit/plist file, or null if not installed. */
  unitPath: string | null;
}

/** Exact command proven from the platform's installed service configuration. */
export interface InstalledServiceCommand {
  executable: string;
  args: string[];
}

/** Outcome of an `install` call. */
export interface InstallResult {
  /** Did this call write the unit file? False on an idempotent no-op
   *  (existing file content already matches the rendered spec). */
  changed: boolean;
  /** Did the call also reload the supervisor's view of the unit
   *  (e.g. launchctl bootout + bootstrap)? Reloading terminates the
   *  running service, so implementations skip it unless `opts.force`
   *  is set OR the unit is being installed for the first time. When
   *  false and `changed` is true, the new unit takes effect on the
   *  supervisor's next natural restart of the service. */
  supervisorReloaded: boolean;
}

/** Options for `install`. */
export interface InstallOptions {
  /** Force the supervisor to reload the unit even when doing so
   *  would terminate the calling process. Default false.
   *  `ensureSelfInstalledAsService` runs inside the daemon's own
   *  startup, where reloading would kill the calling daemon — that
   *  path uses the default. User-initiated commands like
   *  `myco service repair` set true. */
  force?: boolean;
}

/** Platform-agnostic service lifecycle operations. */
export interface ServiceManager {
  /** True if this platform implementation is functional. */
  readonly supported: boolean;
  /** Human-readable platform name (e.g. "launchd", "systemd --user"). */
  readonly platformName: string;
  /** Cheap existence check — file-system level, no shell-out. */
  isInstalled(label: string): Promise<boolean>;
  /** Read the exact installed executable and argv. Returns null when the
   *  platform configuration is absent, malformed, ambiguous, or cannot be
   *  proven to belong to the requested service. */
  inspect(label: string): Promise<InstalledServiceCommand | null>;
  install(spec: ServiceSpec, opts?: InstallOptions): Promise<InstallResult>;
  uninstall(label: string): Promise<void>;
  start(label: string): Promise<void>;
  stop(label: string): Promise<void>;
  /** Restart the service in place via the platform's native primitive
   *  (faster than stop+start, and more importantly atomic — no window where
   *  KeepAlive/Restart could fire and spawn an unwanted instance).
   *  Throws if the service is not installed. */
  restart(label: string): Promise<void>;
  /** The literal shell command that, when run from any detached process,
   *  restarts the service via the platform's native primitive. Used by the
   *  detached update / restart scripts that must run AFTER the daemon exits
   *  (so they cannot call back into TypeScript). The command is fully
   *  resolved at generation time — no env-var indirection. Throws on the
   *  unsupported platform. */
  restartShellCommand(label: string): string;
  status(label: string): Promise<ServiceStatus>;
  /** Optional: bootout + remove superseded units whose target binary is gone
   *  (old version dirs, removed dev-build worktrees) so the supervisor stops
   *  respawning dead units. Implemented where stale units accumulate (launchd);
   *  absent elsewhere. `keepLabel` guards the unit the caller is managing. */
  pruneSupersededUnits?(keepLabel?: string): Promise<string[]>;
}

/** The scope every spec without a declared one resolves to — today's world. */
export const DEFAULT_SERVICE_SCOPE: ServiceScope = Object.freeze({
  startAt: 'login',
  runAs: 'invoking-user',
});

export class UnsupportedServiceScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedServiceScopeError';
  }
}

/**
 * Normalize + refuse in ONE place (both backends call this). Refusals:
 * `login`+`root` is not a thing on any platform (§13.3 — unsupported
 * combinations throw, never silently degrade); a declared object missing
 * `runAs` (reachable via casts/dynamic construction) is refused because the
 * forgotten field is the dangerous input (§13.13 gate 3).
 */
export function resolveScope(spec: Pick<ServiceSpec, 'scope' | 'label'>): ServiceScope {
  const scope = spec.scope;
  if (scope === undefined) return DEFAULT_SERVICE_SCOPE;
  if (typeof (scope as { runAs?: unknown }).runAs !== 'string') {
    throw new UnsupportedServiceScopeError(
      `Service ${spec.label} declares a scope without an explicit runAs — root is a value, never an absence.`,
    );
  }
  if (scope.startAt === 'login' && scope.runAs === 'root') {
    throw new UnsupportedServiceScopeError(
      `Service ${spec.label} declares login+root, which no platform supports.`,
    );
  }
  return scope;
}
