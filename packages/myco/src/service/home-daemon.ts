/**
 * Stopping the 1.4 daemon a home runs: its OS service unregistered, so the
 * platform never starts it again, and the running process asked to exit.
 * `myco remove` and `myco cutover` both stop a home's daemon through here.
 */
import { getServiceManager } from './manager.js';
import { serviceLabel } from './labels.js';
import { getScopedServiceManager, resolveObservedScope } from './scoped.js';
import { requestCooperativeShutdown } from './cooperative-shutdown.js';
import { readDaemonState, resolveGlobalDaemonPort } from '../daemon/service-state.js';
import { resolveServiceDaemonStatePath } from '../grove/paths.js';
import { DAEMON_HEALTH_CHECK_TIMEOUT_MS } from '../constants.js';

/** What unregistering a home's daemon service came to. */
export type ServiceStop = { kind: 'removed'; label: string } | { kind: 'absent'; label: string } | { kind: 'unsupported'; platform: string };

/**
 * Unregister the daemon service of `mycoHome`, the login service and, where
 * one was observed, the boot-scoped one. `absent` when no service under that
 * home's label was installed.
 */
export async function unregisterHomeService(mycoHome: string): Promise<ServiceStop> {
  const mgr = getServiceManager();
  const label = serviceLabel(mycoHome);
  if (!mgr.supported) return { kind: 'unsupported', platform: mgr.platformName };
  const installed = await mgr.isInstalled(label);
  await mgr.uninstall(label);
  const observed = await resolveObservedScope(label);
  if (observed === 'boot' || observed === 'both') {
    await getScopedServiceManager({ scope: { startAt: 'boot', runAs: 'invoking-user' } }).uninstall(label);
  }
  return installed || observed === 'boot' || observed === 'both' ? { kind: 'removed', label } : { kind: 'absent', label };
}

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
