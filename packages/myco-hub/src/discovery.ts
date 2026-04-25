import fs from 'node:fs';
import path from 'node:path';
import { findPidsListeningInRange, findVaultForProcess } from './process.js';
import { upsertProjectRegistration } from './registry.js';

export const MYCO_DAEMON_PORT_START = 19200;
export const MYCO_DAEMON_PORT_END = 29199;

export interface ProjectRecord {
  id: string;
  name: string;
  projectRoot: string;
  vaultDir: string;
  machineId: string;
  source: 'registration' | 'daemon-api' | 'process-scan' | 'unknown';
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
  const owners = findPidsListeningInRange(MYCO_DAEMON_PORT_START, MYCO_DAEMON_PORT_END);
  const probes = await Promise.all(owners.map(async (owner) => ({
    owner,
    metadata: await fetchDaemonMetadata(owner.port),
  })));

  const found = new Map<string, { pid: number; port: number }>();
  for (const { owner, metadata } of probes) {
    if (metadata) {
      upsertProjectRegistration(metadata, 'daemon-api');
      continue;
    }

    const vault = findVaultForProcess(owner.pid);
    if (vault && isVault(vault) && !found.has(vault)) found.set(vault, owner);
  }

  for (const [vaultDir, owner] of found) {
    const projectRoot = path.dirname(vaultDir);
    const daemon = readDaemonJson(vaultDir);
    const daemonMatchesOwner = daemon?.pid === owner.pid && daemon?.port === owner.port;
    upsertProjectRegistration({
      name: path.basename(projectRoot),
      projectRoot,
      vaultDir,
      machineId: readText(path.join(vaultDir, 'machine_id')) ?? 'unknown',
      port: owner.port,
      pid: owner.pid,
      version: daemonMatchesOwner ? daemon.version ?? null : null,
      startedAt: daemonMatchesOwner ? daemon.started ?? null : null,
      runtimeCommand: readRuntimeCommand(vaultDir),
    }, 'process-scan');
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
