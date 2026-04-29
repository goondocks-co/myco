import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cleanStaleDaemonJson,
  findPidsListeningInRange,
  findVaultForProcess,
  isProcessAlive,
  terminateProcess,
  type PortOwner,
} from '@goondocks/myco-shared';
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
const SPAWN_ERROR_DETECT_MS = 75;

export type ProjectStatus = 'running' | 'starting' | 'stopped' | 'unhealthy';

export interface ProjectRuntime {
  status: ProjectStatus;
  pid: number | null;
  port: number | null;
  version: string | null;
  startedAt: string | null;
  lastHealthAt: string | null;
  error?: string;
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

  const spawnResult = await spawnProjectDaemon(project);
  if (!spawnResult.ok) {
    return { ...emptyRuntime('stopped'), error: spawnResult.error };
  }
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

type SpawnResult = { ok: true } | { ok: false; error: string };

async function spawnProjectDaemon(project: ProjectRecord): Promise<SpawnResult> {
  const resolved = resolveProjectRuntimeCommand(project);
  if (!resolved) {
    const error = 'no runtime command found — install @goondocks/myco globally or run `make dev-link` for dogfood builds';
    appendLog('project daemon spawn skipped', {
      project: project.name,
      projectRoot: project.projectRoot,
      error,
    });
    return { ok: false, error };
  }

  const child = spawn(resolved, ['daemon'], {
    cwd: project.projectRoot,
    detached: true,
    stdio: 'ignore',
    env: enrichSpawnEnv(),
  });

  return new Promise<SpawnResult>((resolve) => {
    let settled = false;
    const settle = (result: SpawnResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.once('error', (error) => {
      appendLog('project daemon spawn failed', {
        project: project.name,
        projectRoot: project.projectRoot,
        runtimeCommand: resolved,
        error: error.message,
      });
      settle({ ok: false, error: `spawn failed: ${error.message}` });
    });

    setTimeout(() => {
      try { child.unref(); } catch { /* already detached */ }
      settle({ ok: true });
    }, SPAWN_ERROR_DETECT_MS);
  });
}

export function resolveProjectRuntimeCommand(project: ProjectRecord): string | null {
  const fileCommand = readRuntimeCommand(project.vaultDir);
  if (fileCommand && isReplayableMycoCommand(fileCommand)) return fileCommand;

  const registered = project.runtimeCommand;
  if (registered && isReplayableMycoCommand(registered)) return registered;

  for (const candidate of fallbackBinaryCandidates()) {
    if (isExecutable(candidate)) return candidate;
  }

  return null;
}

function fallbackBinaryCandidates(): string[] {
  const platform = process.platform;
  const home = os.homedir();
  const exe = platform === 'win32' ? 'myco.cmd' : 'myco';
  const devExe = platform === 'win32' ? 'myco-dev.cmd' : 'myco-dev';
  const target = hostTarget();
  const vendorRel = target ? path.join('node_modules', '@goondocks', 'myco', 'vendor', target, platform === 'win32' ? 'myco.exe' : 'myco') : null;
  const candidates: string[] = [];

  // Prefer self-contained vendor binaries (no node-on-PATH dependency).
  if (vendorRel) {
    if (platform === 'win32') {
      if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', vendorRel));
    } else {
      candidates.push(path.join('/opt/homebrew/lib', vendorRel));
      candidates.push(path.join('/usr/local/lib', vendorRel));
      candidates.push(path.join('/usr/lib', vendorRel));
      candidates.push(path.join(home, '.npm-global/lib', vendorRel));
    }
  }

  // Then bin shims (require node on PATH; spawn env is enriched to handle that).
  if (platform === 'win32') {
    if (process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, 'npm', exe));
    if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'nodejs', exe));
    candidates.push(path.join(home, '.local', 'bin', devExe));
  } else {
    candidates.push(`/opt/homebrew/bin/${exe}`);
    candidates.push(`/usr/local/bin/${exe}`);
    candidates.push(`/usr/bin/${exe}`);
    candidates.push(path.join(home, '.local', 'bin', devExe));
    candidates.push(path.join(home, '.local', 'bin', exe));
    candidates.push(path.join(home, '.npm-global', 'bin', exe));
  }

  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(dir, exe));
  }

  return candidates;
}

function hostTarget(): string | null {
  const archMap: Record<string, string> = { arm64: 'arm64', x64: 'x64' };
  const arch = archMap[process.arch];
  if (!arch) return null;
  if (process.platform === 'darwin') return `darwin-${arch}`;
  if (process.platform === 'linux') return `linux-${arch}`;
  if (process.platform === 'win32' && arch === 'x64') return 'windows-x64';
  return null;
}

function enrichSpawnEnv(): NodeJS.ProcessEnv {
  const inherited = process.env.PATH ?? '';
  const extras = process.platform === 'win32'
    ? []
    : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  const seen = new Set(inherited.split(path.delimiter).filter(Boolean));
  const merged = [...seen];
  for (const dir of extras) {
    if (!seen.has(dir)) merged.push(dir);
  }
  return { ...process.env, PATH: merged.join(path.delimiter) };
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isReplayableMycoCommand(filePath: string): boolean {
  if (isGenericJsRuntime(filePath)) return false;
  if (!looksLikePath(filePath)) return true;
  return isExecutable(filePath);
}

function isGenericJsRuntime(filePath: string): boolean {
  const base = path.basename(filePath).replace(/\.exe$/i, '').toLowerCase();
  return base === 'node' || base === 'bun';
}

function looksLikePath(value: string): boolean {
  return path.isAbsolute(value) || value.includes('/') || value.includes('\\');
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
