import fs from 'node:fs';
import path from 'node:path';
import { isProcessAlive } from './process.js';

export interface TerminateLogger {
  warn?: (event: string, message: string, meta?: Record<string, unknown>) => void;
}

export interface TerminateOptions {
  graceMs: number;
  pollMs: number;
  logger?: TerminateLogger;
}

const LOG_KIND = 'process.terminate';

export async function terminateProcess(pid: number, opts: TerminateOptions): Promise<void> {
  const { graceMs, pollMs, logger } = opts;

  if (!isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }

  if (await waitForProcessExit(pid, graceMs, pollMs)) return;

  logger?.warn?.(LOG_KIND, 'Process did not exit after SIGTERM, escalating to SIGKILL', {
    pid,
    grace_ms: graceMs,
  });

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return;
  }

  if (await waitForProcessExit(pid, pollMs * 5, pollMs)) return;

  logger?.warn?.(LOG_KIND, 'Process still alive after SIGKILL', { pid });
}

export async function waitForProcessExit(pid: number, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return !isProcessAlive(pid);
}

export function cleanStaleDaemonJson(vaultDir: string, evictedPids: readonly number[]): void {
  try {
    const jsonPath = path.join(vaultDir, 'daemon.json');
    const raw = fs.readFileSync(jsonPath, 'utf-8');
    const info = JSON.parse(raw) as { pid?: unknown };
    if (typeof info.pid === 'number' && evictedPids.includes(info.pid)) {
      fs.unlinkSync(jsonPath);
    }
  } catch {
    // already absent or owned by a successor
  }
}
