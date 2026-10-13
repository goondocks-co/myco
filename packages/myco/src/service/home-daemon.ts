/**
 * Stopping the 1.4 daemon a home runs: its OS service unregistered, so the
 * platform never starts it again, and the running process asked to exit.
 * `myco remove` and `myco cutover` both stop a home's daemon through here.
 */
import { getServiceManager } from './manager.js';
import { serviceLabel } from './labels.js';
import { getScopedServiceManager, resolveObservedScope } from './scoped.js';

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

export { stopHomeDaemon, type DaemonStop } from '@myco/member/legacy-daemon-stop.js';
