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

export interface PortOwner {
  port: number;
  pid: number;
}

export function findPidsListeningInRange(start: number, end: number): PortOwner[] {
  if (end < start) return [];
  let stdout: string;
  try {
    stdout = execFileSync(
      'lsof',
      [`-iTCP:${start}-${end}`, '-sTCP:LISTEN', '-nP', '-F', 'pn'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 },
    );
  } catch {
    return [];
  }
  return parseLsofOutput(stdout);
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
