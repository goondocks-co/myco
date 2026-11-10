import { afterEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NESTED_BUN_TEST_TIMEOUT_ARGS, sandboxChildEnv } from '../../../scripts/test-environment.mjs';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLocalDeployment, ensureLocalSecrets, DEFAULT_LOCAL_RECORD, peekLocalPaths, readLocalSecrets, writeLocalRecord, writeLocalSecrets, type LocalCreateStep } from '@myco/server/local.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { inspectLocal, prepareLocal, recoverLocalOwnerLink, type LocalPreparePlan, type LocalPrepareDeps } from '@myco/server/local-lifecycle.js';
import { localOwnerLinked, setupLocalOwner, waitForOwnerLink } from '@myco/server/local-owner.js';
import { LocalVolume, volumeIdentity } from '@myco/server/local-volume.js';
import { defaultSpec, installService, servicePaths, renderUnit } from '@myco/server/service.js';
import { nativeServicePlatform } from '../../helpers/native-service-platform.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { spendIdentityLinkAuthority } from '@myco-server-worker/auth/identity-link.js';

export const native = { library: null, vec0: null };
export const homes: string[] = [];
export const disposers: (() => void)[] = [];
export function installLocalLifecycle(): void {
  afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });
}

export function fixture(create = true, name = 'myco') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-native-lifecycle-'));
  homes.push(root);
  const home = path.join(root, name);
  const paths = peekLocalPaths(home);
  if (create) createLocalDeployment(DEFAULT_LOCAL_RECORD, native, paths);
  const spec = defaultSpec(path.join(root, 'bin', 'myco'), root, 'darwin', home);
  const platform = nativeServicePlatform(paths, spec);
  disposers.push(platform.dispose);
  const deps: LocalPrepareDeps = { native, userHome: root, binaryPath: path.join(root, 'bin', 'myco'),
    service: { platform: 'darwin', runner: platform.runner },
    fetchImpl: Object.assign(async () => new Response('ok'), { preconnect: () => {} }),
    confirmStop: async () => true };
  return { root, home, paths, deps, platform, spec };
}
export const plan: LocalPreparePlan = { retryCommand: 'myco server install --target local', port: DEFAULT_LOCAL_RECORD.port, signIn: 'skip', owner: 'mint', serve: 'service' };
export function signIn(f: ReturnType<typeof fixture>) {
  writeLocalSecrets({ ...readLocalSecrets(f.paths), GITHUB_CLIENT_ID: 'test-app', GITHUB_CLIENT_SECRET: 'test-secret' }, f.paths);
}
export function serve(f: ReturnType<typeof fixture>) {
  return new LocalVolume(f.paths).serve({ pending: () => false, startup: () => {},
    identity: () => volumeIdentity(f.paths.databasePath, () => null), start: async () => ({ stop: async () => {} }) });
}
export function tree(root: string): unknown {
  if (!fs.existsSync(root)) return null;
  return fs.readdirSync(root).sort().map(name => {
    const file = path.join(root, name);
    return fs.statSync(file).isDirectory() ? [name, tree(file)] : [name, fs.readFileSync(file).toString('base64')];
  });
}
