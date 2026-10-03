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
import nodeFs from 'node:fs';
const { existsSync, readFileSync, mkdirSync } = nodeFs;
import path from 'node:path';
import { z } from 'zod';
import { resolveMycoHome } from '../paths/home.js';
import { ensureServerLayout } from './layout.js';
import { CommandFailed, jsonDocument, runOrThrow, systemRunner, type CommandRunner } from './runner.js';
import { cloudflareResources } from './cloudflare-resources.js';
import { BUNDLED_WORKER_WRANGLER } from '../worker-bundle.generated.js';
import { VECTOR_INDEX_DIMENSIONS, VECTOR_METADATA_FIELDS } from './vector-config.js';
import { withCloudflareOperation } from './cloudflare-operation.js';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { connectionFailure, objectReadFailureDetail, ObjectReadError, transientStatus } from './object-read.js';

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

/** Commands carrying private data suppress provider output and debug files on every failure path. */
async function privateCommand(options: CloudflareOptions, args: string[], input: string | undefined, operation: string, timeoutMs = 120_000): Promise<void> {
  const { runner, env } = resolved(options);
  let code: number;
  try {
    const result = await runner.run('npx', wrangler(...args), {
      cwd: options.configDir,
      env: { ...env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG: 'log', WRANGLER_LOG_SANITIZE: 'true' },
      ...(input === undefined ? {} : { input }), timeoutMs,
    });
    code = result.code;
  } catch {
    throw new Error(`${operation} did not finish; provider output was withheld because it may contain private data`);
  }
  if (code !== 0) throw new Error(`${operation} failed (exit ${code}); provider output was withheld because it may contain private data`);
}

/**
 * Every wrangler invocation, as `npx` argv.
 *
 * `--no-install` leads, always: without it `npx` fetches whatever wrangler is
 * current the moment a machine has none, so an operator's first command
 * downloads a version nobody chose — and a command that reads a secret on stdin
 * takes npx's own install prompt as the answer. Refusing is
 * {@link assertWranglerPresent}'s job, and it can only refuse if nothing here
 * can fetch.
 */
function wrangler(...args: string[]): string[] {
  return ['--no-install', 'wrangler', ...args];
}

/** The `-c` pair for a derived config, or nothing for the committed one. */
function configArgs(options: { configFile?: string }): string[] {
  return options.configFile === undefined ? [] : ['-c', options.configFile];
}

export interface AccountRef { name: string; id: string }

/** Accounts this login can reach, for a caller that has to choose one. */
export async function listAccounts(runner: CommandRunner = systemRunner(), mycoHome?: string): Promise<AccountRef[]> {
  const result = await runner.run('npx', wrangler('whoami'), { cwd: ensureCommandDir(mycoHome) });
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
 * The Worker carries no runtime, so a deploy replaces nothing that holds a run:
 * a request in flight finishes on the version that took it, and a run executes
 * on a worker this command never touches.
 */
export async function deployWorker(options: CloudflareOptions & { dryRun?: boolean }): Promise<DeployResult> {
  const { runner, env } = resolved(options);
  const args = wrangler(
    'deploy',
    ...configArgs(options),
    ...(options.dryRun === true ? ['--dry-run'] : []),
  );
  const result = await runOrThrow(runner, 'npx', args, { cwd: options.configDir, env });

  return {
    versionId: /Current Version ID:\s*([0-9a-f-]+)/.exec(result.stdout)?.[1] ?? null,
    url: /(https:\/\/[^\s]+\.workers\.dev)/.exec(result.stdout)?.[1] ?? null,
  };
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

/** The memory index and its filters must exist before the Worker accepts embedding work. */
export async function ensureVectorIndex(options: CloudflareOptions & { vectorIndexName?: string; requireNew?: boolean }): Promise<{ created: boolean }> {
  const result = await ensureVectorIndexResource(options);
  await ensureVectorIndexFilters(options);
  return result;
}

/** Confirm index creation independently of asynchronous filter readiness. */
export async function ensureVectorIndexResource(options: CloudflareOptions & { vectorIndexName?: string; requireNew?: boolean }): Promise<{ created: boolean }> {
  const { vectorIndexName } = cloudflareResources(options);
  const { runner, env } = resolved(options);
  const command = (...args: string[]) => runOrThrow(runner, 'npx', wrangler('vectorize', ...args), { cwd: options.configDir, env });
  const rows: unknown = jsonDocument((await command('list', '--json')).stdout);
  if (!Array.isArray(rows)) throw new Error('Vectorize index list is unreadable');
  const created = !rows.some((r) => r?.name === vectorIndexName);
  if (!created && options.requireNew) throw new Error('refusing to adopt an existing recovery index');
  if (created) await command('create', vectorIndexName, '--dimensions', String(VECTOR_INDEX_DIMENSIONS), '--metric', 'cosine', '--json', '--update-config=false');
  return { created };
}

/** Prepare filters only on an existing index with compatible dimensions and metric. */
export async function ensureVectorIndexFilters(options: CloudflareOptions & { vectorIndexName?: string }): Promise<void> {
  const { vectorIndexName } = cloudflareResources(options);
  const { runner, env } = resolved(options);
  const command = (...args: string[]) => runOrThrow(runner, 'npx', wrangler('vectorize', ...args), { cwd: options.configDir, env });
  const held = jsonDocument((await command('get', vectorIndexName, '--json')).stdout) as { config?: { dimensions?: number; metric?: string } };
  if (held?.config?.dimensions !== VECTOR_INDEX_DIMENSIONS || held.config.metric !== 'cosine') throw new Error('memory vector index has incompatible dimensions or metric');
  const metadata = async (): Promise<Array<{ propertyName: string; indexType: string }>> => {
    const indexed: unknown = jsonDocument((await command('list-metadata-index', vectorIndexName, '--json')).stdout);
    if (!Array.isArray(indexed) || indexed.some((r) => typeof r?.propertyName !== 'string' || typeof r?.indexType !== 'string')) throw new Error('Vectorize metadata index list is unreadable');
    return indexed;
  };
  let indexed = await metadata();
  const compatible = (field: string): boolean => {
    const existing = indexed.find((r) => r.propertyName === field);
    if (existing === undefined) return false;
    if (existing.indexType.toLowerCase() !== (field === 'created_at' ? 'number' : 'string')) throw new Error(`memory vector filter ${field} has an incompatible type`);
    return true;
  };
  for (const field of VECTOR_METADATA_FIELDS) {
    if (compatible(field)) continue;
    const type = field === 'created_at' ? 'number' : 'string';
    const result = await runner.run('npx', wrangler('vectorize', 'create-metadata-index', vectorIndexName, '--propertyName', field, '--type', type), { cwd: options.configDir, env });
    if (result.code !== 0 && !/metadata index already exists for this name/.test(result.stderr + result.stdout)) throw new Error(`vector metadata creation failed: ${(result.stderr || result.stdout).slice(-500)}`);
  }
  const attempts = 30;
  const waitMs = 2000;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (VECTOR_METADATA_FIELDS.every(compatible)) return;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    indexed = await metadata();
  }
  if (VECTOR_METADATA_FIELDS.every(compatible)) return;
  throw new Error('memory vector filters are still becoming visible; retry the deployment');
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

const STORE_SECRETS_PAGE = 100;
const STORE_SECRETS_PAGES = 100;
/** Wrangler's answer to a store-secret page past the last one, or to an empty store. */
const NO_STORE_SECRETS = /List request returned no secrets/;
const STORE_SECRETS_HEADER = /│\s*Name\s*│\s*ID\s*│/;
const STORE_SECRET_ROW = /│\s*([A-Za-z0-9_-]+)\s*│\s*[0-9a-f]{32}\s*│/g;

/**
 * The names of every secret `storeId` holds, read page by page without writing. Wrangler prints each page as a table;
 * a page it answers without that table, or a failure other than its answer for an empty page, is thrown, so an
 * unreadable list never reads as a store that lacks a secret.
 */
export async function storeSecretNames(options: CloudflareOptions & { storeId: string }): Promise<string[]> {
  const { runner, env } = resolved(options);
  const names: string[] = [];
  for (let page = 1; page <= STORE_SECRETS_PAGES; page += 1) {
    const args = wrangler('secrets-store', 'secret', 'list', options.storeId, '--remote', '--page', String(page), '--per-page', String(STORE_SECRETS_PAGE));
    const listed = await runner.run('npx', args, { cwd: options.configDir, env });
    if (NO_STORE_SECRETS.test(listed.stdout + listed.stderr)) return names;
    if (listed.code !== 0) throw new CommandFailed('npx', args, listed);
    if (!STORE_SECRETS_HEADER.test(listed.stdout)) throw new Error(`the secret list of store ${options.storeId} is unreadable`);
    const rows = [...listed.stdout.matchAll(STORE_SECRET_ROW)].map((m) => m[1]!);
    names.push(...rows);
    if (rows.length < STORE_SECRETS_PAGE) return names;
  }
  throw new Error(`the secret list of store ${options.storeId} runs past ${STORE_SECRETS_PAGES * STORE_SECRETS_PAGE} secrets`);
}

/** The secrets store this account holds, read without creating one; null where it holds none. A failed list is thrown. */
export async function findSecretsStore(options: CloudflareOptions): Promise<string | null> {
  const { runner, env } = resolved(options);
  const listed = await runOrThrow(runner, 'npx', wrangler('secrets-store', 'store', 'list', '--remote'), { cwd: options.configDir, env });
  return /[0-9a-f]{32}/.exec(listed.stdout)?.[0] ?? null;
}

/** The names of the secrets a deployed Worker holds. Any failure to list them is thrown, never read as a Worker without one. */
export async function workerSecretNames(options: CloudflareOptions & { workerName: string }): Promise<string[]> {
  const { runner, env } = resolved(options);
  const listed = await runOrThrow(runner, 'npx', wrangler('secret', 'list', '--name', options.workerName), { cwd: options.configDir, env });
  const rows: unknown = jsonDocument(listed.stdout);
  if (!Array.isArray(rows)) throw new Error(`the secret list of ${options.workerName} is unreadable`);
  return rows.flatMap((row) => (typeof row?.name === 'string' ? [row.name as string] : []));
}

/** `workerSecretNames`, with wrangler's answer that no Worker of the name exists read as null: a plan of a Deployment not yet created. */
export async function deployedWorkerSecretNames(options: CloudflareOptions & { workerName: string }): Promise<string[] | null> {
  try {
    return await workerSecretNames(options);
  } catch (error) {
    const said = error instanceof CommandFailed ? error.stdout + error.stderr : '';
    if (/\b10007\b/.test(said) || said.includes(`Worker "${options.workerName}" not found`)) return null;
    throw error;
  }
}

/** The D1 databases, R2 buckets and Vectorize indexes this account holds, by name, read without writing. */
export async function accountResourceNames(options: CloudflareOptions): Promise<{ databases: string[]; buckets: string[]; vectorIndexes: string[] }> {
  const { runner, env } = resolved(options);
  const read = (...args: string[]) => runOrThrow(runner, 'npx', wrangler(...args), { cwd: options.configDir, env });
  const databases = jsonDocument((await read('d1', 'list', '--json')).stdout);
  const indexes = jsonDocument((await read('vectorize', 'list', '--json')).stdout);
  const buckets = (await read('r2', 'bucket', 'list')).stdout;
  return {
    databases: Array.isArray(databases) ? databases.flatMap((d) => (typeof d?.name === 'string' ? [d.name as string] : [])) : [],
    vectorIndexes: Array.isArray(indexes) ? indexes.flatMap((d) => (typeof d?.name === 'string' ? [d.name as string] : [])) : [],
    buckets: [...buckets.matchAll(/^name:\s*(\S+)/gm)].map((m) => m[1]!),
  };
}

/** Install the wrapping key in the store, value on stdin, never argv. */
export async function putStoreSecret(options: CloudflareOptions & { storeId: string; name: string; value: string }): Promise<void> {
  await privateCommand(options,
    ['secrets-store', 'secret', 'create', options.storeId, '--name', options.name, '--scopes', 'workers', '--remote'],
    options.value, 'Cloudflare wrapping-key installation');
}

/** Install one Worker secret, value on stdin, never argv. */
export async function putWorkerSecretValue(options: CloudflareOptions & { workerName: string; name: string; value: string }): Promise<void> {
  await privateCommand(options, ['secret', 'put', options.name, '--name', options.workerName],
    options.value, 'Cloudflare Worker secret installation');
}

/** Import a private SQL file without copying its contents into command diagnostics. */
export async function importCloudflareDatabase(options: CloudflareOptions & { databaseName: string; file: string }): Promise<void> {
  await privateCommand(options,
    ['d1', 'execute', options.databaseName, '--remote', '--yes', '--file', options.file, ...configArgs(options)],
    undefined, 'Cloudflare recovery import', 30 * 60_000);
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

/** Only the provider's explicit missing-Worker response permits fresh recovery provisioning. */
export async function assertCloudflareWorkerAbsent(options: CloudflareOptions & { workerName: string }): Promise<void> {
  const { runner, env } = resolved(options);
  const args = wrangler('deployments', 'list', '--name', options.workerName);
  const result = await runner.run('npx', args, { cwd: options.configDir, env });
  if (result.code === 0) throw new Error('refusing to adopt an existing recovery Worker');
  if (/\b10007\b/.test(result.stdout + result.stderr)) return;
  throw new CommandFailed('npx', args, result);
}

/**
 * How long one D1 statement may take.
 *
 * Every caller states a bound, because the window a hold covers is the window a deletion defers in, and a command
 * that answers nothing holds its operator there indefinitely. Past this the command and the processes it started are
 * ended — `npx` runs Wrangler as a child of its own, so ending the command alone would leave the process that sends
 * statements running. What that cannot do is take back a statement D1 already accepted: the outcome is unknown, and
 * the caller settles it by reading its own token back.
 */
export const D1_STATEMENT_TIMEOUT_MS = 60_000;

/**
 * One statement against the recorded D1 database, through the operator's own Wrangler sign-in, answering how many rows
 * it changed. Used for the recovery hold a hosted backup takes: an INSERT or UPDATE the provider may answer for late or
 * not at all, which is why the caller reads the hold back by its token rather than trusting this count.
 */
export async function runCloudflareStatement(
  options: CloudflareOptions & { databaseName: string; sql: string; timeoutMs: number },
): Promise<{ changes: number }> {
  const { runner, env } = resolved(options);
  const result = await runOrThrow(runner, 'npx',
    wrangler('d1', 'execute', options.databaseName, '--remote', '--json', '--command', options.sql, ...configArgs(options)),
    { cwd: options.configDir, env, timeoutMs: options.timeoutMs });
  const answer = wranglerJson<Array<{ success: boolean; meta?: { changes?: number } }>>(result.stdout);
  if (answer?.length !== 1 || answer[0]?.success !== true) throw new Error('D1 did not answer one successful statement');
  return { changes: Number(answer[0].meta?.changes ?? 0) };
}

/** Read operator metadata from the explicitly bound remote database, inside the window the caller gives it. */
export async function queryCloudflareDatabase(
  options: CloudflareOptions & { databaseName: string; sql: string; timeoutMs: number },
): Promise<unknown> {
  const { runner, env } = resolved(options);
  const result = await runOrThrow(runner, 'npx',
    wrangler('d1', 'execute', options.databaseName, '--remote', '--json', '--command', options.sql, ...configArgs(options)),
    { cwd: options.configDir, env, timeoutMs: options.timeoutMs });
  const answer = wranglerJson<Array<{ success: boolean; results: unknown }>>(result.stdout);
  if (answer?.length !== 1 || answer[0]?.success !== true || !Array.isArray(answer[0].results)) {
    throw new Error('D1 returned no successful recovery metadata result');
  }
  return answer[0].results;
}

/**
 * How long an object read may wait, as two windows rather than one over the whole transfer: the response must begin
 * inside `responseMs`, and each read of its body must bring bytes inside `stallMs`. A large object on a slow link keeps
 * going for as long as bytes keep arriving, and a stalled one ends within one window wherever it stalls. Only time
 * spent waiting on Cloudflare counts: a body nobody is reading yet is not stalled.
 */
export interface OperatorObjectTimeouts { responseMs: number; stallMs: number }
const OPERATOR_OBJECT_TIMEOUTS: OperatorObjectTimeouts = { responseMs: 60_000, stallMs: 60_000 };
/** An upload's progress is not observable from here, so one window bounds its whole request and acknowledgement. */
const OPERATOR_UPLOAD_TIMEOUT_MS = 120_000;
const OPERATOR_AUTH_TIMEOUT_MS = 30_000;
const OPERATOR_UPLOAD_MAX_BYTES = 300_000_000;
export const OPERATOR_NETWORK_RETRY_BUDGET_MS = 15 * 60_000;
export const OPERATOR_NETWORK_BACKOFF_MIN_MS = 2_000;
export const OPERATOR_NETWORK_BACKOFF_MAX_MS = 60_000;
const OPERATOR_NETWORK_REPORT_INTERVAL_MS = 60_000;
const OPERATOR_NETWORK_JITTER_FLOOR = 0.5;
export interface OperatorNetworkRetry {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}
export interface OperatorObjectOptions {
  bucketName: string;
  fetch?: CloudflareFetch;
  timeouts?: OperatorObjectTimeouts;
  login?: OperatorLogin;
  networkRetry?: OperatorNetworkRetry;
  report?: (line: string) => void;
}
interface OperatorObjectBudget {
  started: number | null;
  deadline: number;
  lastReport: number;
  backoff: number;
  failure: unknown;
}
export type CloudflareFetch = (url: string, init: RequestInit) => Promise<Response>;
const headerValue = z.string().min(1).regex(/^[\x21-\x7e]+$/);
const operatorCredentials = z.discriminatedUnion('type', [
  z.object({ type: z.literal('oauth'), token: headerValue }),
  z.object({ type: z.literal('api_token'), token: headerValue }),
  z.object({ type: z.literal('api_key'), key: headerValue, email: headerValue }),
]);

const seconds = (ms: number): string => `${ms / 1000} s`;

/**
 * `body`, failing any read that waits on the source longer than `stallMs` with a transient `ObjectReadError`, and
 * ending the request through `abort` so its connection is not left open. A read is only timed while one is asked for.
 */
function stallBounded(
  body: ReadableStream<Uint8Array>, stallMs: number, abort: (reason: Error) => void, key: string,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ObjectReadError(`Cloudflare object read for ${key} stalled: no bytes arrived for ${seconds(stallMs)}`, { transient: true })), stallMs);
      });
      try {
        const chunk = await Promise.race([reader.read(), stalled]);
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch (error) {
        const reason = error instanceof Error ? error : new Error(String(error));
        abort(reason);
        await reader.cancel(reason).catch(() => {});
        throw reason;
      } finally { clearTimeout(timer); }
    },
    async cancel(reason) {
      abort(reason instanceof Error ? reason : new Error('the object read was cancelled'));
      await reader.cancel(reason).catch(() => {});
    },
  }, { highWaterMark: 0 });
}

/**
 * The operator's own Wrangler login as request headers, asked for once and shared by every request while it holds.
 * A login that failed is dropped, so the next request asks again; `refused` drops one the provider turned away.
 */
export interface OperatorLogin {
  headers(): Promise<Headers>;
  refused(used: Promise<Headers>): void;
  current(): Promise<Headers>;
}

export function operatorLogin(options: CloudflareOptions): OperatorLogin {
  const { runner, env } = resolved(options);
  let credentials: Promise<Headers> | undefined;
  const authenticate = async (): Promise<Headers> => {
    const result = await runner.run('npx', wrangler('auth', 'token', '--json'), {
      cwd: options.configDir,
      timeoutMs: OPERATOR_AUTH_TIMEOUT_MS,
      env: { ...env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG: 'log', WRANGLER_LOG_SANITIZE: 'true' },
    });
    if (result.code !== 0) throw new Error(`Wrangler could not provide operator credentials (exit ${result.code}); check wrangler whoami and support for auth token --json`);
    const parsed = operatorCredentials.safeParse(wranglerJson<unknown>(result.stdout));
    if (!parsed.success) throw new Error('Wrangler returned unreadable operator credentials');
    return parsed.data.type === 'api_key'
      ? new Headers({ 'X-Auth-Key': parsed.data.key, 'X-Auth-Email': parsed.data.email })
      : new Headers({ Authorization: `Bearer ${parsed.data.token}` });
  };
  const login = (): Promise<Headers> => {
    const pending: Promise<Headers> = authenticate().catch((error: unknown) => {
      if (credentials === pending) credentials = undefined;
      throw error;
    });
    return pending;
  };
  return {
    current() { credentials ??= login(); return credentials; },
    async headers() { return new Headers(await this.current()); },
    refused(used) { if (credentials === used) credentials = undefined; },
  };
}

/** Stream R2 transfers through one origin and one in-memory operator credential. */
export function cloudflareObjectStore(
  options: CloudflareOptions & OperatorObjectOptions,
): { get(key: string, readScope?: object): Promise<ReadableStream | null>; put(key: string, body: () => Blob): Promise<void> } {
  const fetchObject = options.fetch ?? globalThis.fetch;
  const timeouts = options.timeouts ?? OPERATOR_OBJECT_TIMEOUTS;
  const operator = options.login ?? operatorLogin(options);
  const now = options.networkRetry?.now ?? Date.now;
  const sleep = options.networkRetry?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.networkRetry?.random ?? Math.random;
  const report = options.report ?? ((line: string) => console.error(line));
  const budgets = new WeakMap<object, OperatorObjectBudget>();
  const connectedFetch = async (key: string, url: string, init: () => RequestInit, responseMs: number, message: string, budget: OperatorObjectBudget): Promise<{ response: Response; abort: (reason: Error) => void; finish: () => void }> => {
    let retrying = false;
    const exhausted = (): ObjectReadError => new ObjectReadError(
      `Cloudflare network unreachable after ${OPERATOR_NETWORK_RETRY_BUDGET_MS / 60_000} minutes for object ${key}; no response headers: ${objectReadFailureDetail(budget.failure)}`,
      { transient: false, cause: budget.failure },
    );
    for (;;) {
      if (retrying && now() >= budget.deadline) throw exhausted();
      const requestInit = init();
      const ending = new AbortController();
      const abort = (reason: Error): void => { ending.abort(reason); };
      const attemptStarted = now();
      const timeout = (): void => abort(new DOMException(message, 'TimeoutError'));
      const windowMs = requestInit.method === 'PUT' ? responseMs
        : Math.min(responseMs, budget.deadline > now() ? budget.deadline - now() : responseMs);
      let timer = setTimeout(timeout, windowMs);
      try {
        const response = await fetchObject(url, { ...requestInit, signal: ending.signal });
        clearTimeout(timer);
        if (requestInit.method === 'PUT') timer = setTimeout(timeout, Math.max(0, responseMs - (now() - attemptStarted)));
        return { response, abort, finish: () => clearTimeout(timer) };
      } catch (error) {
        clearTimeout(timer);
        const failure = ending.signal.aborted ? ending.signal.reason : error;
        if (!connectionFailure(failure, requestInit.method !== 'PUT')) throw error;
        budget.failure = failure;
        if (budget.started === null) {
          budget.started = attemptStarted;
          budget.deadline = attemptStarted + OPERATOR_NETWORK_RETRY_BUDGET_MS;
          budget.lastReport = attemptStarted;
        }
        retrying = true;
      }
      const elapsed = now() - budget.started!;
      if (now() >= budget.deadline) throw exhausted();
      if (now() - budget.lastReport >= OPERATOR_NETWORK_REPORT_INTERVAL_MS) {
        report(`network unreachable; still retrying (${Math.floor(elapsed / 60_000)}m)`);
        budget.lastReport = now();
      }
      const jittered = budget.backoff * (OPERATOR_NETWORK_JITTER_FLOOR + random() * (1 - OPERATOR_NETWORK_JITTER_FLOOR));
      await sleep(Math.min(jittered, Math.max(0, budget.deadline - now())));
      budget.backoff = Math.min(budget.backoff * 2, OPERATOR_NETWORK_BACKOFF_MAX_MS);
    }
  };
  /**
   * One request, with the credential refreshed once on a 401 or 403. A read's window closes when its response begins,
   * and `abort` ends the request afterwards; an upload's window covers the request and its acknowledgement.
   */
  const request = async (key: string, method: 'GET' | 'PUT', body?: () => Blob, readScope: object = {}): Promise<{ response: Response; abort: (reason: Error) => void; finish: () => void }> => {
    const segment = (value: string): string => {
      if (value === '' || value === '.' || value === '..') throw new Error('Cloudflare object path has an invalid segment');
      return encodeURIComponent(value);
    };
    const objectPath = key.split('/').map(segment).join('/');
    const url = `https://api.cloudflare.com/client/v4/accounts/${segment(options.accountId)}/r2/buckets/${segment(options.bucketName)}/objects/${objectPath}`;
    let budget = budgets.get(readScope);
    if (budget === undefined) {
      budget = { started: null, deadline: Infinity, lastReport: 0, backoff: OPERATOR_NETWORK_BACKOFF_MIN_MS, failure: undefined };
      budgets.set(readScope, budget);
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const used = operator.current();
      const headers = new Headers(await used);
      if (method === 'GET') {
        // R2 otherwise gzips the object in transit; asking for its stored bytes avoids a decode a lost connection can cut short.
        headers.set('accept-encoding', 'identity');
      }
      const { response, abort, finish } = await connectedFetch(key, url, () => {
        const content = body?.();
        if (content !== undefined) {
          if (content.size > OPERATOR_UPLOAD_MAX_BYTES) throw new Error('Cloudflare operator uploads are limited to 300 MB per object');
          headers.set('content-type', 'application/octet-stream');
          headers.set('content-length', String(content.size));
        }
        return { method, headers, ...(content === undefined ? {} : { body: content }), redirect: 'error' };
      }, method === 'GET' ? timeouts.responseMs : OPERATOR_UPLOAD_TIMEOUT_MS,
      method === 'GET' ? `Cloudflare did not begin answering the read of ${key} within ${seconds(timeouts.responseMs)}`
        : `Cloudflare did not begin answering the write of ${key} within ${seconds(OPERATOR_UPLOAD_TIMEOUT_MS)}`, budget);
      if ((response.status === 401 || response.status === 403) && attempt === 0) {
        try { await response.body?.cancel(); } finally { finish(); }
        operator.refused(used);
        continue;
      }
      return { response, abort, finish };
    }
    throw new Error('Cloudflare refused the refreshed operator credential');
  };
  return {
    async get(key, readScope) {
      const { response, abort } = await request(key, 'GET', undefined, readScope);
      if (response.status === 404) { await response.body?.cancel(); return null; }
      if (response.status !== 200 || response.body === null) {
        await response.body?.cancel();
        throw new ObjectReadError(`Cloudflare object read failed for ${key} (HTTP ${response.status})`, { transient: transientStatus(response.status) });
      }
      return stallBounded(response.body, timeouts.stallMs, abort, key);
    },
    async put(key, body) {
      const { response, finish } = await request(key, 'PUT', body);
      try {
        if (response.status !== 200) {
          await response.body?.cancel();
          throw new Error(`Cloudflare object write failed for ${key} (HTTP ${response.status})`);
        }
        const result = z.object({ success: z.literal(true) }).safeParse(await response.json().catch(() => undefined));
        if (!result.success) throw new Error(`Cloudflare did not confirm object write for ${key}`);
      } finally { finish(); }
    },
  };
}

/** Required backup objects must exist; a missing source is a failed backup. */
export function cloudflareBlobReader(
  options: CloudflareOptions & OperatorObjectOptions,
): (key: string, readScope?: object) => Promise<ReadableStream> {
  const store = cloudflareObjectStore(options);
  return async (key, readScope) => {
    const body = await store.get(key, readScope);
    if (body === null) throw new ObjectReadError(`Cloudflare object read failed for ${key} (HTTP 404); retry the backup after resolving the source failure`, { transient: false });
    return body;
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
  /** The vector index serving this Deployment; omitted records use the default index. */
  vectorIndexName?: string;
  /** The wrapping secret in the selected store; omitted records use the default secret. */
  wrapKeySecretName?: string;
  /** The store a recovery staging is written to; omitted records use the name derived from the Worker's own. */
  recoveryBucketName?: string;
  /** How many runs the Deployment may have in flight at once, set by `myco server config --fleet`; the dispatcher counts against it. */
  fleet?: number;
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
  /** Whose machine state the command directory belongs to; this machine's by default. */
  mycoHome?: string;
}

/**
 * What this machine must already have before a Cloudflare command can do
 * anything. Every one of these is refused by name, in one line: the alternative
 * is wrangler's own message about a variable an operator never heard of.
 */
export class WranglerNotReady extends Error {}

/** Raised when wrangler is not installed where `npx` would find it; `npx` would otherwise ask on stdin whether to fetch it, and stdin carries the secrets. */
export class WranglerAbsent extends WranglerNotReady {
  constructor() {
    super('wrangler is not installed; `npm install -g wrangler`, then `wrangler login`, and retry');
    this.name = 'WranglerAbsent';
  }
}

/** Raised when wrangler answers but reaches no Cloudflare account, which every command here needs before it touches anything. */
export class WranglerNotSignedIn extends WranglerNotReady {
  constructor() {
    super(
      'wrangler is installed and signed in to no Cloudflare account; run `wrangler login` on this machine, '
      + 'or set CLOUDFLARE_API_TOKEN in a shell that cannot open a browser (a token in the environment is taken on trust), and retry',
    );
    this.name = 'WranglerNotSignedIn';
  }
}

/** The environment variable wrangler authenticates with where no browser can open. */
const API_TOKEN_ENV = 'CLOUDFLARE_API_TOKEN';

/** True when `npx` resolves wrangler without fetching it. */
export async function wranglerPresent(runner: CommandRunner = systemRunner(), cwd?: string): Promise<boolean> {
  const result = await runner.run('npx', wrangler('--version'), { ...(cwd === undefined ? {} : { cwd }) });
  return result.code === 0;
}

/** Refuse unless wrangler answers where the commands run. */
export async function assertWranglerPresent(runner: CommandRunner = systemRunner(), cwd?: string): Promise<void> {
  if (!(await wranglerPresent(runner, cwd))) throw new WranglerAbsent();
}

export interface WranglerReadiness {
  runner?: CommandRunner;
  /** Where the check runs, which is where the commands it clears run: `npx` resolves wrangler from there. */
  cwd?: string;
  /** Where a version note goes; nothing is reported when the versions agree. */
  report?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

/** The version in a `wrangler --version` line, or null when it prints none. */
function versionOf(printed: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(printed)?.[1] ?? null;
}

/**
 * Everything wrangler must be before a Cloudflare command runs: installed, and
 * holding a Cloudflare identity.
 *
 * Both are checked where the commands run, because `npx` resolves wrangler from
 * its working directory: a check that passed somewhere else clears a command
 * that fails. The token, when the environment carries one, is the identity and
 * is taken on trust: verifying it costs a request to Cloudflare, and a token
 * that is stale or scoped wrong fails in the first real command's own words.
 * `whoami` is what an interactive login is asked for.
 *
 * The bundled-version comparison is a note, not a refusal: the Worker travels
 * in this binary already built, so a wrangler of another version uploads it
 * rather than rebuilds it. A different MAJOR reads the deploy config by its own
 * rules, which is worth saying out loud before an operator reads a config error.
 */
export async function assertWranglerReady(readiness: WranglerReadiness = {}): Promise<void> {
  const runner = readiness.runner ?? systemRunner();
  const where = readiness.cwd === undefined ? {} : { cwd: readiness.cwd };
  const version = await runner.run('npx', wrangler('--version'), where);
  if (version.code !== 0) throw new WranglerAbsent();

  const installed = versionOf(version.stdout + version.stderr);
  if (installed !== null && installed.split('.')[0] !== BUNDLED_WORKER_WRANGLER.split('.')[0]) {
    readiness.report?.(`wrangler ${installed} is a major version away from the ${BUNDLED_WORKER_WRANGLER} this binary's Worker was built with; a deploy config error is the first place that shows.`);
  }

  const env = readiness.env ?? process.env;
  if ((env[API_TOKEN_ENV] ?? '').trim() !== '') return;
  const who = await runner.run('npx', wrangler('whoami'), where);
  if (who.code !== 0) throw new WranglerNotSignedIn();
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
  const cwd = ensureCommandDir(target.mycoHome);
  await assertWranglerPresent(runner, cwd);
  await privateCommand({ accountId: target.accountId, runner, configDir: cwd },
    ['secret', 'bulk', '--name', target.workerName], JSON.stringify(secrets), 'Cloudflare Worker secrets installation');
}

/**
 * The directory every command here spawns in, on disk.
 *
 * Wrangler walks UP from its working directory looking for a configuration, so a
 * command run from wherever the operator stands can pick up a checkout's
 * `wrangler.toml`; this directory is the binary's own and holds none. It sits
 * beside the deployment record, and it is created on the way to the command
 * rather than by whatever happens to write a file first — a spawn into a
 * directory that is not there reports a missing COMMAND.
 */
export function ensureCommandDir(mycoHome?: string): string {
  const dir = path.dirname(deploymentRecordPath(mycoHome));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function deploymentRecordPath(mycoHome = resolveMycoHome()): string {
  ensureServerLayout(mycoHome);
  return path.join(mycoHome, 'server', 'cloudflare', 'record.json');
}

export function writeDeploymentRecord(record: DeploymentRecord, mycoHome = resolveMycoHome()): void {
  withCloudflareOperation(mycoHome, () => {
    const file = deploymentRecordPath(mycoHome);
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    atomicWriteFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, durable: true });
  });
}

/**
 * The deployment record as it stands, read without moving any file: the per-target path, else the single-directory
 * layout's. A plan reads this so it writes nothing under the home.
 */
export function peekDeploymentRecord(mycoHome = resolveMycoHome()): DeploymentRecord | null {
  for (const file of [path.join(mycoHome, 'server', 'cloudflare', 'record.json'), path.join(mycoHome, 'server', 'cloudflare.json')]) {
    if (!existsSync(file)) continue;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as DeploymentRecord;
    } catch (err) {
      throw new Error(`${file} is not readable as a deployment record: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
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
