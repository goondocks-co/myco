/**
 * The Cloudflare Deployment lifecycle, orchestrated: what `myco server
 * <verb> --target cloudflare` runs. Every step is a primitive from
 * `cloudflare.js`, every fact lands in the deployment record, and the deploy
 * config is rendered from the record — the record is written before the first
 * deploy so a failure mid-create leaves a record naming what exists.
 *
 * Deploys run from a repository checkout: wrangler bundles `src/index.ts`, so
 * `configDir` must be `packages/myco-server` of a checkout at the version
 * being deployed. The update path that removes this requirement is a later
 * slice of #914.
 */
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { runOrThrow, systemRunner } from './runner.js';
import {
  applyMigrations,
  cloudflareStatus,
  deleteWorker,
  buildAndPushHarnessImage,
  deployWorker,
  ensureBucket,
  ensureDatabase,
  ensureSecretsStore,
  putStoreSecret,
  putWorkerSecretValue,
  readDeploymentRecord,
  writeDeploymentRecord,
  type CloudflareOptions,
  type DeploymentRecord,
} from './cloudflare.js';
import { renderDeployConfig } from './deploy-config.js';

export const DEPLOY_CONFIG_NAME = 'wrangler.deploy.toml';
const WORKER_NAME = 'myco-server';
const DATABASE_NAME = 'myco-server';
const BUCKET_NAME = 'myco-server-blobs';
const WRAP_KEY_SECRET = 'myco-secret-wrap-key';

export interface LifecycleOptions extends Omit<CloudflareOptions, 'configFile'> {
  mycoHome?: string;
}

/** Build what the deploy ships: the dashboard bundle and the harness container entry. A deploy from a checkout that skipped either ships stale artifacts silently. */
async function buildDeployArtifacts(options: LifecycleOptions): Promise<void> {
  const runner = options.runner ?? systemRunner();
  await runOrThrow(runner, 'npm', ['run', 'build:ui'], { cwd: options.configDir });
  await runOrThrow(runner, 'npm', ['run', 'harness:bundle'], { cwd: options.configDir });
}

/** Render the record's deploy config into the checkout and answer its path. */
export function writeDeployConfig(record: DeploymentRecord, configDir: string): string {
  const file = path.join(configDir, DEPLOY_CONFIG_NAME);
  writeFileSync(file, renderDeployConfig(record), { mode: 0o600 });
  return file;
}

export interface CreateResult {
  record: DeploymentRecord;
  createdResources: string[];
  versionId: string | null;
}

/**
 * Provision and deploy. Idempotent: every resource is ensured, an existing
 * record's ids are kept, and a re-run converges on the same Deployment —
 * which also makes this the adopt path for resources created by hand.
 */
export async function createCloudflareDeployment(options: LifecycleOptions): Promise<CreateResult> {
  const existing = readDeploymentRecord(options.mycoHome);
  const createdResources: string[] = [];

  const database = existing?.databaseId !== undefined
    ? { databaseId: existing.databaseId, created: false }
    : await ensureDatabase({ ...options, databaseName: DATABASE_NAME });
  if (database.created) createdResources.push(`d1 ${DATABASE_NAME}`);

  const bucket = await ensureBucket({ ...options, bucketName: BUCKET_NAME });
  if (bucket.created) createdResources.push(`r2 ${BUCKET_NAME}`);

  const store = existing?.storeId !== undefined
    ? { storeId: existing.storeId, created: false }
    : await ensureSecretsStore(options);
  if (store.created) {
    createdResources.push('secrets store');
    await putStoreSecret({ ...options, storeId: store.storeId, name: WRAP_KEY_SECRET, value: randomBytes(32).toString('base64') });
    createdResources.push(`store secret ${WRAP_KEY_SECRET}`);
  }

  let record: DeploymentRecord = {
    accountId: options.accountId,
    workerName: WORKER_NAME,
    databaseName: DATABASE_NAME,
    bucketName: BUCKET_NAME,
    versionId: existing?.versionId ?? null,
    deployedAt: existing?.deployedAt ?? new Date().toISOString(),
    ...(existing?.url !== undefined ? { url: existing.url } : {}),
    databaseId: database.databaseId,
    storeId: store.storeId,
  };
  writeDeploymentRecord(record, options.mycoHome);

  await buildDeployArtifacts(options);
  record = { ...record, harnessImage: await buildAndPushHarnessImage({ ...options, workerName: WORKER_NAME }) };
  writeDeploymentRecord(record, options.mycoHome);
  const configFile = writeDeployConfig(record, options.configDir);
  const withConfig = { ...options, configFile: path.basename(configFile) };

  await applyMigrations({ ...withConfig, databaseName: DATABASE_NAME });
  const deployed = await deployWorker(withConfig);

  // After the first deploy: a secret lands on the live Worker; putting one
  // ahead of a Worker that is not there yet is version-dependent behavior.
  if (existing === null) {
    await putWorkerSecretValue({ ...withConfig, workerName: WORKER_NAME, name: 'SESSION_SECRET', value: randomBytes(32).toString('base64url') });
    createdResources.push('worker secret SESSION_SECRET');
  }

  record = { ...record, versionId: deployed.versionId, deployedAt: new Date().toISOString(), ...(record.url === undefined && deployed.url !== null ? { url: deployed.url } : {}) };
  writeDeploymentRecord(record, options.mycoHome);
  return { record, createdResources, versionId: deployed.versionId };
}

/** Migrate then deploy, in the order the fail-closed schema window expects, and record the version. */
export async function updateCloudflareDeployment(options: LifecycleOptions): Promise<{ versionId: string | null }> {
  const record = readDeploymentRecord(options.mycoHome);
  if (record === null) throw new Error('no Cloudflare deployment record on this machine; `myco server create --target cloudflare` provisions one');
  await buildDeployArtifacts(options);
  const pinned = { ...record, harnessImage: await buildAndPushHarnessImage({ ...options, workerName: record.workerName }) };
  writeDeploymentRecord(pinned, options.mycoHome);
  const configFile = writeDeployConfig(pinned, options.configDir);
  const withConfig = { ...options, configFile: path.basename(configFile) };
  await applyMigrations({ ...withConfig, databaseName: record.databaseName });
  const deployed = await deployWorker(withConfig);
  writeDeploymentRecord({ ...pinned, versionId: deployed.versionId, deployedAt: new Date().toISOString() }, options.mycoHome);
  return { versionId: deployed.versionId };
}

export interface CloudflareDeploymentStatus {
  record: DeploymentRecord;
  deployed: boolean;
  versionId: string | null;
}

export async function cloudflareDeploymentStatus(options: LifecycleOptions): Promise<CloudflareDeploymentStatus | null> {
  const record = readDeploymentRecord(options.mycoHome);
  if (record === null) return null;
  const status = await cloudflareStatus({ ...options, workerName: record.workerName });
  return { record, deployed: status.deployed, versionId: status.versionId };
}

/**
 * Remove the Worker. The database, the bucket, the store, and the record all
 * stand: the Worker is re-creatable from the checkout, the data is not, and
 * data removal stays a by-hand act this command refuses to own.
 */
export async function destroyCloudflareDeployment(options: LifecycleOptions): Promise<{ kept: string[] }> {
  const record = readDeploymentRecord(options.mycoHome);
  if (record === null) throw new Error('no Cloudflare deployment record on this machine; nothing to destroy');
  await deleteWorker({ ...options, workerName: record.workerName });
  return { kept: [`d1 ${record.databaseName}`, `r2 ${record.bucketName}`, 'secrets store', 'the deployment record'] };
}
