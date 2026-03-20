import { spawn } from 'node:child_process';
import type { RouteResponse } from '../router.js';
import type { ProgressTracker } from './progress.js';

/** Delay before initiating shutdown — allows the HTTP response to flush. */
const RESTART_RESPONSE_FLUSH_MS = 500;
/** Delay before the child process starts — allows the parent to fully release the port. */
const RESTART_CHILD_DELAY_SECONDS = 2;

export interface RestartHandlerDeps {
  vaultDir: string;
  progressTracker: ProgressTracker;
}

export async function handleRestart(
  deps: RestartHandlerDeps,
  body: unknown,
): Promise<RouteResponse> {
  const { force } = (body as Record<string, unknown>) ?? {};

  // Check for active operations unless force is set
  if (!force && deps.progressTracker.hasActiveOperations()) {
    return {
      status: 409,
      body: { status: 'busy', message: 'Active operations in progress. Use force=true to override.' },
    };
  }

  // Schedule: respond → wait for flush → SIGTERM self → child starts after parent exits.
  // The child waits RESTART_CHILD_DELAY_SECONDS before starting to ensure the parent
  // has fully released the port and cleaned up daemon.json.
  const daemonScript = process.argv[1];
  const shellCmd = `sleep ${RESTART_CHILD_DELAY_SECONDS} && ${process.execPath} ${daemonScript} --vault ${deps.vaultDir}`;

  const child = spawn('/bin/sh', ['-c', shellCmd], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  // Schedule self-termination after response flushes
  setTimeout(() => {
    process.kill(process.pid, 'SIGTERM');
  }, RESTART_RESPONSE_FLUSH_MS);

  return { body: { status: 'restarting' } };
}
