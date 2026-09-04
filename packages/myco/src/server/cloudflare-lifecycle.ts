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
  containerApplicationId,
  containerRollout,
  deleteWorker,
  buildAndPushHarnessImage,
  deployWorker,
  readLiveRuns,
  rollbackWorker,
  rollsContainers,
  ensureBucket,
  ensureDatabase,
  ensureSecretsStore,
  putStoreSecret,
  putWorkerSecretValue,
  readDeploymentRecord,
  writeDeploymentRecord,
  type CloudflareOptions,
  type DeploymentRecord,
  type LiveRun,
} from './cloudflare.js';
import { renderDeployConfig } from './deploy-config.js';

export const DEPLOY_CONFIG_NAME = 'wrangler.deploy.toml';
const WORKER_NAME = 'myco-server';
const DATABASE_NAME = 'myco-server';
const BUCKET_NAME = 'myco-server-blobs';
const WRAP_KEY_SECRET = 'myco-secret-wrap-key';

/**
 * How long a run may outlive its own bound before the Deployment gives up on
 * it. Mirrors `RUN_OVERRUN_MARGIN_MS` in
 * `packages/myco-server/src/core/harness.ts`; this package ships to operator
 * machines and imports nothing from the Worker, so the number is copied and
 * held equal by `tests/server/cloudflare-lifecycle.test.ts`.
 */
export const RUN_OVERRUN_MARGIN_MS = 120_000;

/**
 * The budget a run carries when its context names none. Mirrors
 * `DEFAULT_DISPATCH_TIMEOUT_SECONDS` in
 * `packages/myco-server/src/core/harness.ts`, held equal by the same test.
 */
export const DEFAULT_RUN_TIMEOUT_SECONDS = 300;

/**
 * The longest a rollout is watched. Mirrors the largest budget in
 * `TASK_RUN_TIMEOUT_SECONDS` in
 * `packages/myco-server/src/core/task-catalogue.ts`, held equal by the same
 * test: an instance carrying the longest-running task is spared until its
 * budget is spent, so a rollout cannot finish before then.
 */
export const ROLLOUT_WATCH_TIMEOUT_SECONDS = 1800;

/** How often the wait asks the Deployment what is still running. */
const LIVE_RUN_POLL_MS = 15_000;
/** How often the watch asks the container application where the rollout stands. */
const ROLLOUT_POLL_MS = 20_000;

/** How the wait and the watch spend time; a test drives both without spending any. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }),
};

export interface LifecycleOptions extends Omit<CloudflareOptions, 'configFile'> {
  mycoHome?: string;
  /** Whether the deploy waits for the runs in flight before it ships; `--no-drain` turns it off. */
  drain?: boolean;
  /** Where the wait and the watch say where they are, as they get there. */
  report?: (line: string) => void;
  clock?: Clock;
}

/** A duration in the words an operator waiting on it would use. */
function describeDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds} sec`;
  return `${Math.round(seconds / 60)} min`;
}

/** The budget a run gets: its own, or the dispatcher's default for a run that names none. */
function budgetSeconds(run: LiveRun): number {
  return run.timeoutSeconds ?? DEFAULT_RUN_TIMEOUT_SECONDS;
}

/**
 * Wait for the runs in flight to end before the deploy replaces the instances
 * carrying them.
 *
 * The platform drains a replaced instance and the container application spares
 * a run inside its own budget, so this is not what keeps a run alive — it is
 * what keeps the operator's deploy from racing them. The bound is the runs read
 * at the first look: each is given its own budget plus the margin the
 * Deployment gives it, and past that the run has outlived what anyone promised
 * it, so the deploy goes ahead and the stale sweep owns the row.
 */
async function waitForLiveRuns(
  options: LifecycleOptions & { configFile: string; databaseName: string },
): Promise<void> {
  const report = options.report ?? console.log;
  const clock = options.clock ?? systemClock;
  if (options.drain === false) {
    report('Not waiting for the runs in flight: the platform drains what is running.');
    return;
  }

  let live = await readLiveRuns(options);
  if (live.length === 0) return;
  for (const run of live) {
    report(`Waiting for a running task: ${run.task}, started ${describeDuration(clock.now() - run.startedAt)} ago, budget ${describeDuration(budgetSeconds(run) * 1000)}`);
  }
  const deadline = Math.max(...live.map((run) => run.startedAt + budgetSeconds(run) * 1000 + RUN_OVERRUN_MARGIN_MS));

  while (live.length > 0) {
    if (clock.now() >= deadline) {
      report(`A running task outlived its own budget (${live.map((run) => run.task).join(', ')}); the deploy proceeds and the stale sweep owns the run.`);
      return;
    }
    await clock.sleep(LIVE_RUN_POLL_MS);
    live = await readLiveRuns(options);
  }
  report('Nothing is running; the deploy proceeds.');
}

/**
 * Watch the container instances reach the version the deploy just shipped.
 *
 * `wrangler deploy` returns when the application has accepted the new image,
 * not when the instances carry it, and a run dispatched in between lands on an
 * instance the platform has yet to replace. The application answers its version
 * and how many of its instances are healthy; the rollout is over when the
 * version has moved past what stood before the deploy and every instance is
 * healthy again.
 *
 * The bound is the longest task budget: an instance carrying a run is spared
 * until that run's budget is spent, so a rollout cannot outlast it by anything
 * the deploy is responsible for. Past the bound the deploy still succeeded, so
 * this says where the rollout stands and answers nothing.
 */
async function watchRollout(
  options: LifecycleOptions & { applicationId: string; versionBefore: number },
): Promise<{ version: number; completedAt: string } | null> {
  const report = options.report ?? console.log;
  const clock = options.clock ?? systemClock;
  const deadline = clock.now() + ROLLOUT_WATCH_TIMEOUT_SECONDS * 1000;
  let said = '';

  for (;;) {
    const state = await containerRollout(options);
    if (state !== null && state.version > options.versionBefore) {
      if (state.healthy >= state.instances) {
        report('Rollout complete.');
        return { version: state.version, completedAt: new Date(clock.now()).toISOString() };
      }
      const line = `Rolling out: ${state.healthy} of ${state.instances} instances on the new version`;
      if (line !== said) { report(line); said = line; }
    }
    if (clock.now() >= deadline) {
      report('The rollout is still in progress; a run started now may land on an instance still on the old version.');
      return null;
    }
    await clock.sleep(ROLLOUT_POLL_MS);
  }
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
  const deployed = await deployWorker({ ...withConfig, pushedImage: record.harnessImage, ...(existing?.harnessImage === undefined ? {} : { deployedImage: existing.harnessImage }) });

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
 * A deploy that replaces the container instances is bracketed by what those
 * instances are doing: the runs in flight are waited out before the image is
 * pushed, and the instances are watched onto the new version afterwards, so
 * the operator's command ends when the Deployment is actually on the version
 * it reports.
 */
export async function updateCloudflareDeployment(options: LifecycleOptions): Promise<{ versionId: string | null }> {
  const record = readDeploymentRecord(options.mycoHome);
  if (record === null) throw new Error('no Cloudflare deployment record on this machine; `myco server create --target cloudflare` provisions one');
  await buildDeployArtifacts(options);

  // The wait reads the Deployment's own database, which wrangler addresses by
  // name only through a config carrying its id. Rendering the record's config
  // here also refuses a record that cannot address its database before the
  // push rather than after it.
  const configFile = path.basename(writeDeployConfig(record, options.configDir));
  await waitForLiveRuns({ ...options, configFile, databaseName: record.databaseName });

  const pinned = { ...record, harnessImage: await buildAndPushHarnessImage({ ...options, workerName: record.workerName }) };
  writeDeploymentRecord(pinned, options.mycoHome);
  writeDeployConfig(pinned, options.configDir);
  const withConfig = { ...options, configFile };
  await applyMigrations({ ...withConfig, databaseName: record.databaseName });

  // The version the instances carry has to be read before the deploy: the
  // rollout is over when they carry a later one. A push of the image already
  // running rolls nothing, and asks the application nothing.
  const willRoll = rollsContainers(pinned.harnessImage, record.harnessImage);
  const applicationId = willRoll ? await containerApplicationId({ ...withConfig, workerName: record.workerName }) : null;
  const before = applicationId === null ? null : await containerRollout({ ...withConfig, applicationId });

  const deployed = await deployWorker({ ...withConfig, pushedImage: pinned.harnessImage, ...(record.harnessImage === undefined ? {} : { deployedImage: record.harnessImage }) });

  const report = options.report ?? console.log;
  let rollout: { version: number; completedAt: string } | null = null;
  if (!deployed.rolled) report('No container rollout (image unchanged).');
  else if (applicationId === null || before === null) report('No container application answers yet; the instances carry the new image as they start.');
  else rollout = await watchRollout({ ...withConfig, applicationId, versionBefore: before.version });

  writeDeploymentRecord({
    ...pinned,
    versionId: deployed.versionId,
    deployedAt: new Date().toISOString(),
    ...(rollout === null ? {} : { lastRollout: rollout }),
  }, options.mycoHome);
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
  const record = readDeploymentRecord(options.mycoHome);
  if (record === null) throw new Error('no Cloudflare deployment record on this machine; nothing to roll back');
  const target = options.versionId ?? record.versionId ?? '';
  if (target === '') throw new Error('no version to roll back to: pass --version <id> (`wrangler deployments list` names them)');
  await rollbackWorker({ ...options, workerName: record.workerName, versionId: target, message: options.message ?? 'myco server rollback' });
  writeDeploymentRecord({ ...record, versionId: target, deployedAt: new Date().toISOString() }, options.mycoHome);
  return { versionId: target };
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
