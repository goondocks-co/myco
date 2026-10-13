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
import nodeFs from 'node:fs';
const { mkdtempSync, rmSync } = nodeFs;
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  assertWranglerReady,
  CloudflareAuthenticationError,
  isCloudflareAuthenticationRefusal,
  ensureCommandDir,
  cloudflareStatus,
  cloudflareSchemaVersion,
  deploymentRecordPath,
  deleteWorker,
  deployWorker,
  rollbackWorker,
  ensureBucket,
  ensureDatabase,
  ensureSecretsStore,
  ensureVectorIndex,
  accountResourceNames,
  findSecretsStore,
  peekDeploymentRecord,
  deployedWorkerSecretNames,
  putStoreSecret,
  putWorkerSecretValue,
  readDeploymentRecord,
  storeSecretNames,
  workerSecretNames,
  writeDeploymentRecord,
  type CloudflareOptions,
  type DeploymentRecord,
} from './cloudflare.js';
import { stageCloudflareDeploy } from './cloudflare-stage.js';
import { renderDeployConfig } from './deploy-config.js';
import { cloudflareResources } from './cloudflare-resources.js';
import { cloudflareOperation } from './cloudflare-operation.js';
import { applyCloudflareSchema } from './cloudflare-schema.js';
import { getPluginVersion } from '../version.js';
import { systemRunner } from './runner.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';

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

/** One thing `create` would do: a resource or a secret created or kept as it is, the migrations applied, the Worker deployed. */
export interface PlannedStep { kind: string; name: string; action: 'create' | 'reuse' | 'apply' | 'deploy' }

export interface CreatePlan {
  accountId: string;
  steps: PlannedStep[];
  /** Each binding the Worker's configuration declares, as `<kind> <binding>`. */
  bindings: string[];
  /** The address the Deployment is reached at: the named URL, the recorded one, or the Worker's workers.dev address. */
  url: string;
}

/**
 * What `create` would do, without doing any of it: every resource and secret, created or kept, and every binding the
 * Worker's configuration declares. It asks Cloudflare only what exists (lists and `whoami`) and writes nothing there;
 * the configuration is rendered on this machine alone.
 */
export async function planCloudflareDeployment(options: LifecycleOptions & { url?: string }): Promise<CreatePlan> {
  // Wrangler runs in a directory of its own outside the home, removed afterwards, so a plan leaves the home as it found it.
  const configDir = mkdtempSync(path.join(tmpdir(), 'myco-cloudflare-plan-'));
  try {
    await assertWranglerReady({
      ...(options.runner === undefined ? {} : { runner: options.runner }), cwd: configDir,
      ...(options.report === undefined ? {} : { report: options.report }),
    });
    return await planIn(options, configDir);
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

async function planIn(options: LifecycleOptions & { url?: string }, configDir: string): Promise<CreatePlan> {
  const existing = peekDeploymentRecord(options.mycoHome);
  const resources = cloudflareResources(existing ?? {});
  const bare: CloudflareOptions = { ...options, configDir };
  const held = await accountResourceNames(bare);
  const step = (kind: string, name: string, kept: boolean): PlannedStep => ({ kind, name, action: kept ? 'reuse' : 'create' });
  const storeId = existing?.storeId ?? await findSecretsStore(bare);
  const storeSecrets = storeId === null ? [] : await storeSecretNames({ ...bare, storeId });
  const workerSecrets = await deployedWorkerSecretNames({ ...bare, workerName: resources.workerName }) ?? [];
  const steps: PlannedStep[] = [
    step('vectorize index', resources.vectorIndexName, held.vectorIndexes.includes(resources.vectorIndexName)),
    step('d1 database', resources.databaseName, existing?.databaseId !== undefined || held.databases.includes(resources.databaseName)),
    step('r2 bucket', resources.bucketName, held.buckets.includes(resources.bucketName)),
    step('r2 bucket', resources.recoveryBucketName, held.buckets.includes(resources.recoveryBucketName)),
    step('secrets store', 'account secrets store', storeId !== null),
    step('store secret', resources.wrapKeySecretName, storeSecrets.includes(resources.wrapKeySecretName)),
    { kind: 'd1 migrations', name: resources.databaseName, action: 'apply' },
    { kind: 'worker', name: resources.workerName, action: 'deploy' },
    step('worker secret', 'SESSION_SECRET', workerSecrets.includes('SESSION_SECRET')),
  ];
  const planned: DeploymentRecord = {
    accountId: options.accountId, workerName: resources.workerName, databaseName: resources.databaseName, bucketName: resources.bucketName,
    vectorIndexName: resources.vectorIndexName, wrapKeySecretName: resources.wrapKeySecretName, recoveryBucketName: resources.recoveryBucketName,
    versionId: null, deployedAt: new Date(0).toISOString(), databaseId: existing?.databaseId ?? '00000000-0000-0000-0000-000000000000',
    storeId: storeId ?? '0'.repeat(32), ...(options.url ?? existing?.url ? { url: (options.url ?? existing?.url)! } : {}),
  };
  const config = Bun.TOML.parse(renderDeployConfig(planned)) as Record<string, unknown>;
  const list = (value: unknown): Array<Record<string, unknown>> => (Array.isArray(value) ? value as Array<Record<string, unknown>> : []);
  const bindings = [
    ...list(config.d1_databases).map((b) => `d1 ${String(b.binding)}`),
    ...list(config.r2_buckets).map((b) => `r2 ${String(b.binding)}`),
    ...list(config.vectorize).map((b) => `vectorize ${String(b.binding)}`),
    ...(config.ai !== undefined ? [`ai ${String((config.ai as Record<string, unknown>).binding)}`] : []),
    ...list((config.durable_objects as Record<string, unknown> | undefined)?.bindings).map((b) => `durable object ${String(b.name)} (${String(b.class_name)})`),
    ...list(config.secrets_store_secrets).map((b) => `secrets store ${String(b.binding)}`),
    ...list(config.ratelimits).map((b) => `rate limit ${String(b.name)}`),
    ...list((config.triggers as Record<string, unknown> | undefined)?.crons).map((c) => `cron ${String(c)}`),
    ...Object.keys((config.vars as Record<string, unknown> | undefined) ?? {}).map((name) => `var ${name}`),
  ];
  return { accountId: options.accountId, steps, bindings, url: options.url ?? existing?.url ?? `https://${resources.workerName}.<your workers.dev subdomain>` };
}

/**
 * Provision and deploy. Idempotent: every resource is ensured, an existing
 * record's ids are kept, and a re-run converges on the same Deployment —
 * which also makes this the adopt path for resources created by hand.
 */
export const createCloudflareDeployment = cloudflareOperation(async (options: LifecycleOptions & { url?: string }): Promise<CreateResult> => {
  await preflight(options);
  const existing = readDeploymentRecord(options.mycoHome);
  if (existing !== null && existing.accountId !== options.accountId) throw new Error('schema update refused: selected account does not match the deployment record');
  const resources = cloudflareResources(existing ?? {});
  const createdResources: string[] = [];
  const bare = bareCommand(options);
  const database = existing?.databaseId !== undefined
    ? { databaseId: existing.databaseId, created: false }
    : await ensureDatabase({ ...bare, databaseName: resources.databaseName });
  if (database.created) createdResources.push(`d1 ${resources.databaseName}`);
  const url = options.url ?? existing?.url;
  let record: DeploymentRecord = {
    accountId: options.accountId, workerName: resources.workerName, databaseName: resources.databaseName,
    bucketName: resources.bucketName, vectorIndexName: resources.vectorIndexName,
    wrapKeySecretName: resources.wrapKeySecretName, recoveryBucketName: resources.recoveryBucketName,
    versionId: existing?.versionId ?? null, deployedAt: existing?.deployedAt ?? new Date().toISOString(),
    ...(existing?.release === undefined ? {} : { release: existing.release }),
    ...(existing?.fleet === undefined ? {} : { fleet: existing.fleet }),
    ...(url === undefined ? {} : { url }), databaseId: database.databaseId,
    ...(existing?.storeId === undefined ? {} : { storeId: existing.storeId }),
    ...(existing?.schemaUpdates === undefined ? {} : { schemaUpdates: existing.schemaUpdates }),
  };
  if (database.created) writeDeploymentRecord(record, options.mycoHome);
  const withConfig = staged(record, options);
  record = await applyCloudflareSchema({ ...withConfig, record, freshDatabase: database.created,
    persist: (next) => writeDeploymentRecord(next, options.mycoHome),
    prepare: async (admitted) => {
      if ((await ensureVectorIndex({ ...bare, vectorIndexName: resources.vectorIndexName })).created) createdResources.push(`vectorize ${resources.vectorIndexName}`);
      const bucket = await ensureBucket({ ...bare, bucketName: resources.bucketName });
      if (bucket.created) createdResources.push(`r2 ${resources.bucketName}`);

      // The staging store the Deployment's config binds for a recovery export. It is ensured here with every other
      // resource the config names, and it is never the store the Deployment serves blobs from.
      const staging = await ensureBucket({ ...bare, bucketName: resources.recoveryBucketName });
      if (staging.created) createdResources.push(`r2 ${resources.recoveryBucketName}`);

      const store = existing?.storeId !== undefined
        ? { storeId: existing.storeId, created: false }
        : await ensureSecretsStore(bare);
      if (store.created) createdResources.push('secrets store');
      // The wrapping key is put wherever the store lacks it, a store the account already held included. One the store holds
      // stays: every sealed credential is wrapped with it.
      if (store.created || !(await storeSecretNames({ ...bare, storeId: store.storeId })).includes(resources.wrapKeySecretName)) {
        await putStoreSecret({ ...bare, storeId: store.storeId, name: resources.wrapKeySecretName, value: randomBytes(32).toString('base64') });
        createdResources.push(`store secret ${resources.wrapKeySecretName}`);
      }

      const prepared = { ...admitted, storeId: store.storeId };
      writeDeploymentRecord(prepared, options.mycoHome);
      staged(prepared, options);
      return prepared;
    },
  });
  const deployed = await deployWorker(withConfig);

  // After the deploy: a secret lands on the live Worker; putting one ahead of a Worker that is not there yet is
  // version-dependent behavior. It is put wherever the Worker lacks it, so a first create that stopped after writing its
  // record gets one on the re-run. One the Worker holds stays: it signs every session.
  if (!(await workerSecretNames({ ...withConfig, workerName: resources.workerName })).includes('SESSION_SECRET')) {
    await putWorkerSecretValue({ ...withConfig, workerName: resources.workerName, name: 'SESSION_SECRET', value: randomBytes(32).toString('base64url') });
    createdResources.push('worker secret SESSION_SECRET');
  }

  record = { ...record, release: getPluginVersion(), versionId: deployed.versionId, deployedAt: new Date().toISOString(), ...(record.url === undefined && deployed.url !== null ? { url: deployed.url } : {}) };
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
export interface CloudflareUpdateSummary {
  releaseBefore: string | undefined;
  releaseTarget: string;
  schemaBefore: number | null;
  schemaTarget: number;
  schema: 'not attempted' | 'attempted; outcome unknown' | 'refused: not applied' | 'applied' | 'unchanged';
  worker: 'not attempted' | 'attempted; outcome unknown' | 'refused: not applied' | 'applied';
  record: 'updated' | 'not updated';
  resources: Array<{ operation: string; state: 'attempted; outcome unknown' | 'refused: not applied' | 'applied' | 'already exists' }>;
  recordPath: string;
  bookmark?: string;
}

/** The same summary is printed for successful and interrupted hosted updates. */
export function cloudflareUpdateLines(summary: CloudflareUpdateSummary): string[] {
  const resultingRelease = summary.worker === 'applied' ? summary.releaseTarget
    : ['not attempted', 'refused: not applied'].includes(summary.worker) ? summary.releaseBefore ?? 'unknown' : 'unknown';
  const resultingSchema = summary.schema === 'applied' ? summary.schemaTarget
    : summary.schema === 'attempted; outcome unknown' ? 'unknown' : summary.schemaBefore ?? 'unknown';
  const lines = [
    `Cloudflare update (releases recorded before update or acknowledged by deploy; schemas observed or acknowledged): from ${summary.releaseBefore ?? 'unknown'}/${summary.schemaBefore ?? 'unknown'} to ${resultingRelease}/${resultingSchema}.`,
    `  Schema: ${summary.schema} (target ${summary.schemaTarget}).`,
    `  Worker: ${summary.worker} (target release ${summary.releaseTarget}).`,
    `  Local deployment record: ${summary.record}.`,
    `  Resources: ${summary.resources.length === 0 ? 'no changes attempted' : summary.resources.map((r) => `${r.operation}: ${r.state}`).join('; ')}.`,
    summary.bookmark === undefined ? '  No new recovery bookmark recorded.' : `  Bookmark ${summary.bookmark} recorded in ${summary.recordPath}.`,
  ];
  if (['not attempted', 'refused: not applied'].includes(summary.worker) && ['not attempted', 'unchanged', 'refused: not applied'].includes(summary.schema)
    && summary.resources.every((r) => ['already exists', 'refused: not applied'].includes(r.state))) {
    lines.push('Nothing changed in Cloudflare; a rerun is safe. A recorded bookmark is a recovery point, not an applied migration.');
  } else if (summary.schema.includes('unknown') || summary.worker.includes('unknown') || summary.resources.some((r) => r.state.includes('unknown'))) {
    lines.push('An attempted change has an unknown outcome; run myco server status --target cloudflare before retrying.');
  }
  if (summary.worker === 'applied' && summary.record === 'not updated') {
    lines.push('The Worker is live; the local record was not updated; rerun myco server update --target cloudflare or check myco server status --target cloudflare.');
  }
  return lines;
}

export const updateCloudflareDeployment = cloudflareOperation(async (options: LifecycleOptions): Promise<{ versionId: string | null; summary: CloudflareUpdateSummary }> => {
  const summary: CloudflareUpdateSummary = {
    releaseBefore: undefined, releaseTarget: getPluginVersion(), schemaBefore: null, schemaTarget: SERVER_SCHEMA_VERSION,
    schema: 'not attempted', worker: 'not attempted', record: 'not updated', resources: [], recordPath: deploymentRecordPath(options.mycoHome),
  };
  const runner = options.runner ?? systemRunner();
  options = { ...options, runner: {
    async run(command, args, runOptions) {
      const [product, action] = args.slice(2);
      const operation = product === 'r2' && args[4] === 'create' ? `r2 bucket ${args[5]}`
        : product === 'vectorize' && action === 'create' ? `vectorize index ${args[4]}`
        : product === 'vectorize' && action === 'create-metadata-index'
          ? `vectorize filter ${args[args.indexOf('--propertyName') + 1]} on ${args[4]}` : undefined;
      const entry: CloudflareUpdateSummary['resources'][number] | undefined = operation === undefined
        ? undefined : { operation, state: 'attempted; outcome unknown' };
      if (entry !== undefined) summary.resources.push(entry);
      const result = await runner.run(command, args, runOptions);
      if (entry !== undefined) {
        if (result.code === 0) entry.state = 'applied';
        else if (isCloudflareAuthenticationRefusal(result)) entry.state = 'refused: not applied';
        else if (/already (exists|owned)/i.test(result.stdout + result.stderr)) entry.state = 'already exists';
      }
      return result;
    },
  } };
  try {
    let record = readDeploymentRecord(options.mycoHome);
    if (record === null) throw new Error('no Cloudflare deployment record on this machine; `myco server create --target cloudflare` provisions one');
    summary.releaseBefore = record.release;
    await preflight(options);
    if (options.accountId !== record.accountId) throw new Error('schema update refused: selected account does not match the deployment record');
    const resources = cloudflareResources(record);
    const withConfig = staged(record, options);
    record = await applyCloudflareSchema({ ...withConfig, record,
      persist: (next) => {
        writeDeploymentRecord(next, options.mycoHome);
        if ((next.schemaUpdates?.length ?? 0) > (record!.schemaUpdates?.length ?? 0)) summary.bookmark = next.schemaUpdates!.at(-1)!.bookmark;
      },
      observe: ({ phase, before, after }) => {
        summary.schemaBefore = before;
        if (phase === 'observed') summary.schema = before === after ? 'unchanged' : 'not attempted';
        else summary.schema = phase === 'applied' ? 'applied' : 'attempted; outcome unknown';
      },
      prepare: async (admitted) => {
        await ensureVectorIndex({ ...bareCommand(options), vectorIndexName: resources.vectorIndexName });
        await ensureBucket({ ...bareCommand(options), bucketName: resources.recoveryBucketName });
        return admitted;
      },
    });
    summary.worker = 'attempted; outcome unknown';
    const deployed = await deployWorker(withConfig);
    summary.worker = 'applied';

    writeDeploymentRecord({
      ...record, recoveryBucketName: resources.recoveryBucketName,
      release: summary.releaseTarget, versionId: deployed.versionId, deployedAt: new Date().toISOString(),
    }, options.mycoHome);
    summary.record = 'updated';
    return { versionId: deployed.versionId, summary };
  } catch (cause) {
    if (cause instanceof CloudflareAuthenticationError) {
      if (summary.schema === 'attempted; outcome unknown') summary.schema = 'refused: not applied';
      if (summary.worker === 'attempted; outcome unknown') summary.worker = 'refused: not applied';
    }
    for (const line of cloudflareUpdateLines(summary)) options.report?.(line);
    throw cause;
  }
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
  writeDeploymentRecord({ ...record, release: undefined, versionId: target, deployedAt: new Date().toISOString() }, options.mycoHome);
  return { versionId: target };
});

export interface CloudflareDeploymentStatus {
  record: DeploymentRecord;
  deployed: boolean;
  versionId: string | null;
  schema: number | null;
  workerError: string | null;
  schemaError: string | null;
}

export async function cloudflareDeploymentStatus(options: LifecycleOptions): Promise<CloudflareDeploymentStatus | null> {
  await preflight(options);
  const record = readDeploymentRecord(options.mycoHome);
  if (record === null) return null;
  if (options.accountId !== record.accountId) throw new Error('status refused: selected account does not match the deployment record');
  const [worker, schema] = await Promise.allSettled([
    cloudflareStatus({ ...bareCommand(options), workerName: record.workerName }),
    cloudflareSchemaVersion({ ...bareCommand(options), databaseName: record.databaseName }),
  ]);
  const detail = (error: unknown): string => error instanceof Error ? error.message : String(error);
  return { record, deployed: worker.status === 'fulfilled' && worker.value.deployed,
    versionId: worker.status === 'fulfilled' ? worker.value.versionId : null,
    schema: schema.status === 'fulfilled' ? schema.value : null,
    workerError: worker.status === 'rejected' ? detail(worker.reason) : null,
    schemaError: schema.status === 'rejected' ? detail(schema.reason) : null };
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
