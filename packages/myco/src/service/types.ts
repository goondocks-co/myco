/** Which daemon variant the service hosts. */
export type ServiceVariant = 'prod' | 'dev';

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
}

/** Observed state of an installed service. */
export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  pid: number | null;
  /** Most recent exit code as reported by the platform supervisor. */
  lastExitCode: number | null;
  /** Path to the installed unit/plist file, or null if not installed. */
  unitPath: string | null;
}

/** Platform-agnostic service lifecycle operations. */
export interface ServiceManager {
  /** True if this platform implementation is functional. */
  readonly supported: boolean;
  /** Human-readable platform name (e.g. "launchd", "systemd --user"). */
  readonly platformName: string;
  /** Cheap existence check — file-system level, no shell-out. */
  isInstalled(label: string): Promise<boolean>;
  install(spec: ServiceSpec): Promise<void>;
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
}
