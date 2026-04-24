import fs from 'node:fs';
import path from 'node:path';
import { findPidsListeningInRange, findVaultFromCwd, readProcessCwd } from './process.js';
import { upsertProjectRegistration } from './registry.js';

export const MYCO_DAEMON_PORT_START = 19200;
export const MYCO_DAEMON_PORT_END = 29199;

export interface ProjectRecord {
  id: string;
  name: string;
  projectRoot: string;
  vaultDir: string;
  machineId: string;
  preferredPort: number | null;
  runtimeCommand: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface DaemonJson {
  pid?: number;
  port?: number;
  version?: string;
  started?: string;
  command?: string | null;
}

export async function reconcileRunningDaemons(): Promise<void> {
  const found = new Set<string>();
  for (const owner of findPidsListeningInRange(MYCO_DAEMON_PORT_START, MYCO_DAEMON_PORT_END)) {
    const metadata = await fetchDaemonMetadata(owner.port);
    if (metadata) {
      upsertProjectRegistration(metadata);
      continue;
    }

    const cwd = readProcessCwd(owner.pid);
    if (!cwd) continue;
    const vault = findVaultFromCwd(cwd);
    if (vault && isVault(vault)) found.add(vault);
  }

  for (const vaultDir of found) {
    const projectRoot = path.dirname(vaultDir);
    const daemon = readDaemonJson(vaultDir);
    upsertProjectRegistration({
      name: path.basename(projectRoot),
      projectRoot,
      vaultDir,
      machineId: readText(path.join(vaultDir, 'machine_id')) ?? 'unknown',
      port: daemon?.port ?? null,
      pid: daemon?.pid ?? null,
      version: daemon?.version ?? null,
      startedAt: daemon?.started ?? null,
      runtimeCommand: readRuntimeCommand(vaultDir),
    });
  }
}

export function isVault(vaultDir: string): boolean {
  try {
    return fs.statSync(path.join(vaultDir, 'myco.yaml')).isFile();
  } catch {
    return false;
  }
}

export function readDaemonJson(vaultDir: string): DaemonJson | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(vaultDir, 'daemon.json'), 'utf-8')) as DaemonJson;
  } catch {
    return null;
  }
}

export function readRuntimeCommand(vaultDir: string): string | null {
  return readText(path.join(vaultDir, 'runtime.command'));
}

function readConfiguredPort(vaultDir: string): number | null {
  try {
    const raw = fs.readFileSync(path.join(vaultDir, 'myco.yaml'), 'utf-8');
    const daemonIndex = raw.search(/^daemon:\s*$/m);
    if (daemonIndex < 0) return null;
    const tail = raw.slice(daemonIndex);
    const match = tail.match(/^\s+port:\s*(\d+)\s*$/m);
    if (!match?.[1]) return null;
    const port = Number(match[1]);
    return Number.isInteger(port) ? port : null;
  } catch {
    return null;
  }
}

async function fetchDaemonMetadata(port: number): Promise<Parameters<typeof upsertProjectRegistration>[0] | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/hub/project`, {
      signal: AbortSignal.timeout(1200),
    });
    if (!res.ok) return null;
    const body = await res.json() as Parameters<typeof upsertProjectRegistration>[0];
    if (!body.projectRoot || !body.vaultDir || !body.machineId) return null;
    return body;
  } catch {
    return null;
  }
}

function readText(filePath: string): string | null {
  try {
    const text = fs.readFileSync(filePath, 'utf-8').trim();
    return text || null;
  } catch {
    return null;
  }
}
