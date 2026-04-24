import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_PATH, DEFAULT_HOST, DEFAULT_PORT, HUB_DIR, LOG_PATH, PID_PATH, ensureHubDir, loadConfig, saveConfig } from './paths.js';

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
    spawnSync('launchctl', ['unload', plist], { stdio: 'ignore' });
    fs.rmSync(plist, { force: true });
    return;
  }
  if (process.platform === 'linux') {
    spawnSync('systemctl', ['--user', 'disable', '--now', `${SERVICE_NAME}.service`], { stdio: 'ignore' });
    fs.rmSync(systemdServicePath(), { force: true });
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    return;
  }
}

export function startService(): void {
  if (process.platform === 'darwin') {
    spawnSync('launchctl', ['load', '-w', launchAgentPath()], { stdio: 'ignore' });
    spawnSync('launchctl', ['kickstart', '-k', `gui/${process.getuid?.()}/${SERVICE_NAME}`], { stdio: 'ignore' });
    return;
  }
  if (process.platform === 'linux') {
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    spawnSync('systemctl', ['--user', 'enable', '--now', `${SERVICE_NAME}.service`], { stdio: 'inherit' });
    return;
  }
  throw new Error('service start is not yet supported on Windows');
}

export function stopService(): void {
  const pid = readPid();
  if (pid) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already stopped */ }
  }
  if (process.platform === 'darwin') {
    spawnSync('launchctl', ['bootout', `gui/${process.getuid?.()}/${SERVICE_NAME}`], { stdio: 'ignore' });
  } else if (process.platform === 'linux') {
    spawnSync('systemctl', ['--user', 'stop', `${SERVICE_NAME}.service`], { stdio: 'ignore' });
  }
}

export function serviceStatus(): { running: boolean; pid: number | null; url: string; configPath: string; logPath: string } {
  const config = loadConfig();
  const pid = readPid();
  return {
    running: pid !== null && isAlive(pid),
    pid,
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
  <key>StandardOutPath</key>
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
  const service = `[Unit]
Description=Myco local daemon hub

[Service]
Type=simple
ExecStart=${args}
Restart=always
RestartSec=2
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
  fs.writeFileSync(servicePath, service, 'utf-8');
}

function serviceExecArgs(): string[] {
  return [process.execPath, path.resolve(process.argv[1] ?? ''), 'serve'];
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
