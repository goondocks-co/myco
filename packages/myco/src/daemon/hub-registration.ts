import fs from 'node:fs';
import path from 'node:path';
import { readProjectRuntimeCommand } from './hub-runtime.js';

const DEFAULT_HUB_URL = 'http://127.0.0.1:21000';
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

export async function registerWithHub(metadata: HubProjectMetadata): Promise<boolean> {
  const hubUrl = (process.env.MYCO_HUB_URL ?? DEFAULT_HUB_URL).replace(/\/+$/, '');
  try {
    const res = await fetch(`${hubUrl}/api/daemon/register`, {
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

function readStartedAt(vaultDir: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(vaultDir, 'daemon.json'), 'utf-8')) as { started?: unknown };
    return typeof raw.started === 'string' ? raw.started : null;
  } catch {
    return null;
  }
}
