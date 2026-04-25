import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  cleanStaleDaemonJson,
  findPidsListeningInRange,
  findVaultForProcess,
  isProcessAlive,
  terminateProcess,
  type PortOwner,
} from '@myco-shared/index.js';
import { appendLog } from './paths.js';
import {
  MYCO_DAEMON_PORT_END,
  MYCO_DAEMON_PORT_START,
  readDaemonJson,
  readRuntimeCommand,
  type ProjectRecord,
} from './discovery.js';

const HEALTH_TIMEOUT_MS = 1500;
const START_RETRY_DELAYS_MS = [100, 200, 300, 500, 800, 1200, 1800];
const STOP_GRACE_MS = 5000;
const STOP_POLL_MS = 100;

export type ProjectStatus = 'running' | 'starting' | 'stopped' | 'unhealthy';

export interface ProjectRuntime {
  status: ProjectStatus;
  pid: number | null;
  port: number | null;
  version: string | null;
  startedAt: string | null;
  lastHealthAt: string | null;
}

export interface ProjectWithRuntime extends ProjectRecord {
  runtime: ProjectRuntime;
}

export async function withRuntime(project: ProjectRecord): Promise<ProjectWithRuntime> {
  return { ...project, runtime: await getRuntime(project) };
}

export async function getRuntime(project: ProjectRecord): Promise<ProjectRuntime> {
  const daemon = readDaemonJson(project.vaultDir);
  if (daemon?.pid && daemon.port) {
    if (isProjectPid(project, daemon.pid)) {
      const health = await healthCheck(daemon.port);
      if (!health.ok) {
        return {
          status: 'unhealthy',
          pid: daemon.pid,
          port: daemon.port,
          version: daemon.version ?? null,
          startedAt: daemon.started ?? null,
          lastHealthAt: null,
        };
      }

      return {
        status: 'running',
        pid: daemon.pid,
        port: daemon.port,
        version: health.version ?? daemon.version ?? null,
        startedAt: daemon.started ?? null,
        lastHealthAt: new Date().toISOString(),
      };
    }
  }

  const owner = findProjectPortOwners(project)[0];
  if (!owner) return emptyRuntime('stopped');

  const health = await healthCheck(owner.port);
  return {
    status: health.ok ? 'running' : 'unhealthy',
    pid: owner.pid,
    port: owner.port,
    version: health.version ?? daemon?.version ?? null,
    startedAt: daemon?.started ?? null,
    lastHealthAt: health.ok ? new Date().toISOString() : null,
  };
}

export async function ensureProjectRunning(project: ProjectRecord): Promise<ProjectRuntime> {
  const current = await getRuntime(project);
  if (current.status === 'running') return current;

  spawnProjectDaemon(project);
  for (const delay of START_RETRY_DELAYS_MS) {
    await sleep(delay);
    const runtime = await getRuntime(project);
    if (runtime.status === 'running') return runtime;
  }
  return getRuntime(project);
}

export async function stopProject(project: ProjectRecord): Promise<ProjectRuntime> {
  const pids = new Set<number>();
  const daemon = readDaemonJson(project.vaultDir);
  if (daemon?.pid && isProjectPid(project, daemon.pid)) {
    pids.add(daemon.pid);
  }
  for (const owner of findProjectPortOwners(project)) {
    if (isProcessAlive(owner.pid)) pids.add(owner.pid);
  }

  await Promise.all([...pids].map((pid) => terminateProcess(pid, {
    graceMs: STOP_GRACE_MS,
    pollMs: STOP_POLL_MS,
  })));

  cleanStaleDaemonJson(project.vaultDir, [...pids]);
  return getRuntime(project);
}

export async function restartProject(project: ProjectRecord): Promise<ProjectRuntime> {
  await stopProject(project);
  return ensureProjectRunning(project);
}

function spawnProjectDaemon(project: ProjectRecord): void {
  const runtimeCommand = readRuntimeCommand(project.vaultDir) ?? 'myco';
  const child = spawn(runtimeCommand, ['daemon'], {
    cwd: project.projectRoot,
    detached: true,
    stdio: 'ignore',
  });
  child.once('error', (error) => {
    appendLog('project daemon spawn failed', {
      project: project.name,
      projectRoot: project.projectRoot,
      runtimeCommand,
      error: error.message,
    });
  });
  child.unref();
}

function findProjectPortOwners(project: ProjectRecord): PortOwner[] {
  return findPidsListeningInRange(MYCO_DAEMON_PORT_START, MYCO_DAEMON_PORT_END)
    .filter((owner) => {
      return samePath(findVaultForProcess(owner.pid), project.vaultDir);
    });
}

function isProjectPid(project: ProjectRecord, pid: number): boolean {
  return isProcessAlive(pid) && samePath(findVaultForProcess(pid), project.vaultDir);
}

async function healthCheck(port: number): Promise<{ ok: boolean; version?: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false };
    const body = await res.json() as { myco?: boolean; version?: string };
    return body.myco === true ? { ok: true, version: body.version } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function emptyRuntime(status: ProjectStatus): ProjectRuntime {
  return {
    status,
    pid: null,
    port: null,
    version: null,
    startedAt: null,
    lastHealthAt: null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function samePath(actual: string | null, expected: string): boolean {
  if (!actual) return false;
  return normalizePath(actual) === normalizePath(expected);
}

function normalizePath(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}
