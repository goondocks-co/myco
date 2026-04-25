import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

export function findVaultForProcess(pid: number): string | null {
  const cwd = readProcessCwd(pid);
  if (cwd) {
    const vault = findVaultFromCwd(cwd);
    if (vault) return vault;
  }

  const commandLine = readProcessCommandLine(pid);
  return commandLine ? findVaultFromCommandLine(commandLine) : null;
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

export interface PortOwner {
  port: number;
  pid: number;
}

export function findPidsListeningInRange(start: number, end: number): PortOwner[] {
  if (end < start) return [];
  if (process.platform === 'win32') return findWindowsPidsListeningInRange(start, end);

  let stdout: string;
  try {
    stdout = execFileSync(
      'lsof',
      [`-iTCP:${start}-${end}`, '-sTCP:LISTEN', '-nP', '-F', 'pn'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 },
    );
  } catch {
    if (process.platform === 'linux') return findLinuxPidsListeningInRange(start, end);
    return [];
  }
  return parseLsofOutput(stdout);
}

function findLinuxPidsListeningInRange(start: number, end: number): PortOwner[] {
  for (const [command, args] of [
    ['ss', ['-H', '-ltnp']],
    ['netstat', ['-ltnp']],
  ] as const) {
    try {
      const stdout = execFileSync(command, args, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      });
      const owners = parseLinuxListenerOutput(stdout).filter((owner) => owner.port >= start && owner.port <= end);
      if (owners.length > 0) return owners;
    } catch {
      // try the next platform tool
    }
  }
  return [];
}

function findWindowsPidsListeningInRange(start: number, end: number): PortOwner[] {
  try {
    const stdout = runPowerShell([
      '$ErrorActionPreference = "Stop";',
      'Get-NetTCPConnection -State Listen',
      `| Where-Object { $_.LocalPort -ge ${start} -and $_.LocalPort -le ${end} }`,
      '| Select-Object LocalPort, OwningProcess',
      '| ConvertTo-Json -Compress',
    ].join(' '));
    return parseWindowsTcpConnections(stdout);
  } catch {
    return [];
  }
}

export function parseLsofOutput(stdout: string): PortOwner[] {
  const owners: PortOwner[] = [];
  let currentPid: number | undefined;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1));
      currentPid = Number.isFinite(pid) ? pid : undefined;
      continue;
    }
    if (!line.startsWith('n') || currentPid === undefined) continue;
    const match = line.match(/:(\d+)$/);
    if (!match?.[1]) continue;
    const port = Number(match[1]);
    if (Number.isFinite(port)) owners.push({ port, pid: currentPid });
  }
  return owners;
}

export function parseWindowsTcpConnections(stdout: string): PortOwner[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const record = row as { LocalPort?: unknown; OwningProcess?: unknown };
    const port = Number(record.LocalPort);
    const pid = Number(record.OwningProcess);
    return Number.isFinite(port) && Number.isFinite(pid) ? [{ port, pid }] : [];
  });
}

export function parseLinuxListenerOutput(stdout: string): PortOwner[] {
  const owners: PortOwner[] = [];
  for (const line of stdout.split('\n')) {
    const pidMatch = line.match(/pid=(\d+)/) ?? line.match(/\s(\d+)\/[^\s]+/);
    if (!pidMatch?.[1]) continue;
    const pid = Number(pidMatch[1]);
    const localAddress = line.match(/(?:^|\s)(?:\[?[0-9a-fA-F:.%]+\]?|\*):(\d+)(?:\s|$)/);
    const port = Number(localAddress?.[1]);
    if (Number.isFinite(pid) && Number.isFinite(port)) owners.push({ port, pid });
  }
  return owners;
}

function runPowerShell(command: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 3000,
  });
}
