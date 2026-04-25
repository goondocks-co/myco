import { execFileSync } from 'node:child_process';
import { runPowerShell } from './process.js';

export const PORT_RANGE_START = 19200;
export const PORT_RANGE_SIZE = 10000;
export const PORT_RANGE_END = PORT_RANGE_START + PORT_RANGE_SIZE - 1;

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

export function findPidsListeningOn(ports: number[]): PortOwner[] {
  if (ports.length === 0) return [];
  const sorted = [...new Set(ports)].sort((a, b) => a - b);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first === undefined || last === undefined) return [];
  const owners = findPidsListeningInRange(first, last);
  if (first === last) return owners;
  const requested = new Set(sorted);
  return owners.filter((owner) => requested.has(owner.port));
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
