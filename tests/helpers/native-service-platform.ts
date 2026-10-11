import { LifecycleLock, type LockHandle } from '@myco/utils/lifecycle-lock.js';
import type { LocalDeploymentPaths } from '@myco/server/local.js';
import type { ServiceSpec } from '@myco/server/service.js';
import { recordingPlatform } from './fake-service-manager.js';

/** A fake native service that holds the same volume leases as a serving process. */
export function nativeServicePlatform(paths: LocalDeploymentPaths, spec: ServiceSpec) {
  const platform = recordingPlatform();
  let serving: LockHandle | null = null;
  let volume: LockHandle | null = null;
  const dispose = () => { serving?.release(); volume?.release(); serving = null; volume = null; };
  return { ...platform, dispose, runner: (command: string, args: readonly string[]) => {
    const result = platform.runner(command, args);
    if (platform.running.has(spec.unit.label)) {
      if (serving === null) {
        const only = LifecycleLock.acquire(`${paths.root}.serve.lock`, { command: 'fake native service' });
        if (!only.acquired) throw new Error('fake native service cannot take its serve lease');
        serving = only.lock;
        const read = LifecycleLock.acquire(`${paths.root}.lock`, { command: 'fake native service', mode: 'shared' });
        if (!read.acquired) { dispose(); throw new Error('fake native service cannot take its volume lease'); }
        volume = read.lock;
      }
    } else dispose();
    return { ...result, ...(result.stdout === undefined ? {} : { stdout: result.stdout.replace('4242', String(process.pid)) }) };
  } };
}
