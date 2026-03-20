import { spawn } from 'node:child_process';
import type { RouteResponse } from '../router.js';
import type { ProgressTracker } from './progress.js';

/** Delay before sending SIGTERM to self — allows the HTTP response to flush. */
const RESTART_DELAY_MS = 500;

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

  // Spawn a detached child process that starts a new daemon after this one exits.
  // The daemon script is the current module's entry point.
  const daemonScript = process.argv[1];
  const child = spawn(
    process.execPath,
    [daemonScript, '--vault', deps.vaultDir],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();

  // Schedule self-termination after response flushes
  setTimeout(() => {
    process.kill(process.pid, 'SIGTERM');
  }, RESTART_DELAY_MS);

  return { body: { status: 'restarting' } };
}
