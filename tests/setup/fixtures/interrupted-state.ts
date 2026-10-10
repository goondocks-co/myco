import type { RelationalStore, ServerEnv } from '@myco-server-worker/core/adapters.js';
import type { NativeSqlite } from '@myco-server-worker/platform/bun/native.js';
import { setupFirstOwner } from '@myco-server-worker/core/first-owner.js';
import { IDENTITY_LINK_TTL_MS } from '@myco-server-worker/auth/identity-link.js';
import { DEVICE_TTL_MS, handleDeviceStart } from '@myco-server-worker/auth/device.js';
import { createLocalDeployment, DEFAULT_LOCAL_RECORD, resolveLocalPaths } from '@myco/server/local.js';
import { RUNNER_RECORD_VERSION, publishRunnerRecord, withRunnerLock } from '@myco/runner/runner-registry.js';
import { convertManifestCode } from '@myco/server/github-app.js';
import { writePrivateFileAtomic } from '@myco/member/store.js';
import { LocalVolume } from '@myco/server/local-volume.js';
import fs from 'node:fs';
import path from 'node:path';

/** Seeds a private pending-conversion artifact for sign-in recovery fixtures. */
export async function convertedBeforeInstall(mycoHome: string, fetchImpl: typeof fetch, url = 'https://setup.invalid') {
  const app = await convertManifestCode('setup-conversion', fetchImpl);
  const paths = resolveLocalPaths(mycoHome);
  const file = path.join(paths.root, 'sign-in-pending.json');
  const pending = { ...app, url, at: Date.UTC(2026, 9, 10) };
  new LocalVolume(paths).exclusive(() => {
    fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
    writePrivateFileAtomic(file, `${JSON.stringify(pending)}\n`);
  });
  return { file, pending };
}

/** Creation has committed; sign-in credentials and an owner have not been written. */
export function createdBeforeSignIn(mycoHome: string, native: NativeSqlite) {
  const paths = resolveLocalPaths(mycoHome);
  createLocalDeployment(DEFAULT_LOCAL_RECORD, native, paths);
  return paths;
}

/** The first-owner receipt and its expired, unspent link are real server state. */
export function expiredOwnerLink(db: RelationalStore, now: number) {
  return setupFirstOwner(db, now - IDENTITY_LINK_TTL_MS - 1, 'fixture schema mismatch');
}

/** A genuine pending device request whose approval window has elapsed at `now`. */
export async function timedOutApproval(env: ServerEnv, now: number) {
  const response = await handleDeviceStart(env, new Request('https://setup.invalid/auth/device/start', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ machineId: 'machine_setup_pending', machineName: 'Fixture machine', os: 'fixture' }),
  }), now - DEVICE_TTL_MS - 1, '192.0.2.1');
  if (!response.ok) throw new Error(`fixture device start refused: ${response.status}`);
  return response.json() as Promise<{ device_code: string; user_code: string; expires_in: number }>;
}

/** Enrollment is durable in the runner registry; no service unit is installed. */
export async function enrolledBeforeInstall(mycoHome: string, serverUrl = 'https://setup.invalid') {
  const record = {
    version: RUNNER_RECORD_VERSION, serverUrl, deploymentId: 'fixture-deployment',
    runnerId: 'rn_setup_enrolled', name: 'Fixture runner', token: `mycorun_${'b'.repeat(43)}`,
  };
  await withRunnerLock(serverUrl, (lock) => publishRunnerRecord(lock, record), mycoHome);
  return record;
}
