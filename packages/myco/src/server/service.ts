/**
 * Per-user services: a Myco process the platform starts when its owner logs in.
 *
 * Two services use this, each described by a {@link ServiceUnit}: the native
 * Deployment (`server run`) and a member's worker (`worker --server <url>`).
 * One renderer per platform, one lifecycle, one status probe, so the properties
 * below hold for every unit rather than for whichever one remembered them.
 *
 * Three properties every unit carries, and each is a way a service fails
 * silently when it is missing:
 *
 *   - **Output goes to files.** A service whose stdout is discarded cannot be
 *     supported: the one report of a refused start is the line it wrote.
 *   - **`PATH` is declared.** A login agent inherits almost nothing of a shell's
 *     environment, and a worker looks for harnesses on `PATH`.
 *   - **The network is waited for, and failure restarts.** A process that
 *     starts before the network is up fails its first work and stays down.
 *
 * The binary path is absolute and unquoted, matching the hook installer's rule
 * (`symbionts/installer.ts`): a path carrying whitespace breaks the hosts that
 * split on it, so it is refused at install rather than found at first boot.
 *
 * Every platform command runs through a {@link ServiceRunner}, so a caller can
 * exercise install and uninstall without handing a unit to the real platform.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

/** What a service is: the names the platform records it under, what it runs, and where it writes. */
export interface ServiceUnit {
  /** The launchd label. */
  label: string;
  /** The systemd unit and Task Scheduler task name. */
  unitName: string;
  description: string;
  /** The arguments the binary is started with. */
  args: readonly string[];
  /** The log file stem: `<logName>.log` and `<logName>.error.log`. */
  logName: string;
  /** Seconds the platform waits before starting a unit that exited again. */
  restartDelaySeconds: number;
}

/** The native Deployment. */
export const SERVER_UNIT: ServiceUnit = {
  label: 'co.goondocks.myco-server',
  unitName: 'myco-server',
  description: 'Myco Deployment',
  args: ['server', 'run', '--target', 'local'],
  logName: 'server',
  restartDelaySeconds: 5,
};

/** The directories a unit is written into, and where it writes its output. */
export interface ServicePaths {
  /** The unit file this platform reads. */
  unitFile: string;
  logDir: string;
  outLog: string;
  errLog: string;
}

export interface ServiceSpec {
  unit: ServiceUnit;
  /** Absolute path to the binary the unit runs. */
  binaryPath: string;
  /** The user's home directory; unit files are rooted here. */
  home: string;
  /** `PATH` the service runs with. */
  pathEnv: string;
  /** Where both output streams are written. */
  logDir: string;
  /** Environment the service runs with beyond `PATH` and `HOME`. */
  env: Readonly<Record<string, string>>;
}

export class ServicePathUnsupported extends Error {}
export class ServicePlatformUnsupported extends Error {}

/**
 * A binary path a unit can name without quoting.
 *
 * Whitespace is refused rather than quoted: the same path is read by hosts that
 * split on whitespace and by hosts that take it whole, and no single spelling
 * satisfies both.
 */
export function assertUnquotablePath(binaryPath: string): void {
  if (!path.isAbsolute(binaryPath)) {
    throw new ServicePathUnsupported(`the service runs an absolute path, and ${JSON.stringify(binaryPath)} is not one`);
  }
  if (/\s/.test(binaryPath)) {
    throw new ServicePathUnsupported(
      `the service cannot run a binary whose path contains whitespace (${binaryPath}). Install Myco somewhere without spaces in the path.`,
    );
  }
}

/** The names the installed binary goes by; a unit naming anything else runs a program that does not take these arguments. */
const BINARY_NAMES = new Set(['myco', 'myco.exe']);

/**
 * The service runs the installed binary and nothing else.
 *
 * A source checkout runs the CLI through a runtime, and the running executable
 * is then that runtime rather than Myco. A unit written from it would name a
 * program that answers the unit's arguments with a usage error at every login.
 */
export function assertInstalledBinary(binaryPath: string): void {
  assertUnquotablePath(binaryPath);
  if (!BINARY_NAMES.has(path.basename(binaryPath))) {
    throw new ServicePathUnsupported(
      `the service runs the installed myco binary, and this process is ${binaryPath}. Install Myco and run the install from it.`,
    );
  }
}

const DEFAULT_PATH_ENV = '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin';

/** The `PATH` a unit declares: the user's own bin, the binary's directory, any `extra` directories, then the platform's. */
export function servicePathEnv(binaryPath: string, home: string, platform: NodeJS.Platform, extra: readonly string[] = []): string {
  const separator = platform === 'win32' ? ';' : ':';
  const inherited = platform === 'win32' ? '%PATH%' : DEFAULT_PATH_ENV;
  const dirs = [path.join(home, '.local', 'bin'), path.dirname(binaryPath), ...extra];
  return [...new Set(dirs), inherited].join(separator);
}

/** The native Deployment's service, run by `binaryPath` for the user at `home`. */
export function defaultSpec(binaryPath: string, home = homedir(), platform = process.platform): ServiceSpec {
  return {
    unit: SERVER_UNIT,
    binaryPath,
    home,
    pathEnv: servicePathEnv(binaryPath, home, platform),
    logDir: path.join(home, '.myco', 'logs'),
    env: {},
  };
}

export function servicePaths(spec: ServiceSpec, platform = process.platform): ServicePaths {
  const base = {
    logDir: spec.logDir,
    outLog: path.join(spec.logDir, `${spec.unit.logName}.log`),
    errLog: path.join(spec.logDir, `${spec.unit.logName}.error.log`),
  };
  if (platform === 'darwin') {
    return { ...base, unitFile: path.join(spec.home, 'Library', 'LaunchAgents', `${spec.unit.label}.plist`) };
  }
  if (platform === 'linux') {
    return { ...base, unitFile: path.join(spec.home, '.config', 'systemd', 'user', `${spec.unit.unitName}.service`) };
  }
  if (platform === 'win32') {
    return { ...base, unitFile: path.join(spec.home, '.myco', `${spec.unit.unitName}.task.xml`) };
  }
  throw new ServicePlatformUnsupported(`no per-user service is defined for ${platform}`);
}

const xmlEscape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Every variable a unit sets, in the order it sets them. */
function environmentOf(spec: ServiceSpec): Array<[string, string]> {
  return [['PATH', spec.pathEnv], ['HOME', spec.home], ...Object.entries(spec.env)];
}

/** launchd: run at login, keep it alive, and write both streams to files. */
export function renderLaunchdPlist(spec: ServiceSpec, paths: ServicePaths): string {
  assertUnquotablePath(spec.binaryPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xmlEscape(spec.unit.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(spec.binaryPath)}</string>
${spec.unit.args.map((arg) => `    <string>${xmlEscape(arg)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
    <key>NetworkState</key><true/>
  </dict>
  <key>ThrottleInterval</key><integer>${spec.unit.restartDelaySeconds}</integer>
  <key>EnvironmentVariables</key>
  <dict>
${environmentOf(spec).map(([key, value]) => `    <key>${xmlEscape(key)}</key><string>${xmlEscape(value)}</string>`).join('\n')}
  </dict>
  <key>StandardOutPath</key><string>${xmlEscape(paths.outLog)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(paths.errLog)}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

/** systemd --user: run after the network is up, restart on failure, append both streams. */
export function renderSystemdUnit(spec: ServiceSpec, paths: ServicePaths): string {
  assertUnquotablePath(spec.binaryPath);
  return `[Unit]
Description=${spec.unit.description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${spec.binaryPath} ${spec.unit.args.join(' ')}
${environmentOf(spec).map(([key, value]) => `Environment=${key}=${value}`).join('\n')}
Restart=on-failure
RestartSec=${spec.unit.restartDelaySeconds}
StandardOutput=append:${paths.outLog}
StandardError=append:${paths.errLog}

[Install]
WantedBy=default.target
`;
}

/**
 * Task Scheduler: at logon, restart on failure, both streams appended to the
 * same files the other platforms write.
 *
 * Task Scheduler redirects nothing of its own, so the action runs through the
 * command processor, which is what supplies the append operators. The binary
 * path carries no whitespace (`assertUnquotablePath`), so the inner command
 * needs no quoting that `cmd /c` would then have to unwrap. Task Scheduler
 * restarts no sooner than a minute, whatever the unit asks for.
 */
export function renderWindowsTask(spec: ServiceSpec, paths: ServicePaths): string {
  assertUnquotablePath(spec.binaryPath);
  const settings = environmentOf(spec).filter(([key]) => key !== 'HOME').map(([key, value]) => `set "${key}=${value}" && `).join('');
  const action = `${settings}${spec.binaryPath} ${spec.unit.args.join(' ')} >> ${paths.outLog} 2>> ${paths.errLog}`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlEscape(spec.unit.description)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <NetworkSettings><Id></Id></NetworkSettings>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>/c "${xmlEscape(action)}"</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function renderUnit(spec: ServiceSpec, paths: ServicePaths, platform = process.platform): string {
  if (platform === 'darwin') return renderLaunchdPlist(spec, paths);
  if (platform === 'linux') return renderSystemdUnit(spec, paths);
  if (platform === 'win32') return renderWindowsTask(spec, paths);
  throw new ServicePlatformUnsupported(`no per-user service is defined for ${platform}`);
}

/** What one platform command answered: its exit status, or the reason it could not be run at all. */
export interface CommandResult {
  status: number | null;
  error?: Error;
}

/** Runs one platform command. The default is the real platform; a test passes its own. */
export type ServiceRunner = (command: string, args: readonly string[]) => CommandResult;

export const platformRunner: ServiceRunner = (command, args) => {
  const result = spawnSync(command, [...args], { stdio: 'ignore' });
  return { status: result.status, ...(result.error === undefined ? {} : { error: result.error }) };
};

/** How a unit is loaded and unloaded, per platform. */
function lifecycleCommands(unit: ServiceUnit, paths: ServicePaths, platform: NodeJS.Platform): { load: string[][]; unload: string[][] } {
  if (platform === 'darwin') {
    return {
      load: [['launchctl', 'unload', paths.unitFile], ['launchctl', 'load', '-w', paths.unitFile]],
      unload: [['launchctl', 'unload', '-w', paths.unitFile]],
    };
  }
  if (platform === 'linux') {
    return {
      load: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', `${unit.unitName}.service`]],
      unload: [['systemctl', '--user', 'disable', '--now', `${unit.unitName}.service`]],
    };
  }
  return {
    load: [['schtasks', '/Create', '/TN', unit.unitName, '/XML', paths.unitFile, '/F'], ['schtasks', '/Run', '/TN', unit.unitName]],
    unload: [['schtasks', '/End', '/TN', unit.unitName], ['schtasks', '/Delete', '/TN', unit.unitName, '/F']],
  };
}

export interface ServiceOutcome {
  unitFile: string;
  /** Whether the platform accepted the unit; a written unit that did not load is reported, never assumed. */
  loaded: boolean;
  /** Whether this call wrote a unit different from the one already there. */
  changed: boolean;
  detail?: string;
}

export interface ServiceOptions {
  platform?: NodeJS.Platform;
  runner?: ServiceRunner;
}

/**
 * Write the unit and hand it to the platform.
 *
 * Idempotent: a unit already written with the same content, and already held
 * by the platform, is left running rather than restarted, so installing twice
 * never interrupts the process the first install started.
 */
export function installService(spec: ServiceSpec, options: ServiceOptions = {}): ServiceOutcome {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? platformRunner;
  assertInstalledBinary(spec.binaryPath);
  const paths = servicePaths(spec, platform);
  const unit = renderUnit(spec, paths, platform);
  const current = existsSync(paths.unitFile) ? readFileSync(paths.unitFile, 'utf8') : null;
  const changed = current !== unit;
  if (!changed) {
    const held = statusOfService(spec, options);
    if (held.loaded) return { unitFile: paths.unitFile, loaded: true, changed: false };
  }
  mkdirSync(path.dirname(paths.unitFile), { recursive: true });
  mkdirSync(paths.logDir, { recursive: true });
  writeFileSync(paths.unitFile, unit, { mode: 0o600 });

  const { load } = lifecycleCommands(spec.unit, paths, platform);
  for (const [command, ...args] of load) {
    const result = runner(command!, args);
    // The first darwin command unloads a unit that may not be loaded, and a
    // refusal there is the expected answer rather than a failure.
    if (result.error !== undefined && command !== 'launchctl') {
      return { unitFile: paths.unitFile, loaded: false, changed, detail: `${command} could not be run: ${result.error.message}` };
    }
  }
  const verify = statusOfService(spec, options);
  return { unitFile: paths.unitFile, loaded: verify.loaded, changed, ...(verify.detail === undefined ? {} : { detail: verify.detail }) };
}

/** Stop the running service without removing its unit, for an operator acting on the volume underneath it. */
export function stopService(spec: ServiceSpec, options: ServiceOptions = {}): void {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? platformRunner;
  const paths = servicePaths(spec, platform);
  if (!existsSync(paths.unitFile)) return;
  for (const [command, ...args] of lifecycleCommands(spec.unit, paths, platform).unload) runner(command!, args);
}

/** Start a service whose unit is already written. */
export function startService(spec: ServiceSpec, options: ServiceOptions = {}): ServiceOutcome {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? platformRunner;
  const paths = servicePaths(spec, platform);
  if (!existsSync(paths.unitFile)) return { unitFile: paths.unitFile, loaded: false, changed: false, detail: 'no service unit is installed' };
  for (const [command, ...args] of lifecycleCommands(spec.unit, paths, platform).load) runner(command!, args);
  const verify = statusOfService(spec, options);
  return { unitFile: paths.unitFile, loaded: verify.loaded, changed: false, ...(verify.detail === undefined ? {} : { detail: verify.detail }) };
}

/** Stop the service and remove its unit. Removing a unit that is not there is not an error. */
export function uninstallService(spec: ServiceSpec, options: ServiceOptions = {}): { unitFile: string; removed: boolean } {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? platformRunner;
  const paths = servicePaths(spec, platform);
  const removed = existsSync(paths.unitFile);
  if (removed) {
    for (const [command, ...args] of lifecycleCommands(spec.unit, paths, platform).unload) runner(command!, args);
  }
  rmSync(paths.unitFile, { force: true });
  return { unitFile: paths.unitFile, removed };
}

/** Whether the platform is holding the service, read from the platform rather than from the unit file. */
export function statusOfService(spec: ServiceSpec, options: ServiceOptions = {}): { installed: boolean; loaded: boolean; detail?: string } {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? platformRunner;
  const paths = servicePaths(spec, platform);
  if (!existsSync(paths.unitFile)) return { installed: false, loaded: false, detail: 'no service unit is installed' };
  const probe = platform === 'darwin'
    ? ['launchctl', 'list', spec.unit.label]
    : platform === 'linux'
      ? ['systemctl', '--user', 'is-enabled', `${spec.unit.unitName}.service`]
      : ['schtasks', '/Query', '/TN', spec.unit.unitName];
  const result = runner(probe[0]!, probe.slice(1));
  if (result.error !== undefined) return { installed: true, loaded: false, detail: `${probe[0]} could not be run` };
  return result.status === 0
    ? { installed: true, loaded: true }
    : { installed: true, loaded: false, detail: 'the unit is installed and the platform is not running it' };
}
