import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readDaemonJson, readRuntimeCommand, type ProjectRecord } from './discovery.js';
import { isProcessAlive } from './process.js';

const HEALTH_TIMEOUT_MS = 1500;
const START_RETRY_DELAYS_MS = [100, 200, 300, 500, 800, 1200, 1800];

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
  if (!daemon?.pid || !daemon.port) {
    return emptyRuntime('stopped');
  }

  const alive = isProcessAlive(daemon.pid);
  if (!alive) return emptyRuntime('stopped', daemon.pid, daemon.port, daemon.started ?? null);

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
  const daemon = readDaemonJson(project.vaultDir);
  if (daemon?.pid && isProcessAlive(daemon.pid)) {
    try {
      process.kill(daemon.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    for (let i = 0; i < 20 && isProcessAlive(daemon.pid); i++) {
      await sleep(100);
    }
  }

  try {
    const jsonPath = path.join(project.vaultDir, 'daemon.json');
    const current = readDaemonJson(project.vaultDir);
    if (!current?.pid || current.pid === daemon?.pid) fs.unlinkSync(jsonPath);
  } catch {
    // absent or owned by a successor
  }

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
  child.unref();
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

function emptyRuntime(
  status: ProjectStatus,
  pid: number | null = null,
  port: number | null = null,
  startedAt: string | null = null,
): ProjectRuntime {
  return {
    status,
    pid,
    port,
    version: null,
    startedAt,
    lastHealthAt: null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
