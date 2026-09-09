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
import { VECTOR_INDEX_NAME } from './vector-config.js';

export { DEPLOY_CONFIG_NAME } from './cloudflare-stage.js';

const WORKER_NAME = 'myco-server';
const DATABASE_NAME = 'myco-server';
const BUCKET_NAME = 'myco-server-blobs';
const WRAP_KEY_SECRET = 'myco-secret-wrap-key';

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
export async function createCloudflareDeployment(options: LifecycleOptions & { url?: string }): Promise<CreateResult> {
  await preflight(options);
  const existing = readDeploymentRecord(options.mycoHome);
  const createdResources: string[] = [];
  const bare = bareCommand(options);
  if ((await ensureVectorIndex(bare)).created) createdResources.push(`vectorize ${VECTOR_INDEX_NAME}`);

  const database = existing?.databaseId !== undefined
    ? { databaseId: existing.databaseId, created: false }
    : await ensureDatabase({ ...bare, databaseName: DATABASE_NAME });
  if (database.created) createdResources.push(`d1 ${DATABASE_NAME}`);

  const bucket = await ensureBucket({ ...bare, bucketName: BUCKET_NAME });
  if (bucket.created) createdResources.push(`r2 ${BUCKET_NAME}`);

  const store = existing?.storeId !== undefined
    ? { storeId: existing.storeId, created: false }
    : await ensureSecretsStore(bare);
  if (store.created) {
    createdResources.push('secrets store');
    await putStoreSecret({ ...bare, storeId: store.storeId, name: WRAP_KEY_SECRET, value: randomBytes(32).toString('base64') });
    createdResources.push(`store secret ${WRAP_KEY_SECRET}`);
  }

  // The URL the operator named is the Deployment's from the first deploy, so
  // the custom domain and the origin the clock calls back to are provisioned
  // together rather than needing a second pass.
  const url = options.url ?? existing?.url;
  let record: DeploymentRecord = {
    accountId: options.accountId,
    workerName: WORKER_NAME,
    databaseName: DATABASE_NAME,
    bucketName: BUCKET_NAME,
    versionId: existing?.versionId ?? null,
    deployedAt: existing?.deployedAt ?? new Date().toISOString(),
    ...(url === undefined ? {} : { url }),
    databaseId: database.databaseId,
    storeId: store.storeId,
  };
  writeDeploymentRecord(record, options.mycoHome);

  const withConfig = staged(record, options);
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

/**
 * Migrate then deploy, in the order the fail-closed schema window expects, and
 * record the version.
 *
 * Nothing is waited for: the Worker carries no runtime, so a deploy replaces
 * nothing that holds a run. A request in flight finishes on the version that
 * took it, and a run executes on a worker attached from elsewhere that this
 * command never touches.
 */
export async function updateCloudflareDeployment(options: LifecycleOptions): Promise<{ versionId: string | null }> {
  await preflight(options);
  const record = readDeploymentRecord(options.mycoHome);
  if (record === null) throw new Error('no Cloudflare deployment record on this machine; `myco server create --target cloudflare` provisions one');
  await ensureVectorIndex(bareCommand(options));

  const withConfig = staged(record, options);
  await applyMigrations({ ...withConfig, databaseName: record.databaseName });
  const deployed = await deployWorker(withConfig);

  writeDeploymentRecord({ ...record, versionId: deployed.versionId, deployedAt: new Date().toISOString() }, options.mycoHome);
  return { versionId: deployed.versionId };
}

/**
 * Return the Worker to an earlier version.
 *
 * The target defaults to the record's last recorded version — a failed update
 * never records one, so after a deploy that threw, the record still names the
 * version that served. A deploy that succeeded and then failed its smoke has
 * already recorded the bad version, and that caller passes the pre-deploy
 * version it captured.
 */
export async function rollbackCloudflareDeployment(options: LifecycleOptions & { versionId?: string; message?: string }): Promise<{ versionId: string }> {
  await preflight(options);
  const record = readDeploymentRecord(options.mycoHome);
  if (record === null) throw new Error('no Cloudflare deployment record on this machine; nothing to roll back');
  const target = options.versionId ?? record.versionId ?? '';
  if (target === '') throw new Error('no version to roll back to: pass --version <id> (`wrangler deployments list` names them)');
  await rollbackWorker({ ...bareCommand(options), workerName: record.workerName, versionId: target, message: options.message ?? 'myco server rollback' });
  writeDeploymentRecord({ ...record, versionId: target, deployedAt: new Date().toISOString() }, options.mycoHome);
  return { versionId: target };
}

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
export async function destroyCloudflareDeployment(options: LifecycleOptions): Promise<{ kept: string[] }> {
  await preflight(options);
  const record = readDeploymentRecord(options.mycoHome);
  if (record === null) throw new Error('no Cloudflare deployment record on this machine; nothing to destroy');
  await deleteWorker({ ...bareCommand(options), workerName: record.workerName });
  return { kept: [`d1 ${record.databaseName}`, `r2 ${record.bucketName}`, `vectorize ${VECTOR_INDEX_NAME}`, 'secrets store', 'the deployment record'] };
}
