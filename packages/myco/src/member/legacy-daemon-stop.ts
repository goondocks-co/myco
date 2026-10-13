import { requestCooperativeShutdown } from './legacy-service/cooperative-shutdown.js';
import { readDaemonState, resolveGlobalDaemonPort } from './legacy-daemon-state.js';
import { resolveServiceDaemonStatePath } from '@myco/paths/service.js';
import { DAEMON_HEALTH_CHECK_TIMEOUT_MS } from '@myco/constants.js';

/** What asking a home's daemon to exit came to. */
export type DaemonStop = 'stopped' | 'none' | 'not-this-home';

/**
 * Ask the daemon `mycoHome` runs to exit, and only that daemon: the port
 * comes from the home's own daemon state, and the process answering on it
 * must report the pid that state records. A daemon of another home that
 * happens to answer there is left running (`not-this-home`).
 */
export async function stopHomeDaemon(mycoHome: string, fetchFn: typeof fetch = fetch): Promise<DaemonStop> {
  const state = readDaemonState(resolveServiceDaemonStatePath(mycoHome));
  const port = state?.port ?? resolveGlobalDaemonPort(mycoHome);
  let pid: unknown;
  try {
    const health = await fetchFn(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(DAEMON_HEALTH_CHECK_TIMEOUT_MS) });
    pid = ((await health.json()) as { pid?: unknown }).pid;
  } catch {
    return 'none';
  }
  if (state === null || pid !== state.pid) return 'not-this-home';
  try {
    return await requestCooperativeShutdown(port, { fetchFn }) ? 'stopped' : 'none';
  } catch {
    return 'none';
  }
}
