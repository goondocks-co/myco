import fs from 'node:fs';
import path from 'node:path';

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface ServiceStatus {
  running: boolean;
  pid: number | null;
  uptime: number | null;
}

export function getServicePidPath(vaultDir: string): string {
  return path.join(vaultDir, 'service.pid');
}

export function isServiceRunning(vaultDir: string): boolean {
  const pidPath = getServicePidPath(vaultDir);
  if (!fs.existsSync(pidPath)) return false;

  const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
  if (isNaN(pid)) return false;

  try {
    // Signal 0 checks if process exists without killing it
    process.kill(pid, 0);
    return true;
  } catch {
    // Process doesn't exist — clean up stale PID file
    fs.unlinkSync(pidPath);
    return false;
  }
}

export function writeServicePid(vaultDir: string): void {
  const pidPath = getServicePidPath(vaultDir);
  fs.writeFileSync(pidPath, String(process.pid));
}

export function removeServicePid(vaultDir: string): void {
  const pidPath = getServicePidPath(vaultDir);
  if (fs.existsSync(pidPath)) {
    fs.unlinkSync(pidPath);
  }
}

export function getServiceStatus(vaultDir: string): ServiceStatus {
  const pidPath = getServicePidPath(vaultDir);

  if (!fs.existsSync(pidPath)) {
    return { running: false, pid: null, uptime: null };
  }

  const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
  const running = isServiceRunning(vaultDir);

  return {
    running,
    pid: running ? pid : null,
    uptime: running ? Date.now() - fs.statSync(pidPath).mtimeMs : null,
  };
}

export interface IdleShutdownHandle {
  timer: NodeJS.Timeout;
  refresh(): void;
  stop(): void;
}

export function setupIdleShutdown(vaultDir: string, timeoutMs = IDLE_TIMEOUT_MS): IdleShutdownHandle {
  let lastActivity = Date.now();

  const timer = setInterval(() => {
    if (Date.now() - lastActivity > timeoutMs) {
      removeServicePid(vaultDir);
      process.exit(0);
    }
  }, 30_000); // Check every 30s

  return {
    timer,
    refresh() {
      lastActivity = Date.now();
    },
    stop() {
      clearInterval(timer);
    },
  };
}
