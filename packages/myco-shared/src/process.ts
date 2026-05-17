import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Liveness check via the null signal.
 *
 * `process.kill(pid, 0)` succeeds when the kernel has a process for `pid` AND
 * the caller has permission to signal it. The OS distinguishes the two
 * failure modes via `errno`:
 *
 *   - `ESRCH` — no such process. The pid is genuinely dead.
 *   - `EPERM` — the process exists but the caller cannot signal it (a
 *     different uid owns it). For our purposes the pid is ALIVE; we just
 *     can't talk to it.
 *
 * Conflating EPERM with "dead" is unsafe in the reconcileExistingDaemon
 * polling ladder — it would unlink daemon.json out from under a live daemon
 * owned by another user (self-mutation-discipline tenet violation). Any
 * other unexpected error is treated conservatively as "alive" to err away
 * from orphaning state.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

export function readProcessCwd(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      return fs.readlinkSync(`/proc/${pid}/cwd`);
    }
    if (process.platform === 'darwin') {
      const out = execFileSync(
        'lsof',
        ['-p', String(pid), '-a', '-d', 'cwd', '-Fn'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 },
      );
      for (const line of out.split('\n')) {
        if (line.startsWith('n')) return line.slice(1);
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function readProcessCommandLine(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim() || null;
    }
    if (process.platform === 'darwin') {
      return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      }).trim() || null;
    }
    if (process.platform === 'win32') {
      return runPowerShell([
        `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
        'if ($process -and $process.CommandLine) { $process.CommandLine }',
      ].join('; ')).trim() || null;
    }
  } catch {
    return null;
  }
  return null;
}

export function findVaultFromCwd(cwd: string): string | null {
  let dir = path.resolve(cwd);
  while (true) {
    const candidate = path.join(dir, '.myco');
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function findVaultFromCommandLine(commandLine: string): string | null {
  const match = commandLine.match(/(?:^|\s)--vault(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!value) return null;

  const resolved = path.resolve(value);
  const candidate = path.basename(resolved) === '.myco' ? resolved : findVaultFromCwd(resolved);
  if (!candidate) return null;

  try {
    return fs.statSync(candidate).isDirectory() ? candidate : null;
  } catch {
    return null;
  }
}

export function findVaultForProcess(pid: number): string | null {
  const cwd = readProcessCwd(pid);
  if (cwd) {
    const vault = findVaultFromCwd(cwd);
    if (vault) return vault;
  }

  const commandLine = readProcessCommandLine(pid);
  return commandLine ? findVaultFromCommandLine(commandLine) : null;
}

export function runPowerShell(command: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 3000,
  });
}
