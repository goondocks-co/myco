/**
 * Cloudflare Deployment lifecycle, as operator code.
 *
 * The self-hosted target's counterpart is `deployment.ts`, and both run through
 * the same {@link CommandRunner} so a lifecycle is tested by the argv it
 * produces rather than by provisioning real infrastructure.
 *
 * Cloudflare management credentials are never handed to the deployed
 * application: everything here runs `wrangler` on the operator's machine
 * against the operator's own login. The Worker holds bindings, not an API
 * token that could re-provision the account it runs in.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import { ensureServerLayout } from './layout.js';
import { CommandFailed, commandOutputTail, jsonDocument, runOrThrow, systemRunner, type CommandRunner } from './runner.js';

/** Wrangler refuses to guess between accounts, and guessing is what must not happen. */
export class AccountNotSelected extends Error {
  constructor(readonly available: { name: string; id: string }[]) {
    super(
      'This Cloudflare login can reach more than one account, and none was named. '
      + `Pass --account-id. Available: ${available.map((a) => `${a.name} (${a.id})`).join(', ')}`,
    );
    this.name = 'AccountNotSelected';
  }
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

export interface CloudflareOptions {
  /**
   * The account every command is pinned to.
   *
   * Required rather than defaulted. A login reaching several accounts and a
   * command that picks one silently is how resources land in the wrong place —
   * and a partially provisioned Deployment is worse than a refused one, because
   * some resources exist and the operator does not know which.
   */
  accountId: string;
  runner?: CommandRunner;
  /** Directory holding `wrangler.toml`; the deployment's source of truth. */
  configDir: string;
  /** A derived config inside `configDir` (`wrangler.deploy.toml`); commands read the committed file without one. */
  configFile?: string;
}

function resolved(options: CloudflareOptions): { runner: CommandRunner; env: NodeJS.ProcessEnv } {
  if (!options.accountId) throw new AccountNotSelected([]);
  return {
    runner: options.runner ?? systemRunner(),
    // Pinned per invocation rather than exported once: a command that outlives
    // this process must not inherit an account selection it never asked for.
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: options.accountId },
  };
}

/** Every wrangler invocation carries the account explicitly. */
function wrangler(...args: string[]): string[] {
  return ['wrangler', ...args];
}

/** The `-c` pair for a derived config, or nothing for the committed one. */
function configArgs(options: { configFile?: string }): string[] {
  return options.configFile === undefined ? [] : ['-c', options.configFile];
}

export interface AccountRef { name: string; id: string }

/** Accounts this login can reach, for a caller that has to choose one. */
export async function listAccounts(runner: CommandRunner = systemRunner()): Promise<AccountRef[]> {
  const result = await runner.run('npx', wrangler('whoami'), {});
  const rows: AccountRef[] = [];
  for (const line of result.stdout.split('\n')) {
    // `whoami` prints a table; the id is the 32-hex cell.
    const match = /│\s*(.+?)\s*│\s*([0-9a-f]{32})\s*│/.exec(line);
    if (match) rows.push({ name: match[1]!.trim(), id: match[2]! });
  }
  return rows;
}

export interface DeployResult {
  versionId: string | null;
  url: string | null;
  /** Whether this deploy asked the platform to replace the container instances; a watcher has something to watch only when it did. */
  willRoll: boolean;
}

/** What a deploy passes wrangler to leave the container application's images and instances exactly as they stand. */
export const CONTAINERS_ROLLOUT_NONE = '--containers-rollout=none';

/** What a deploy carries into the container application: the image bytes, and the settings the rendered `[[containers]]` table holds. */
export interface ContainerState {
  image?: string;
  containersTable?: string;
}

/**
 * Whether a deploy shipping `pushed` over `deployed` rolls the container
 * application. The platform replaces the instances when the image bytes move
 * or the `[[containers]]` table changes, so either moving rolls and identical
 * bytes under identical settings roll nothing. A deployed state naming no
 * image or no settings is one nothing can be compared against, and rolls.
 *
 * A caller that has to prepare for a rollout — reading the application's
 * version before the deploy, say — asks this before running one.
 */
export function rollsContainers(pushed: ContainerState, deployed: ContainerState): boolean {
  if (pushed.image === undefined || pushed.image !== deployed.image) return true;
  return deployed.containersTable === undefined || pushed.containersTable !== deployed.containersTable;
}

/**
 * The JSON value in a wrangler answer.
 *
 * `npx` prints `npm notice` lines and wrangler its own configuration warnings
 * around the document, and the reader every command here shares reads past
 * both. An answer carrying no readable document answers null rather than
 * throwing: the caller decides what that means.
 */
export function wranglerJson<T>(stdout: string): T | null {
  return jsonDocument<T>(stdout);
}

/**
 * Deploy the Worker.
 *
 * `--dry-run` first is not a courtesy: a deploy that fails halfway leaves the
 * account holding some of what it was going to create, and the build is where
 * most failures are.
 *
 * A deploy that changes nothing the container instances carry rolls nothing:
 * replacing them would take every run in flight through a drain to arrive at
 * what is already there. `willRoll` is that decision, made by the caller
 * holding the record the image and the container settings are compared
 * against; a caller naming none rolls.
 */
export async function deployWorker(options: CloudflareOptions & { dryRun?: boolean; willRoll?: boolean }): Promise<DeployResult> {
  const { runner, env } = resolved(options);
  const willRoll = options.willRoll ?? true;
  const args = wrangler(
    'deploy',
    ...configArgs(options),
    ...(willRoll ? [] : [CONTAINERS_ROLLOUT_NONE]),
    ...(options.dryRun === true ? ['--dry-run'] : []),
  );
  const result = await runOrThrow(runner, 'npx', args, { cwd: options.configDir, env });

  return {
    versionId: /Current Version ID:\s*([0-9a-f-]+)/.exec(result.stdout)?.[1] ?? null,
    url: /(https:\/\/[^\s]+\.workers\.dev)/.exec(result.stdout)?.[1] ?? null,
    willRoll,
  };
}

/** The container application wrangler derives from the Worker and its container class; the image the deploy pushes carries the same name. */
export function harnessApplicationName(workerName: string): string {
  return `${workerName}-harnesscontainer`;
}

/** The registry URI a `containers build --push` output pins: the LAST manifest digest it exported, under the image name wrangler derives from the Worker and container class. */
export function harnessImageUri(buildOutput: string, accountId: string, workerName: string): string {
  const digests = [...buildOutput.matchAll(/exporting manifest sha256:([0-9a-f]{64})/g)];
  const digest = digests.at(-1)?.[1];
  if (digest === undefined) throw new Error('the container build output carries no manifest digest; the image cannot be pinned');
  return `registry.cloudflare.com/${accountId}/${harnessApplicationName(workerName)}@sha256:${digest}`;
}

/** A run the Deployment has in flight, as its own database holds it. */
export interface LiveRun {
  id: string;
  task: string;
  /** `pending` for a run whose container has not been launched yet, `running` for one under way. */
  status: 'pending' | 'running';
  /** Epoch milliseconds, or null for a run that has not started — a `pending` row is written before its container is launched. */
  startedAt: number | null;
  /** The budget the dispatcher wrote into the run's context, or null for a run that carries none. */
  timeoutSeconds: number | null;
}

/**
 * What the wait reads.
 *
 * `pending` counts as in flight exactly as `running` does: the dispatcher
 * writes the row before it launches the container, and that run — dispatched,
 * not yet started — is the one a deploy is most likely to lose. The server's
 * own live-run reads use the same pair (`core/runs.ts`, `LIVE_RUNS_SQL`).
 */
const LIVE_RUNS_QUERY = "SELECT id, task, status, started_at, run_context FROM agent_runs WHERE status IN ('pending', 'running')";

interface LiveRunRow {
  id?: unknown;
  task?: unknown;
  status?: unknown;
  started_at?: unknown;
  run_context?: unknown;
}

/** Raised when the Deployment's runs cannot be read; a deploy that cannot see them must not read that as an empty Deployment. */
export class LiveRunsUnreadable extends Error {
  constructor(readonly answer: string) {
    super(
      "the Deployment's runs could not be read; pass --no-drain to ship over whatever is running"
      + (answer === '' ? '' : `. The read answered: ${answer}`),
    );
    this.name = 'LiveRunsUnreadable';
  }
}

/** How long the live-runs read waits before it asks a second time. */
export const LIVE_RUNS_RETRY_MS = 3_000;

/** How the read spends its retry pause when no caller hands it a clock. */
const pause = (ms: number): Promise<void> => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * The runs the Deployment has in flight, read from its own database.
 *
 * A deploy holds no application credential, so this reads through the
 * operator's own wrangler login like every other command here. A command that
 * fails and an answer that carries no readable document both refuse the read:
 * "nothing came back" and "nothing is running" are opposite facts, and a
 * deploy that confused them would ship straight over live work.
 *
 * Either answer is asked again once after a pause first. The database API
 * answers a passing internal error in exactly the shape it answers a real
 * one, and a deploy refused over an answer that comes back a second later
 * costs the operator the whole run. Only a second bad answer raises, carrying
 * what the command itself said.
 */
export async function readLiveRuns(
  options: CloudflareOptions & { databaseName: string; sleep?: (ms: number) => Promise<void> },
): Promise<LiveRun[]> {
  const { runner, env } = resolved(options);
  const sleep = options.sleep ?? pause;
  let answer = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await sleep(LIVE_RUNS_RETRY_MS);
    let stdout: string;
    try {
      const result = await runOrThrow(runner, 'npx',
        wrangler('d1', 'execute', options.databaseName, '--remote', '--json', '--command', LIVE_RUNS_QUERY, ...configArgs(options)),
        { cwd: options.configDir, env });
      stdout = result.stdout;
    } catch (err) {
      if (!(err instanceof CommandFailed)) throw err;
      answer = err.message;
      continue;
    }
    const answers = wranglerJson<{ results?: LiveRunRow[] }[]>(stdout);
    if (answers === null) {
      answer = commandOutputTail(stdout) || stdout.trim();
      continue;
    }
    return liveRunsIn(answers);
  }
  throw new LiveRunsUnreadable(answer);
}

/** The runs the answered rows name, skipping a row that names no run. */
function liveRunsIn(answers: readonly { results?: LiveRunRow[] }[]): LiveRun[] {
  const runs: LiveRun[] = [];
  for (const answer of answers) {
    for (const row of answer.results ?? []) {
      if (typeof row.id !== 'string') continue;
      runs.push({
        id: row.id,
        task: typeof row.task === 'string' && row.task !== '' ? row.task : 'a run without a task',
        status: row.status === 'pending' ? 'pending' : 'running',
        startedAt: typeof row.started_at === 'number' ? row.started_at : null,
        timeoutSeconds: runContextTimeout(row.run_context),
      });
    }
  }
  return runs;
}

/** The budget a run's context names, or null when the context holds none the harness would honour. */
function runContextTimeout(runContext: unknown): number | null {
  if (typeof runContext !== 'string' || runContext === '') return null;
  try {
    const parsed = JSON.parse(runContext) as { timeoutSeconds?: unknown };
    return typeof parsed.timeoutSeconds === 'number' && parsed.timeoutSeconds > 0 ? parsed.timeoutSeconds : null;
  } catch {
    return null;
  }
}

/** Where a rollout stands: the image and version the application carries, how many instances it has, and how many answer healthy. */
export interface ContainerRollout {
  version: number;
  instances: number;
  healthy: number;
  /** The digest-pinned image the application is configured with, or null when the answer names none. */
  image: string | null;
}

/** The container application's id, or null when the account holds none of that name — a Deployment whose first deploy has not created one. A failed command is raised, because that is a different fact. */
export async function containerApplicationId(options: CloudflareOptions & { workerName: string }): Promise<string | null> {
  const { runner, env } = resolved(options);
  const result = await runOrThrow(runner, 'npx', wrangler('containers', 'list', '--json', ...configArgs(options)), { cwd: options.configDir, env });
  const rows = wranglerJson<{ id?: unknown; name?: unknown }[]>(result.stdout) ?? [];
  const name = harnessApplicationName(options.workerName);
  const match = rows.find((row) => row.name === name);
  return typeof match?.id === 'string' ? match.id : null;
}

/**
 * Where the container application stands, or null when the answer is not
 * readable. A failed command is raised so its stderr reaches the operator; an
 * answer that came back unreadable is a reason to ask again rather than to
 * fail a deploy that already succeeded.
 */
export async function containerRollout(options: CloudflareOptions & { applicationId: string }): Promise<ContainerRollout | null> {
  const { runner, env } = resolved(options);
  const result = await runOrThrow(runner, 'npx', wrangler('containers', 'info', options.applicationId, '--json', ...configArgs(options)), { cwd: options.configDir, env });
  const info = wranglerJson<{ version?: unknown; instances?: unknown; health?: { instances?: { healthy?: unknown } }; configuration?: { image?: unknown } }>(result.stdout);
  if (info === null || typeof info.version !== 'number' || typeof info.instances !== 'number') return null;
  const healthy = info.health?.instances?.healthy;
  const image = info.configuration?.image;
  return {
    version: info.version,
    instances: info.instances,
    healthy: typeof healthy === 'number' ? healthy : 0,
    image: typeof image === 'string' && image !== '' ? image : null,
  };
}

/**
 * Build and push the harness container image, answering the registry URI of
 * the exact bytes pushed. The deploy config pins this URI, so the container
 * application rolls precisely when image content changes — a Dockerfile-path
 * config rolls only on `[[containers]]` table edits, and an image-only deploy
 * pushes a digest the application never adopts. The push is idempotent: an
 * image already in the registry answers the same digest.
 */
export async function buildAndPushHarnessImage(options: CloudflareOptions & { workerName: string }): Promise<string> {
  const { runner, env } = resolved(options);
  const result = await runOrThrow(runner, 'npx',
    wrangler('containers', 'build', './harness', '-t', `${options.workerName}-harnesscontainer:latest`, '--push'),
    { cwd: options.configDir, env });
  return harnessImageUri(`${result.stdout}\n${result.stderr}`, options.accountId, options.workerName);
}

/** Apply pending D1 migrations against the deployed database. */
export async function applyMigrations(options: CloudflareOptions & { databaseName: string }): Promise<void> {
  const { runner, env } = resolved(options);
  await runOrThrow(runner, 'npx',
    wrangler('d1', 'migrations', 'apply', options.databaseName, '--remote', ...configArgs(options)),
    { cwd: options.configDir, env });
}

/** Create the D1 database and answer its UUID; an existing database of the name is answered, not an error. */
export async function ensureDatabase(options: CloudflareOptions & { databaseName: string }): Promise<{ databaseId: string; created: boolean }> {
  const { runner, env } = resolved(options);
  const listed = await runner.run('npx', wrangler('d1', 'list', '--json'), { cwd: options.configDir, env });
  if (listed.code === 0) {
    try {
      const rows = JSON.parse(listed.stdout) as { name: string; uuid: string }[];
      const existing = rows.find((r) => r.name === options.databaseName);
      if (existing !== undefined) return { databaseId: existing.uuid, created: false };
    } catch { /* an unreadable list falls through to create, which reports its own conflict */ }
  }
  const result = await runOrThrow(runner, 'npx', wrangler('d1', 'create', options.databaseName), { cwd: options.configDir, env });
  const id = UUID_RE.exec(result.stdout)?.[0];
  if (id === undefined) throw new Error(`wrangler created ${options.databaseName} without printing its id; run \`wrangler d1 list\` and add databaseId to the deployment record`);
  return { databaseId: id, created: true };
}

/** Create the R2 bucket; an existing bucket of the name is kept. */
export async function ensureBucket(options: CloudflareOptions & { bucketName: string }): Promise<{ created: boolean }> {
  const { runner, env } = resolved(options);
  const result = await runner.run('npx', wrangler('r2', 'bucket', 'create', options.bucketName), { cwd: options.configDir, env });
  if (result.code === 0) return { created: true };
  if (/already (exists|owned)/i.test(result.stdout + result.stderr)) return { created: false };
  throw new Error(`r2 bucket create failed: ${(result.stderr || result.stdout).slice(-500)}`);
}

/**
 * The account's secrets store id, creating the store when the account has
 * none. An account holds ONE store, so an existing store of any name is
 * reused rather than a second attempted.
 */
export async function ensureSecretsStore(options: CloudflareOptions): Promise<{ storeId: string; created: boolean }> {
  const { runner, env } = resolved(options);
  const listed = await runner.run('npx', wrangler('secrets-store', 'store', 'list', '--remote'), { cwd: options.configDir, env });
  const existing = /[0-9a-f]{32}/.exec(listed.stdout)?.[0];
  if (listed.code === 0 && existing !== undefined) return { storeId: existing, created: false };
  const result = await runOrThrow(runner, 'npx', wrangler('secrets-store', 'store', 'create', 'myco', '--remote'), { cwd: options.configDir, env });
  const id = /[0-9a-f]{32}/.exec(result.stdout)?.[0];
  if (id === undefined) throw new Error('wrangler created the secrets store without printing its id; run `wrangler secrets-store store list --remote` and add storeId to the deployment record');
  return { storeId: id, created: true };
}

/** Install the wrapping key in the store, value on stdin, never argv. */
export async function putStoreSecret(options: CloudflareOptions & { storeId: string; name: string; value: string }): Promise<void> {
  const { runner, env } = resolved(options);
  await runOrThrow(runner, 'npx',
    wrangler('secrets-store', 'secret', 'create', options.storeId, '--name', options.name, '--scopes', 'workers', '--remote'),
    { cwd: options.configDir, env, input: options.value });
}

/** Install one Worker secret, value on stdin, never argv. */
export async function putWorkerSecretValue(options: CloudflareOptions & { workerName: string; name: string; value: string }): Promise<void> {
  const { runner, env } = resolved(options);
  await runOrThrow(runner, 'npx',
    wrangler('secret', 'put', options.name, '--name', options.workerName),
    { cwd: options.configDir, env, input: options.value });
}

/** Remove the Worker. The database, bucket, and store are left standing; data removal is its own explicit act. */
export async function deleteWorker(options: CloudflareOptions & { workerName: string }): Promise<void> {
  const { runner, env } = resolved(options);
  await runOrThrow(runner, 'npx', wrangler('delete', '--name', options.workerName, '--force'), { cwd: options.configDir, env });
}

/** Return the Worker to a version it already deployed; that version's own code and bindings apply. */
export async function rollbackWorker(options: CloudflareOptions & { workerName: string; versionId: string; message: string }): Promise<void> {
  const { runner, env } = resolved(options);
  await runOrThrow(runner, 'npx',
    wrangler('rollback', options.versionId, '--name', options.workerName, '-y', '-m', options.message, ...configArgs(options)),
    { cwd: options.configDir, env });
}

export interface CloudflareStatus {
  deployed: boolean;
  versionId: string | null;
  raw: string;
}

export async function cloudflareStatus(options: CloudflareOptions & { workerName: string }): Promise<CloudflareStatus> {
  const { runner, env } = resolved(options);
  const result = await runner.run('npx',
    wrangler('deployments', 'list', '--name', options.workerName),
    { cwd: options.configDir, env });

  // The list prints OLDEST first, and a version line takes one of two shapes
  // depending on the wrangler release; the current version is the last match.
  const versions = [...result.stdout.matchAll(/(?:Version ID:|Version\(s\):\s*\(\d+%\))\s*([0-9a-f-]{36})/g)];
  return {
    deployed: result.code === 0 && result.stdout.trim() !== '',
    versionId: versions.at(-1)?.[1] ?? null,
    raw: result.stdout,
  };
}

/**
 * Export the relational store.
 *
 * This is HALF a Deployment backup and says so. `wrangler d1 export` produces a
 * complete SQL dump; wrangler has no bulk export for R2, so blobs are not
 * covered here and no command in this function pretends to cover them.
 *
 * A Deployment restored from this alone has every row and no attachment, which
 * is a worse outcome than a refused backup, so {@link backupCloudflare} returns
 * what it did and did not capture rather than reporting success.
 */
export async function exportDatabase(
  options: CloudflareOptions & { databaseName: string; destination: string },
): Promise<{ sqlPath: string }> {
  const { runner, env } = resolved(options);
  mkdirSync(options.destination, { recursive: true, mode: 0o700 });

  const sqlPath = path.join(options.destination, 'd1.sql');
  await runOrThrow(runner, 'npx',
    wrangler('d1', 'export', options.databaseName, '--remote', '--output', sqlPath),
    { cwd: options.configDir, env });

  return { sqlPath };
}

export interface BackupCoverage {
  destination: string;
  captured: readonly string[];
  /** What a restore from this backup would NOT bring back. */
  notCaptured: readonly string[];
}

/**
 * Back up what can be backed up today, and name what cannot.
 *
 * Blob coverage needs an object-by-object copy over the S3-compatible API or an
 * external tool; #923 owns Deployment backup and restore and is where that
 * belongs. Reporting partial coverage as success is the failure this shape
 * exists to prevent.
 */
export async function backupCloudflare(
  options: CloudflareOptions & { databaseName: string; destination: string },
): Promise<BackupCoverage> {
  await exportDatabase(options);
  return {
    destination: options.destination,
    captured: ['relational store (d1.sql)'],
    notCaptured: ['blob store — wrangler has no bulk R2 export; see #923'],
  };
}

/**
 * Deployment metadata an operator can reproduce, holding no secrets.
 *
 * The account id and resource names are not credentials; the token that reaches
 * them lives in the operator's own wrangler login and never in this file.
 */
export interface DeploymentRecord {
  accountId: string;
  workerName: string;
  databaseName: string;
  bucketName: string;
  versionId: string | null;
  deployedAt: string;
  /** The Deployment's public URL — the custom domain or the workers.dev host — once an operator has named it. */
  url?: string;
  /** The D1 database UUID; the deploy config carries it where the committed file holds a placeholder. */
  databaseId?: string;
  /** The account's secrets store id; present once the wrapping key is provisioned. */
  storeId?: string;
  /** The pushed harness image's digest-pinned registry URI; the deploy config pins it once a push has recorded one. */
  harnessImage?: string;
  /** How many harness runtimes the Deployment may start at once — the container fleet, set by `myco server config --fleet`; the template's number until then. */
  fleet?: number;
  /** The container settings the running instances carry: the hash of the rendered `[[containers]]` table the deploy that shipped them wrote. A record naming none carries settings nothing can be compared against, and the next deploy rolls. */
  containersTable?: string;
  /** The last container rollout a deploy watched to its end: the application version the instances reached, and when they all carried it. Absent until one completes under a watch. */
  lastRollout?: { version: number; completedAt: string };
}

/** The Worker's sign-in secrets, named as the Worker reads them. */
export interface WorkerSecrets {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
}

export interface WorkerSecretTarget {
  accountId: string;
  workerName: string;
  runner?: CommandRunner;
}

/** Raised when wrangler is not installed where `npx` would find it; `npx` would otherwise ask on stdin whether to fetch it, and stdin carries the secrets. */
export class WranglerAbsent extends Error {
  constructor() {
    super('wrangler is not installed; `npm install -g wrangler` (or run from a checkout that has it) and retry');
    this.name = 'WranglerAbsent';
  }
}

/** True when `npx` resolves wrangler without fetching it. */
export async function wranglerPresent(runner: CommandRunner = systemRunner()): Promise<boolean> {
  const result = await runner.run('npx', ['--no-install', 'wrangler', '--version'], {});
  return result.code === 0;
}

/**
 * Install the Worker's sign-in secrets in one request.
 *
 * `wrangler secret bulk` takes the whole set on stdin and sends it as one
 * request, so a Worker never holds a client id whose secret is missing. The
 * account is pinned in the environment and the Worker named on the command
 * line: an operator's machine holds no `wrangler.toml` for a Deployment, and
 * this needs none. Nothing here writes a secret to argv or to a file.
 */
export async function putWorkerSecrets(target: WorkerSecretTarget, secrets: WorkerSecrets): Promise<void> {
  if (!target.accountId) throw new AccountNotSelected([]);
  const runner = target.runner ?? systemRunner();
  if (!(await wranglerPresent(runner))) throw new WranglerAbsent();
  // A debug log level makes wrangler print the request it sends — the secrets
  // with it — and a failed command's output is what the operator reads.
  await runOrThrow(runner, 'npx', wrangler('secret', 'bulk', '--name', target.workerName), {
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: target.accountId, WRANGLER_LOG: 'log' },
    input: JSON.stringify(secrets),
  });
}

export function deploymentRecordPath(mycoHome = resolveMycoHome()): string {
  ensureServerLayout(mycoHome);
  return path.join(mycoHome, 'server', 'cloudflare', 'record.json');
}

export function writeDeploymentRecord(record: DeploymentRecord, mycoHome = resolveMycoHome()): void {
  const file = deploymentRecordPath(mycoHome);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

export function readDeploymentRecord(mycoHome = resolveMycoHome()): DeploymentRecord | null {
  const file = deploymentRecordPath(mycoHome);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as DeploymentRecord;
  } catch (err) {
    throw new Error(`${file} is not readable as a deployment record: ${err instanceof Error ? err.message : String(err)}`);
  }
}
