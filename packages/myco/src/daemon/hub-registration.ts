import fs from 'node:fs';
import path from 'node:path';
import { readProjectRuntimeCommand } from './hub-runtime.js';
import { DEFAULT_HUB_URL } from '../constants/hub.js';

const HUB_REGISTER_TIMEOUT_MS = 1200;

export interface HubProjectMetadata {
  name: string;
  projectRoot: string;
  vaultDir: string;
  machineId: string;
  port: number;
  pid: number;
  version: string;
  startedAt: string | null;
  runtimeCommand: string | null;
}

export function buildHubProjectMetadata(args: {
  projectRoot: string;
  vaultDir: string;
  machineId: string;
  port: number;
  version: string;
}): HubProjectMetadata {
  return {
    name: path.basename(args.projectRoot),
    projectRoot: args.projectRoot,
    vaultDir: args.vaultDir,
    machineId: args.machineId,
    port: args.port,
    pid: process.pid,
    version: args.version,
    startedAt: readStartedAt(args.vaultDir),
    runtimeCommand: readProjectRuntimeCommand(args.vaultDir),
  };
}

export async function registerWithHub(
  metadata: HubProjectMetadata,
  hubUrl = normalizeHubUrl(process.env.MYCO_HUB_URL ?? DEFAULT_HUB_URL),
): Promise<boolean> {
  const normalizedHubUrl = normalizeHubUrl(hubUrl);
  try {
    const res = await fetch(`${normalizedHubUrl}/api/daemon/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
      signal: AbortSignal.timeout(HUB_REGISTER_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function normalizeHubUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function readStartedAt(vaultDir: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(vaultDir, 'daemon.json'), 'utf-8')) as { started?: unknown };
    return typeof raw.started === 'string' ? raw.started : null;
  } catch {
    return null;
  }
}
