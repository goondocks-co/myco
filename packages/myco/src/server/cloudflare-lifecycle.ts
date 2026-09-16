/**
 * The Cloudflare Deployment lifecycle, orchestrated: what `myco server
 * <verb> --target cloudflare` runs. Every step is a primitive from
 * `cloudflare.js`, every fact lands in the deployment record, and the deploy
 * config is rendered from the record — the record is written before the first
 * deploy so a failure mid-create leaves a record naming what exists.
 *
 * Deploys run from a staged directory this binary writes, never from a
 * repository checkout: the Worker bundle, the dashboard and the migration
 * files are all artifacts the binary carries. Node and wrangler are the only
 * prerequisites, and only on the operator's own machine.
 */
import { randomBytes } from 'node:crypto';
import {
  applyMigrations,
  assertWranglerReady,
  ensureCommandDir,
  cloudflareStatus,
  deleteWorker,
  deployWorker,
  rollbackWorker,
  ensureBucket,
  ensureDatabase,
  ensureSecretsStore,
  ensureVectorIndex,
  putStoreSecret,
  putWorkerSecretValue,
  readDeploymentRecord,
  writeDeploymentRecord,
  type CloudflareOptions,
  type DeploymentRecord,
} from './cloudflare.js';
import { stageCloudflareDeploy } from './cloudflare-stage.js';
import { cloudflareResources } from './cloudflare-resources.js';
import { cloudflareOperation } from './cloudflare-operation.js';

export { DEPLOY_CONFIG_NAME } from './cloudflare-stage.js';

export interface LifecycleOptions extends Omit<CloudflareOptions, 'configFile' | 'configDir'> {
  mycoHome?: string;
  /** Where the lifecycle says where it is, as it gets there. */
  report?: (line: string) => void;
}

/**
 * Stage this record's deploy directory and answer the options every wrangler
 * command in the deploy runs under. One render, so the config a deploy reads
 * and the record it came from can never describe different deployments.
 */
function staged(record: DeploymentRecord, options: LifecycleOptions): CloudflareOptions {
  const stage = stageCloudflareDeploy(record, options.mycoHome);
  return { ...options, configDir: stage.dir, configFile: stage.configFile };
}

/**
 * Where a command that names its own resource runs.
 *
 * Wrangler walks UP from its working directory looking for a configuration, so
 * running these from wherever the operator happens to stand can pick up a
 * checkout's `wrangler.toml` — the second config source this target no longer
 * has. This directory is the binary's own, holds no configuration, and is on
 * disk before any command is pointed at it.
 */
function bareCommand(options: LifecycleOptions): CloudflareOptions {
  return { ...options, configDir: ensureCommandDir(options.mycoHome) };
}

/**
 * What every verb here needs before it runs anything, checked once, first.
 *
 * The first command a fresh machine runs is the one that reports the machine's
 * state — as wrangler's own message about a missing environment variable, or as
 * a version `npx` fetched to answer with. Both are refused by name instead, and
 * the check runs in the directory the commands run in, so what it clears is
 * what they get.
 */
async function preflight(options: LifecycleOptions): Promise<void> {
  await assertWranglerReady({
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    cwd: ensureCommandDir(options.mycoHome),
    ...(options.report === undefined ? {} : { report: options.report }),
  });
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
export const createCloudflareDeployment = cloudflareOperation(async (options: LifecycleOptions & { url?: string }): Promise<CreateResult> => {
  await preflight(options);
  const existing = readDeploymentRecord(options.mycoHome);
  const resources = cloudflareResources(existing ?? {});
  const createdResources: string[] = [];
  const bare = bareCommand(options);
  if ((await ensureVectorIndex({ ...bare, vectorIndexName: resources.vectorIndexName })).created) createdResources.push(`vectorize ${resources.vectorIndexName}`);

  const database = existing?.databaseId !== undefined
    ? { databaseId: existing.databaseId, created: false }
    : await ensureDatabase({ ...bare, databaseName: resources.databaseName });
  if (database.created) createdResources.push(`d1 ${resources.databaseName}`);

  const bucket = await ensureBucket({ ...bare, bucketName: resources.bucketName });
  if (bucket.created) createdResources.push(`r2 ${resources.bucketName}`);

  // The staging store the Deployment's config binds for a recovery export. It is ensured here with every other
  // resource the config names, and it is never the store the Deployment serves blobs from.
  const staging = await ensureBucket({ ...bare, bucketName: resources.recoveryBucketName });
  if (staging.created) createdResources.push(`r2 ${resources.recoveryBucketName}`);

  const store = existing?.storeId !== undefined
    ? { storeId: existing.storeId, created: false }
    : await ensureSecretsStore(bare);
  if (store.created) {
    createdResources.push('secrets store');
    await putStoreSecret({ ...bare, storeId: store.storeId, name: resources.wrapKeySecretName, value: randomBytes(32).toString('base64') });
    createdResources.push(`store secret ${resources.wrapKeySecretName}`);
  }

  // The URL the operator named is the Deployment's from the first deploy, so
  // the custom domain and the origin the clock calls back to are provisioned
  // together rather than needing a second pass.
  const url = options.url ?? existing?.url;
  let record: DeploymentRecord = {
    accountId: options.accountId,
    workerName: resources.workerName,
    databaseName: resources.databaseName,
    bucketName: resources.bucketName,
    vectorIndexName: resources.vectorIndexName,
    wrapKeySecretName: resources.wrapKeySecretName,
    recoveryBucketName: resources.recoveryBucketName,
    versionId: existing?.versionId ?? null,
    deployedAt: existing?.deployedAt ?? new Date().toISOString(),
    ...(existing?.fleet === undefined ? {} : { fleet: existing.fleet }),
    ...(url === undefined ? {} : { url }),
    databaseId: database.databaseId,
    storeId: store.storeId,
  };
  writeDeploymentRecord(record, options.mycoHome);

  const withConfig = staged(record, options);
  await applyMigrations({ ...withConfig, databaseName: resources.databaseName });
  const deployed = await deployWorker(withConfig);

  // After the first deploy: a secret lands on the live Worker; putting one
  // ahead of a Worker that is not there yet is version-dependent behavior.
  if (existing === null) {
    await putWorkerSecretValue({ ...withConfig, workerName: resources.workerName, name: 'SESSION_SECRET', value: randomBytes(32).toString('base64url') });
    createdResources.push('worker secret SESSION_SECRET');
  }

  record = { ...record, versionId: deployed.versionId, deployedAt: new Date().toISOString(), ...(record.url === undefined && deployed.url !== null ? { url: deployed.url } : {}) };
  writeDeploymentRecord(record, options.mycoHome);
  return { record, createdResources, versionId: deployed.versionId };
});

/**
 * Migrate then deploy, in the order the fail-closed schema window expects, and
 * record the version.
 *
 * Nothing is waited for: the Worker carries no runtime, so a deploy replaces
 * nothing that holds a run. A request in flight finishes on the version that
 * took it, and a run executes on a worker attached from elsewhere that this
 * command never touches.
 */
export const updateCloudflareDeployment = cloudflareOperation(async (options: LifecycleOptions): Promise<{ versionId: string | null }> => {
  await preflight(options);
  const record = readDeploymentRecord(options.mycoHome);
  if (record === null) throw new Error('no Cloudflare deployment record on this machine; `myco server create --target cloudflare` provisions one');
  const resources = cloudflareResources(record);
  await ensureVectorIndex({ ...bareCommand(options), vectorIndexName: resources.vectorIndexName });
  await ensureBucket({ ...bareCommand(options), bucketName: resources.recoveryBucketName });

  const withConfig = staged(record, options);
  await applyMigrations({ ...withConfig, databaseName: record.databaseName });
  const deployed = await deployWorker(withConfig);

  writeDeploymentRecord({
    ...record, recoveryBucketName: resources.recoveryBucketName,
    versionId: deployed.versionId, deployedAt: new Date().toISOString(),
  }, options.mycoHome);
  return { versionId: deployed.versionId };
});

/**
 * Return the Worker to an earlier version.
 *
 * The target defaults to the record's last recorded version — a failed update
 * never records one, so after a deploy that threw, the record still names the
 * version that served. A deploy that succeeded and then failed its smoke has
 * already recorded the bad version, and that caller passes the pre-deploy
 * version it captured.
 */
export const rollbackCloudflareDeployment = cloudflareOperation(async (options: LifecycleOptions & { versionId?: string; message?: string }): Promise<{ versionId: string }> => {
  await preflight(options);
  const record = readDeploymentRecord(options.mycoHome);
  if (record === null) throw new Error('no Cloudflare deployment record on this machine; nothing to roll back');
  const target = options.versionId ?? record.versionId ?? '';
  if (target === '') throw new Error('no version to roll back to: pass --version <id> (`wrangler deployments list` names them)');
  await rollbackWorker({ ...bareCommand(options), workerName: record.workerName, versionId: target, message: options.message ?? 'myco server rollback' });
  writeDeploymentRecord({ ...record, versionId: target, deployedAt: new Date().toISOString() }, options.mycoHome);
  return { versionId: target };
});

export interface CloudflareDeploymentStatus {
  record: DeploymentRecord;
  deployed: boolean;
  versionId: string | null;
}

export async function cloudflareDeploymentStatus(options: LifecycleOptions): Promise<CloudflareDeploymentStatus | null> {
  await preflight(options);
  const record = readDeploymentRecord(options.mycoHome);
  if (record === null) return null;
  const status = await cloudflareStatus({ ...bareCommand(options), workerName: record.workerName });
  return { record, deployed: status.deployed, versionId: status.versionId };
}

/**
 * Remove the Worker. The database, the bucket, the store, and the record all
 * stand: the Worker is re-creatable from the binary, the data is not, and
 * data removal stays a by-hand act this command refuses to own.
 */
export const destroyCloudflareDeployment = cloudflareOperation(async (options: LifecycleOptions): Promise<{ kept: string[] }> => {
  await preflight(options);
  const record = readDeploymentRecord(options.mycoHome);
  if (record === null) throw new Error('no Cloudflare deployment record on this machine; nothing to destroy');
  const resources = cloudflareResources(record);
  await deleteWorker({ ...bareCommand(options), workerName: record.workerName });
  return { kept: [`d1 ${record.databaseName}`, `r2 ${record.bucketName}`, `r2 ${resources.recoveryBucketName}`, `vectorize ${resources.vectorIndexName}`, 'secrets store', 'the deployment record'] };
});
