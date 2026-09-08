/**
 * The Deployment as a per-user service.
 *
 * One unit per platform, each running `<binary> server run` when the person
 * logs in and restarting it when it exits. A laptop's Deployment is expected to
 * be there whenever its owner is, and to come back after a reboot, a crash, or
 * a binary that replaced itself.
 *
 * Three properties every unit carries, and each is a way a service fails
 * silently when it is missing:
 *
 *   - **Output goes to files.** A service whose stdout is discarded cannot be
 *     supported: the one report of a refused start is the line it wrote.
 *   - **`PATH` is declared.** A login agent inherits almost nothing of a shell's
 *     environment, and the worker this process runs looks for harnesses on
 *     `PATH`.
 *   - **The network is waited for, and failure restarts.** A Deployment that
 *     starts before the network is up fails its first work and stays down.
 *
 * The binary path is absolute and unquoted, matching the hook installer's rule
 * (`symbionts/installer.ts`): a path carrying whitespace breaks the hosts that
 * split on it, so it is refused at install rather than found at first boot.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

/** What the service is called wherever the platform records one. */
export const SERVICE_LABEL = 'co.goondocks.myco-server';
export const SERVICE_UNIT_NAME = 'myco-server';

/** The directories a unit is written into, and where it writes its output. */
export interface ServicePaths {
  /** The unit file this platform reads. */
  unitFile: string;
  logDir: string;
  outLog: string;
  errLog: string;
}

export interface ServiceSpec {
  /** Absolute path to the binary the unit runs. */
  binaryPath: string;
  /** The home directory the unit's paths are rooted at. */
  home: string;
  /** `PATH` the service runs with. */
  pathEnv: string;
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
 * program that answers `server run` with a usage error at every login.
 */
export function assertInstalledBinary(binaryPath: string): void {
  assertUnquotablePath(binaryPath);
  if (!BINARY_NAMES.has(path.basename(binaryPath))) {
    throw new ServicePathUnsupported(
      `the service runs the installed myco binary, and this process is ${binaryPath}. Install Myco and run \`myco server install\` from it.`,
    );
  }
}

const DEFAULT_PATH_ENV = '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin';

export function defaultSpec(binaryPath: string, home = homedir(), platform = process.platform): ServiceSpec {
  const separator = platform === 'win32' ? ';' : ':';
  const inherited = platform === 'win32' ? '%PATH%' : DEFAULT_PATH_ENV;
  return {
    binaryPath,
    home,
    pathEnv: [path.join(home, '.local', 'bin'), path.dirname(binaryPath), inherited].join(separator),
  };
}

export function servicePaths(spec: ServiceSpec, platform = process.platform): ServicePaths {
  const logDir = path.join(spec.home, '.myco', 'logs');
  const base = {
    logDir,
    outLog: path.join(logDir, 'server.log'),
    errLog: path.join(logDir, 'server.error.log'),
  };
  if (platform === 'darwin') {
    return { ...base, unitFile: path.join(spec.home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`) };
  }
  if (platform === 'linux') {
    return { ...base, unitFile: path.join(spec.home, '.config', 'systemd', 'user', `${SERVICE_UNIT_NAME}.service`) };
  }
  if (platform === 'win32') {
    return { ...base, unitFile: path.join(spec.home, '.myco', `${SERVICE_UNIT_NAME}.task.xml`) };
  }
  throw new ServicePlatformUnsupported(`no per-user service is defined for ${platform}`);
}

const xmlEscape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** launchd: run at login, keep it alive, and write both streams to files. */
export function renderLaunchdPlist(spec: ServiceSpec, paths: ServicePaths): string {
  assertUnquotablePath(spec.binaryPath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(spec.binaryPath)}</string>
    <string>server</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
    <key>NetworkState</key><true/>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEscape(spec.pathEnv)}</string>
    <key>HOME</key><string>${xmlEscape(spec.home)}</string>
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
Description=Myco Deployment
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${spec.binaryPath} server run
Environment=PATH=${spec.pathEnv}
Environment=HOME=${spec.home}
Restart=on-failure
RestartSec=5
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
 * needs no quoting that `cmd /c` would then have to unwrap.
 */
export function renderWindowsTask(spec: ServiceSpec, paths: ServicePaths): string {
  assertUnquotablePath(spec.binaryPath);
  const action = `set "PATH=${spec.pathEnv}" && ${spec.binaryPath} server run >> ${paths.outLog} 2>> ${paths.errLog}`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Myco Deployment</Description>
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

/** How a unit is loaded and unloaded, per platform. */
function lifecycleCommands(paths: ServicePaths, platform: NodeJS.Platform): { load: string[][]; unload: string[][] } {
  if (platform === 'darwin') {
    return {
      load: [['launchctl', 'unload', paths.unitFile], ['launchctl', 'load', '-w', paths.unitFile]],
      unload: [['launchctl', 'unload', '-w', paths.unitFile]],
    };
  }
  if (platform === 'linux') {
    return {
      load: [['systemctl', '--user', 'daemon-reload'], ['systemctl', '--user', 'enable', '--now', `${SERVICE_UNIT_NAME}.service`]],
      unload: [['systemctl', '--user', 'disable', '--now', `${SERVICE_UNIT_NAME}.service`]],
    };
  }
  return {
    load: [['schtasks', '/Create', '/TN', SERVICE_UNIT_NAME, '/XML', paths.unitFile, '/F']],
    unload: [['schtasks', '/Delete', '/TN', SERVICE_UNIT_NAME, '/F']],
  };
}

export interface ServiceOutcome {
  unitFile: string;
  /** Whether the platform accepted the unit; a written unit that did not load is reported, never assumed. */
  loaded: boolean;
  detail?: string;
}

/** Write the unit and hand it to the platform. */
export function installService(spec: ServiceSpec, platform = process.platform): ServiceOutcome {
  assertInstalledBinary(spec.binaryPath);
  const paths = servicePaths(spec, platform);
  const unit = renderUnit(spec, paths, platform);
  mkdirSync(path.dirname(paths.unitFile), { recursive: true });
  mkdirSync(paths.logDir, { recursive: true });
  writeFileSync(paths.unitFile, unit, { mode: 0o600 });

  const { load } = lifecycleCommands(paths, platform);
  for (const [command, ...args] of load) {
    const result = spawnSync(command!, args, { stdio: 'ignore' });
    // The first darwin command unloads a unit that may not be loaded, and a
    // refusal there is the expected answer rather than a failure.
    if (result.error !== undefined && command !== 'launchctl') {
      return { unitFile: paths.unitFile, loaded: false, detail: `${command} could not be run: ${result.error.message}` };
    }
  }
  const verify = statusOfService(paths, platform);
  return { unitFile: paths.unitFile, loaded: verify.loaded, ...(verify.detail === undefined ? {} : { detail: verify.detail }) };
}

/** Stop the running service without removing its unit, for an operator acting on the volume underneath it. */
export function stopService(spec: ServiceSpec, platform = process.platform): void {
  const paths = servicePaths(spec, platform);
  if (!existsSync(paths.unitFile)) return;
  for (const [command, ...args] of lifecycleCommands(paths, platform).unload) {
    spawnSync(command!, args, { stdio: 'ignore' });
  }
}

/** Start a service whose unit is already written. */
export function startService(spec: ServiceSpec, platform = process.platform): ServiceOutcome {
  const paths = servicePaths(spec, platform);
  if (!existsSync(paths.unitFile)) return { unitFile: paths.unitFile, loaded: false, detail: 'no service unit is installed' };
  for (const [command, ...args] of lifecycleCommands(paths, platform).load) {
    spawnSync(command!, args, { stdio: 'ignore' });
  }
  const verify = statusOfService(paths, platform);
  return { unitFile: paths.unitFile, loaded: verify.loaded, ...(verify.detail === undefined ? {} : { detail: verify.detail }) };
}

/** Stop the service and remove its unit. */
export function uninstallService(spec: ServiceSpec, platform = process.platform): { unitFile: string; removed: boolean } {
  const paths = servicePaths(spec, platform);
  for (const [command, ...args] of lifecycleCommands(paths, platform).unload) {
    spawnSync(command!, args, { stdio: 'ignore' });
  }
  const removed = existsSync(paths.unitFile);
  rmSync(paths.unitFile, { force: true });
  return { unitFile: paths.unitFile, removed };
}

/** Whether the platform is holding the service, read from the platform rather than from the unit file. */
export function statusOfService(paths: ServicePaths, platform = process.platform): { loaded: boolean; detail?: string } {
  if (!existsSync(paths.unitFile)) return { loaded: false, detail: 'no service unit is installed' };
  const probe = platform === 'darwin'
    ? ['launchctl', 'list', SERVICE_LABEL]
    : platform === 'linux'
      ? ['systemctl', '--user', 'is-enabled', `${SERVICE_UNIT_NAME}.service`]
      : ['schtasks', '/Query', '/TN', SERVICE_UNIT_NAME];
  const result = spawnSync(probe[0]!, probe.slice(1), { stdio: 'ignore' });
  if (result.error !== undefined) return { loaded: false, detail: `${probe[0]} could not be run` };
  return result.status === 0 ? { loaded: true } : { loaded: false, detail: 'the unit is installed and the platform is not running it' };
}
