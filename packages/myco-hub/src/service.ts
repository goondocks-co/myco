import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_PATH, DEFAULT_HOST, DEFAULT_HUB_DIR, DEFAULT_PORT, HUB_DIR, LOG_PATH, PID_PATH, ensureHubDir, loadConfig, saveConfig } from './paths.js';
import { isProcessAlive, readProcessCommandLine } from './process.js';

const SERVICE_NAME = 'co.goondocks.myco-hub';

export function installService(): void {
  ensureHubDir();
  const config = loadConfig();
  saveConfig(config);

  if (process.platform === 'darwin') {
    installLaunchAgent();
    startService();
    return;
  }
  if (process.platform === 'linux') {
    installSystemdUserService();
    startService();
    return;
  }

  throw new Error('service install is not yet supported on Windows; run `myco-hub serve` manually');
}

export function uninstallService(): void {
  stopService();
  if (process.platform === 'darwin') {
    const plist = launchAgentPath();
    runServiceCommand('launchctl', ['unload', plist], { allowNotLoaded: true });
    fs.rmSync(plist, { force: true });
    return;
  }
  if (process.platform === 'linux') {
    runServiceCommand('systemctl', ['--user', 'disable', '--now', `${SERVICE_NAME}.service`], { allowNotLoaded: true });
    fs.rmSync(systemdServicePath(), { force: true });
    runServiceCommand('systemctl', ['--user', 'daemon-reload']);
    return;
  }
}

export function startService(): void {
  if (process.platform === 'darwin') {
    runServiceCommand('launchctl', ['load', '-w', launchAgentPath()], { allowAlreadyLoaded: true });
    runServiceCommand('launchctl', ['kickstart', '-k', `gui/${process.getuid?.()}/${SERVICE_NAME}`]);
    return;
  }
  if (process.platform === 'linux') {
    runServiceCommand('systemctl', ['--user', 'daemon-reload']);
    runServiceCommand('systemctl', ['--user', 'enable', '--now', `${SERVICE_NAME}.service`]);
    return;
  }
  throw new Error('service start is not yet supported on Windows');
}

export function stopService(): void {
  const pid = readPid();
  if (pid) {
    if (isHubPid(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already stopped */ }
    } else {
      removePidFile();
    }
  }
  if (process.platform === 'darwin') {
    runServiceCommand('launchctl', ['bootout', `gui/${process.getuid?.()}/${SERVICE_NAME}`], { allowNotLoaded: true });
  } else if (process.platform === 'linux') {
    runServiceCommand('systemctl', ['--user', 'stop', `${SERVICE_NAME}.service`], { allowNotLoaded: true });
  }
}

export function serviceStatus(): { running: boolean; pid: number | null; url: string; configPath: string; logPath: string } {
  const config = loadConfig();
  const pid = readPid();
  const running = pid !== null && isHubPid(pid);
  if (pid !== null && !running) removePidFile();
  return {
    running,
    pid: running ? pid : null,
    url: `http://${config.host}:${config.port}/`,
    configPath: CONFIG_PATH,
    logPath: LOG_PATH,
  };
}

export function writePidFile(): void {
  ensureHubDir();
  fs.writeFileSync(PID_PATH, String(process.pid), 'utf-8');
  process.on('exit', () => {
    try {
      const current = Number(fs.readFileSync(PID_PATH, 'utf-8'));
      if (current === process.pid) fs.unlinkSync(PID_PATH);
    } catch {
      // ignore
    }
  });
}

function installLaunchAgent(): void {
  const plistPath = launchAgentPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  const args = serviceExecArgs();
  const env = serviceEnvironment();
  const envXml = Object.entries(env).length > 0
    ? `  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    <string>${escapeXml(value)}</string>`).join('\n')}
  </dict>
`
    : '';
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_NAME}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
${envXml}  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, plist, 'utf-8');
}

function installSystemdUserService(): void {
  const servicePath = systemdServicePath();
  fs.mkdirSync(path.dirname(servicePath), { recursive: true });
  const args = serviceExecArgs().map(systemdQuote).join(' ');
  const envLines = Object.entries(serviceEnvironment())
    .map(([key, value]) => `Environment=${key}=${systemdQuote(value)}`);
  const service = `[Unit]
Description=Myco local daemon hub

[Service]
Type=simple
ExecStart=${args}
Restart=always
RestartSec=2
Environment=NODE_ENV=production
${envLines.join('\n')}

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(servicePath, service, 'utf-8');
}

function serviceExecArgs(): string[] {
  return [process.execPath, path.resolve(process.argv[1] ?? ''), 'serve'];
}

function serviceEnvironment(): Record<string, string> {
  return HUB_DIR === DEFAULT_HUB_DIR ? {} : { MYCO_HUB_DIR: HUB_DIR };
}

function launchAgentPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_NAME}.plist`);
}

function systemdServicePath(): string {
  return path.join(os.homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
}

function readPid(): number | null {
  try {
    const pid = Number(fs.readFileSync(PID_PATH, 'utf-8').trim());
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isHubPid(pid: number): boolean {
  if (!isProcessAlive(pid)) return false;
  const commandLine = readProcessCommandLine(pid);
  if (!commandLine) return false;
  return /\bserve\b/.test(commandLine)
    && (commandLine.includes('myco-hub') || commandLine.includes('packages/myco-hub'));
}

function removePidFile(): void {
  fs.rmSync(PID_PATH, { force: true });
}

function runServiceCommand(
  command: string,
  args: string[],
  options: { allowAlreadyLoaded?: boolean; allowNotLoaded?: boolean } = {},
): void {
  const result = spawnSync(command, args, {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!result.error && result.status === 0) return;

  const stderr = String(result.stderr ?? '').trim();
  const stdout = String(result.stdout ?? '').trim();
  const output = [stderr, stdout].filter(Boolean).join('\n');
  const normalized = output.toLowerCase();
  if (options.allowAlreadyLoaded && /already|exists|load failed: 5/.test(normalized)) return;
  if (options.allowNotLoaded && /not loaded|no such process|could not find|not-found|not found|not loaded/.test(normalized)) return;

  const reason = result.error?.message || output || `exit status ${result.status ?? 'unknown'}`;
  throw new Error(`${command} ${args.join(' ')} failed: ${reason}`);
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function systemdQuote(input: string): string {
  return `"${input.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function ensureDefaultConfig(): void {
  ensureHubDir();
  if (fs.existsSync(CONFIG_PATH)) return;
  saveConfig({
    version: 1,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    reconcile_running_daemons: true,
  });
}
