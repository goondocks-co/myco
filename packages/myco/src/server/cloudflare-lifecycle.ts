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
import { describeFailure, runOrThrow, systemRunner } from './runner.js';
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
  ensureVectorIndex,
  putStoreSecret,
  putWorkerSecretValue,
  readDeploymentRecord,
  writeDeploymentRecord,
  type CloudflareOptions,
  type ContainerRollout,
  type DeploymentRecord,
} from './cloudflare.js';
import { systemClock, waitForLiveRuns, type Clock } from './live-runs.js';
import { containersTableHash, renderDeployConfig } from './deploy-config.js';
import { VECTOR_INDEX_NAME } from './vector-config.js';

// The wait, its bounds, and the clock are one implementation for both targets.
export { DEFAULT_RUN_TIMEOUT_SECONDS, RUN_OVERRUN_MARGIN_MS } from './live-runs.js';
export type { Clock } from './live-runs.js';

/** What carries a run this deploy stopped waiting on: the platform drains a replaced instance, and the container application spares a run inside its own budget. */
const CLOUDFLARE_SPARING = 'the platform drains what is running';

export const DEPLOY_CONFIG_NAME = 'wrangler.deploy.toml';
const WORKER_NAME = 'myco-server';
const DATABASE_NAME = 'myco-server';
const BUCKET_NAME = 'myco-server-blobs';
const WRAP_KEY_SECRET = 'myco-secret-wrap-key';

/**
 * The longest a rollout is watched. Mirrors the largest budget in
 * `TASK_RUN_TIMEOUT_SECONDS` in
 * `packages/myco-server/src/core/task-catalogue.ts`, held equal by the same
 * test: an instance carrying the longest-running task is spared until its
 * budget is spent, so a rollout cannot finish before then.
 */
export const ROLLOUT_WATCH_TIMEOUT_SECONDS = 1800;

/**
 * How long the watch gives the platform to start replacing the instances.
 * A deploy can change the `[[containers]]` table and still name the same
 * resources — a setting spelled another way is one — and the platform starts
 * nothing for it: the application keeps the version it carried, and no later
 * poll will say otherwise. Past this window with the version standing and no
 * instance ever seen being replaced, the watch says so instead of spending its
 * whole bound on a rollout that is not coming.
 */
export const ROLLOUT_START_WINDOW_SECONDS = 180;

/** How often the watch asks the container application where the rollout stands. */
const ROLLOUT_POLL_MS = 20_000;

export interface LifecycleOptions extends Omit<CloudflareOptions, 'configFile'> {
  mycoHome?: string;
  /** Whether the deploy waits for the runs in flight before it ships; `--no-drain` turns it off. */
  drain?: boolean;
  /** Where the wait and the watch say where they are, as they get there. */
  report?: (line: string) => void;
  clock?: Clock;
}

/**
 * Wait for the runs in flight to end before the deploy replaces the instances
 * carrying them.
 *
 * The read spends its own retry pause on the same clock the wait polls on.
 */
async function waitForCloudflareLiveRuns(
  options: LifecycleOptions & { configFile: string; databaseName: string },
): Promise<void> {
  const clock = options.clock ?? systemClock;
  await waitForLiveRuns({
    read: () => readLiveRuns({ ...options, sleep: (ms) => clock.sleep(ms) }),
    sparing: CLOUDFLARE_SPARING,
    clock,
    ...(options.drain === undefined ? {} : { drain: options.drain }),
    ...(options.report === undefined ? {} : { report: options.report }),
  });
}

/**
 * Watch the container instances reach the version the deploy just shipped.
 *
 * `wrangler deploy` returns when the application has accepted the new image,
 * not when the instances carry it, and a run dispatched in between lands on an
 * instance the platform has yet to replace. A full instance count alone does
 * not mean the rollout is done — the fleet standing untouched answers exactly
 * that — so the application must also be describing the image the deploy just
 * pushed. Where an answer names no image at all, the fleet must have been seen
 * mid-replacement at least once before a full count is believed.
 *
 * A rollout that never starts is told apart from one still running by the
 * start window: past it, with the version standing and no instance ever seen
 * being replaced, the platform has started nothing for this deploy and the
 * watch ends. Once a later version is read the watch is on a real rollout, and
 * runs to its full bound.
 *
 * The bound is the longest task budget: an instance carrying a run is spared
 * until that run's budget is spent, so a rollout cannot outlast it by anything
 * the deploy is responsible for. Past the bound the deploy still succeeded, so
 * this says where the rollout stands and answers nothing.
 */
async function watchRollout(
  options: LifecycleOptions & { applicationId: string; versionBefore: number; pushedImage: string },
): Promise<{ version: number; completedAt: string } | null> {
  const report = options.report ?? console.log;
  const clock = options.clock ?? systemClock;
  const started = clock.now();
  const deadline = started + ROLLOUT_WATCH_TIMEOUT_SECONDS * 1000;
  const startWindow = started + ROLLOUT_START_WINDOW_SECONDS * 1000;
  let said = '';
  let sawReplacement = false;
  let sawNewVersion = false;

  /** Says a line once, however many polls answer the same thing. */
  const sayOnce = (line: string): void => {
    if (line === said) return;
    report(line);
    said = line;
  };

  // The cadence, said up front: minutes of quiet between the lines below is
  // the watch working, not the watch stuck.
  report(`Watching the rollout; the platform reports the instances every ${ROLLOUT_POLL_MS / 1000} s.`);

  for (;;) {
    let state = null;
    try {
      state = await containerRollout(options);
    } catch (err) {
      sayOnce(`The container application could not be read: ${describeFailure(err)}`);
    }
    if (state !== null && state.healthy < state.instances) sawReplacement = true;
    if (state !== null && state.version > options.versionBefore) {
      sawNewVersion = true;
      const everyInstanceHealthy = state.healthy >= state.instances;
      const carriesPushedImage = state.image === null ? sawReplacement : state.image === options.pushedImage;
      if (everyInstanceHealthy && carriesPushedImage) {
        report('Rollout complete.');
        return { version: state.version, completedAt: new Date(clock.now()).toISOString() };
      }
      if (!everyInstanceHealthy) {
        sayOnce(`Rolling out: ${state.healthy} of ${state.instances} instances on the new version`);
      }
    }
    // An application that answers is the only one whose standing version is
    // evidence; a read that failed says nothing about what the platform did.
    if (state !== null && !sawNewVersion && !sawReplacement && clock.now() >= startWindow) {
      report('The platform started no rollout for this deploy: the container settings in force already match.');
      return null;
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

/**
 * Render the record's deploy config into the checkout: its path, and the
 * identity of the container settings it carries. Both come from the one
 * render, so the file a deploy reads and the settings hash it compares can
 * never describe different containers.
 */
export function writeDeployConfig(record: DeploymentRecord, configDir: string): { file: string; containersTable: string } {
  const file = path.join(configDir, DEPLOY_CONFIG_NAME);
  const config = renderDeployConfig(record);
  writeFileSync(file, config, { mode: 0o600 });
  return { file, containersTable: containersTableHash(config) };
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
  if ((await ensureVectorIndex(options)).created) createdResources.push(`vectorize ${VECTOR_INDEX_NAME}`);

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
  const { file: configFile, containersTable } = writeDeployConfig(record, options.configDir);
  const withConfig = { ...options, configFile: path.basename(configFile) };

  await applyMigrations({ ...withConfig, databaseName: DATABASE_NAME });
  const willRoll = rollsContainers(
    { image: record.harnessImage, containersTable },
    { image: existing?.harnessImage, containersTable: existing?.containersTable },
  );
  const deployed = await deployWorker({ ...withConfig, willRoll });

  // After the first deploy: a secret lands on the live Worker; putting one
  // ahead of a Worker that is not there yet is version-dependent behavior.
  if (existing === null) {
    await putWorkerSecretValue({ ...withConfig, workerName: WORKER_NAME, name: 'SESSION_SECRET', value: randomBytes(32).toString('base64url') });
    createdResources.push('worker secret SESSION_SECRET');
  }

  record = { ...record, containersTable, versionId: deployed.versionId, deployedAt: new Date().toISOString(), ...(record.url === undefined && deployed.url !== null ? { url: deployed.url } : {}) };
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
  await ensureVectorIndex(options);
  await buildDeployArtifacts(options);

  // The wait reads the Deployment's own database, which wrangler addresses by
  // name only through a config carrying its id. Rendering the record's config
  // here also refuses a record that cannot address its database before the
  // push rather than after it.
  const configFile = path.basename(writeDeployConfig(record, options.configDir).file);
  await waitForCloudflareLiveRuns({ ...options, configFile, databaseName: record.databaseName });

  const pinned = { ...record, harnessImage: await buildAndPushHarnessImage({ ...options, workerName: record.workerName }) };
  writeDeploymentRecord(pinned, options.mycoHome);
  const { containersTable } = writeDeployConfig(pinned, options.configDir);
  const withConfig = { ...options, configFile };
  await applyMigrations({ ...withConfig, databaseName: record.databaseName });

  // The version the instances carry has to be read before the deploy: the
  // rollout is over when they carry a later one. A deploy shipping the image
  // already running under the container settings already in force rolls
  // nothing, and asks the application nothing.
  const willRoll = rollsContainers(
    { image: pinned.harnessImage, containersTable },
    { image: record.harnessImage, containersTable: record.containersTable },
  );
  let applicationId: string | null = null;
  let before: ContainerRollout | null = null;
  let unreadable: string | null = null;
  if (willRoll) {
    try {
      applicationId = await containerApplicationId({ ...withConfig, workerName: record.workerName });
      if (applicationId !== null) before = await containerRollout({ ...withConfig, applicationId });
    } catch (err) {
      unreadable = describeFailure(err);
    }
  }

  const deployed = await deployWorker({ ...withConfig, willRoll });

  const report = options.report ?? console.log;
  let rollout: { version: number; completedAt: string } | null = null;
  if (!deployed.willRoll) report('No container rollout (image and container settings unchanged).');
  else if (unreadable !== null) report(`The container application could not be read: ${unreadable}. The deploy shipped; the rollout is not watched.`);
  else if (applicationId === null) report('No container application answers yet; the instances carry the new image as they start.');
  else if (before === null) report('The container application did not say where it stands; the deploy shipped and the rollout is not watched.');
  else rollout = await watchRollout({ ...withConfig, applicationId, versionBefore: before.version, pushedImage: pinned.harnessImage });

  writeDeploymentRecord({
    ...pinned,
    containersTable,
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
  return { kept: [`d1 ${record.databaseName}`, `r2 ${record.bucketName}`, `vectorize ${VECTOR_INDEX_NAME}`, 'secrets store', 'the deployment record'] };
}
