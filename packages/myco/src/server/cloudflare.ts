/**
 * Cloudflare Deployment lifecycle, as operator code.
 *
 * Lifecycle commands run through {@link CommandRunner}.
 *
 * Cloudflare management credentials are never handed to the deployed
 * application: everything here runs `wrangler` on the operator's machine
 * against the operator's own login. The Worker holds bindings, not an API
 * token that could re-provision the account it runs in.
 */
import { OPERATOR_AUTH_TIMEOUT_MS, readCloudflarePropagation } from '@myco/server/cloudflare-read.js';
import type { WorkerRetry } from '@myco/server/cloudflare-worker-update.js';
import nodeFs from 'node:fs';
const { existsSync, readFileSync, mkdirSync } = nodeFs;
import path from 'node:path';
import { z } from 'zod';
import { satisfies, valid } from 'semver';
import { resolveMycoHome, resolveMycoHomeWithSource } from '../paths/home.js';
import { ensureServerLayout } from './layout.js';
import { CommandFailed, CommandTimedOut, jsonDocument, runOrThrow, type CommandRunner, type CommandResult, type RunOptions } from './runner.js';
import { CLOUDFLARE_SETUP_COMMAND, TOOL_CHECK_TIMEOUT_MS, readWranglerVersion as toolVersion, wranglerVersionDiagnostic as versionDiagnostic } from './cloudflare-tool-version.js';
import { CloudflareToolFiles } from './cloudflare-tool-files.js';
import { cloudflareRunner, operatorWranglerEntry } from './cloudflare-runner.js';
import { cloudflareResources } from './cloudflare-resources.js';
import { BUNDLED_WORKER_WRANGLER, BUNDLED_WORKER_NODE } from '../worker-bundle.generated.js';
import { VECTOR_INDEX_DIMENSIONS, VECTOR_METADATA_FIELDS } from './vector-config.js';
import { withCloudflareOperation } from './cloudflare-operation.js';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { commandLine } from '@goondocks/myco-shared/shell-command';
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
  mycoHome?: string;
  runner?: CommandRunner;
  /** Directory holding `wrangler.toml`; the deployment's source of truth. */
  configDir: string;
  /** A derived config inside `configDir` (`wrangler.deploy.toml`); commands read the committed file without one. */
  configFile?: string;
}

function resolved(options: CloudflareOptions): { runner: CommandRunner; env: NodeJS.ProcessEnv } {
  if (!options.accountId) throw new AccountNotSelected([]);
  return {
    runner: credentialRunner(options.runner ?? cloudflareRunner(), process.env, options.accountId, () => {
      const file = path.resolve(options.configDir, options.configFile ?? 'wrangler.toml');
      if (!existsSync(file)) return false;
      const config = readFileSync(file, 'utf8');
      return /^\s*(?:routes?\s*=|\[\[routes\]\])/m.test(config);
    }),
    // Pinned per invocation rather than exported once: a command that outlives
    // this process must not inherit an account selection it never asked for.
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: options.accountId },
  };
}

/** Canonical environment names suppress their deprecated aliases even when empty. */
function cloudflareCredentialVariables(env: NodeJS.ProcessEnv) {
  const variable = (canonical: string, alias: string) => {
    const name = canonical in env || !(alias in env) ? canonical : alias;
    return { name, value: env[name] };
  };
  return {
    key: variable('CLOUDFLARE_API_KEY', 'CF_API_KEY'),
    email: variable('CLOUDFLARE_EMAIL', 'CF_EMAIL'),
    token: variable('CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN'),
  };
}

/** Wrangler's credential precedence, with no credential values in diagnostics. */
export function cloudflareCredentialSource(env: NodeJS.ProcessEnv = process.env): string {
  const { key, email, token } = cloudflareCredentialVariables(env);
  if (key.value && email.value) return `${key.name} in the environment`;
  if (token.value) return `${token.name} in the environment`;
  return 'OAuth login';
}

const CLOUDFLARE_CREDENTIAL_NAMES = ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'CLOUDFLARE_API_KEY', 'CF_API_KEY', 'CLOUDFLARE_EMAIL', 'CF_EMAIL'] as const;

const OAUTH_ENV_FIX = 'unset CLOUDFLARE_API_TOKEN and CLOUDFLARE_API_KEY, plus deprecated aliases CF_API_TOKEN and CF_API_KEY';

/** Credential source and recovery guidance shared by CLI verbs and lifecycle preflight. */
export function cloudflareCredentialLines(env: NodeJS.ProcessEnv = process.env): string[] {
  const source = cloudflareCredentialSource(env);
  const { key, email } = cloudflareCredentialVariables(env);
  return [
    `Wrangler credential: ${source}.`,
    ...(key.value && !email.value
      ? [`${key.name} is set without ${email.name}; Wrangler cannot use that key. Set both for API-key authentication, or unset the key to use OAuth.`] : []),
    ...(source === 'OAuth login' ? [] : [`Warning: this environment credential overrides the OAuth login. It must reach the deployment account and every required resource. To use that account's login, ${OAUTH_ENV_FIX} in this shell; CI may keep a credential with the required permissions.`]),
  ];
}

const AUTHENTICATION_ERROR = /(?:\[code:\s*10000\]|"code"\s*:\s*10000\b)/;

/** Code 10000 is an explicit provider refusal, not an unacknowledged mutation. */
export function isCloudflareAuthenticationRefusal(result: CommandResult): boolean {
  return result.code !== 0 && AUTHENTICATION_ERROR.test(result.stdout + result.stderr);
}

/** Only endpoint paths and structured permission hints survive provider diagnostics. */
function authenticationDiagnostic(result: CommandResult, env: NodeJS.ProcessEnv): string {
  const output = result.stdout + '\n' + result.stderr;
  const endpoint = /A request to the Cloudflare API \((\/[^\s)?]+)(?:\?[^)]*)?\) failed/.exec(output)?.[1];
  const hints = [...output.matchAll(/(?:User|Account|Zone)(?:->[A-Za-z -]+)+->(?:Read|Edit|Write)\b/g)].map((match) => match[0]);
  let diagnostic = [
    ...(endpoint === undefined ? [] : [`Endpoint: ${endpoint}.`]),
    ...[...new Set(hints)].map((hint) => `Wrangler permission hint: ${hint}.`),
  ].join(' ');
  for (const name of CLOUDFLARE_CREDENTIAL_NAMES) {
    const value = env[name];
    if (!value) continue;
    const fragments = value.length < 4 ? [value] : Array.from({ length: value.length - 3 }, (_, index) => value.slice(index, index + 4));
    for (const fragment of fragments) diagnostic = diagnostic.split(fragment).join('[redacted]');
  }
  return diagnostic;
}

/** An authentication refusal retains diagnostic fields without private provider output. */
export class CloudflareAuthenticationError extends CommandFailed {
  constructor(command: string, args: readonly string[], result: CommandResult, env: NodeJS.ProcessEnv, accountId?: string, routes = false) {
    super(command, args.slice(0, 3), { code: result.code, stdout: '', stderr: 'Authentication error [code: 10000]' });
    this.name = 'CloudflareAuthenticationError';
    const product = args[2];
    const permissions: Record<string, string> = {
      vectorize: 'Vectorize Read for reads, or Vectorize Edit for changes',
      d1: 'D1 Read for reads, or D1 Edit for migrations and writes',
      r2: 'Workers R2 Storage Read for reads, or Workers R2 Storage Write for changes',
      'secrets-store': 'Secrets Store Read for reads, or Secrets Store Edit for changes',
      whoami: 'User Memberships Read',
    };
    const resource = product !== undefined && product in permissions ? product : 'Worker';
    const permission = permissions[product ?? ''] ?? 'Workers Scripts Read for reads, or Workers Scripts Edit for changes';
    this.message = `Cloudflare Authentication error [code: 10000] on ${resource}${accountId === undefined ? '' : ` in account ${accountId}`}. `
      + `Wrangler is using ${cloudflareCredentialSource(env)}. Likely missing permission: ${permission}${routes ? ', plus Zone / Workers Routes Edit for configured routes or custom domains' : ''}, or access to this account/resource. `
      + `For the deployment account OAuth login, ${OAUTH_ENV_FIX} in this shell and retry; `
      + 'for CI, grant the environment credential access to the deployment account and the named resource. '
      + authenticationDiagnostic(result, env);
  }
}

/** Every management command reports authentication refusals before callers interpret resource-specific failures. */
function credentialRunner(runner: CommandRunner, env: NodeJS.ProcessEnv, accountId?: string, hasRoutes?: () => boolean): CommandRunner {
  return {
    async run(command, args, options) {
      const result = await runner.run(command, args, options);
      if (isCloudflareAuthenticationRefusal(result)) {
        const changesRoutes = args[2] === 'deploy' || (args[2] === 'triggers' && args[3] === 'deploy');
        throw new CloudflareAuthenticationError(command, args, result, env, accountId, changesRoutes && hasRoutes?.());
      }
      return result;
    },
  };
}

/** Commands carrying private data withhold raw provider output and debug files on every failure path. */
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
  } catch (error) {
    if (error instanceof CloudflareAuthenticationError) throw error;
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

const CLOUDFLARE_IDENTITY = z.object({
  loggedIn: z.boolean(),
  accounts: z.array(z.object({ name: z.string(), id: z.string().regex(/^[0-9a-f]{32}$/) })).optional(),
});

function cloudflareIdentity(result: CommandResult): z.infer<typeof CLOUDFLARE_IDENTITY> | null {
  const document = wranglerJson<unknown>(result.stdout);
  const parsed = CLOUDFLARE_IDENTITY.safeParse(document);
  if ((typeof document === 'object' && document !== null && 'loggedIn' in document && document.loggedIn === false)
    || (document === null && /\bnot (?:authenticated|logged in)\b/i.test(result.stdout + result.stderr))) throw new WranglerNotSignedIn();
  if (result.code !== 0) throw new WranglerNotReady(`Wrangler whoami failed: ${versionDiagnostic(result)}`);
  if (document === null) return null;
  if (!parsed.success) throw new WranglerNotReady('Wrangler whoami --json returned no readable sign-in fact; repair the Wrangler installation and retry.');
  return parsed.data;
}

async function cloudflareWhoami(runner: CommandRunner, where: RunOptions): Promise<CommandResult> {
  const result = await runner.run('npx', wrangler('whoami', '--json'), where);
  const jsonRefused = /\b(?:unknown|unrecognized|unexpected|unsupported)\s+(?:argument|option)s?\b[^\n]*\bjson\b/i.test(result.stdout + result.stderr);
  return result.code !== 0 && wranglerJson(result.stdout) === null && jsonRefused
    ? runner.run('npx', wrangler('whoami'), where) : result;
}

/** Accounts this login can reach, for a caller that has to choose one. */
export async function listAccounts(runner: CommandRunner = cloudflareRunner(), mycoHome?: string): Promise<AccountRef[]> {
  const cwd = ensureCommandDir(mycoHome);
  const selected = await assertWranglerPresent(runner, cwd, mycoHome);
  const result = await cloudflareWhoami(credentialRunner(selected, process.env), { cwd });
  const identity = cloudflareIdentity(result);
  if (identity !== null) {
    if (identity.accounts === undefined) throw new WranglerNotReady('Wrangler whoami --json returned no account list; repair the Wrangler installation and retry.');
    return identity.accounts;
  }
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

/** Run a remote command with the selected account and binary-owned configuration. */
export async function runCloudflareCommand(options: CloudflareOptions, args: string[], timeoutMs?: number): Promise<CommandResult> {
  const { runner, env } = resolved(options);
  return runOrThrow(runner, 'npx', wrangler(...args, ...configArgs(options)), {
    cwd: options.configDir, env, ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

const TIME_TRAVEL_BOOKMARK = /^[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}$/i;

/** Capture the current remote D1 recovery point through the operator's bound configuration. */
export async function currentTimeTravelBookmark(options: CloudflareOptions & { databaseName: string }): Promise<string> {
  const result = await runCloudflareCommand(options,
    ['d1', 'time-travel', 'info', options.databaseName, '--json'], D1_STATEMENT_TIMEOUT_MS);
  const answer = z.object({ bookmark: z.string().regex(TIME_TRAVEL_BOOKMARK) }).safeParse(wranglerJson(result.stdout));
  if (!answer.success) throw new Error('D1 Time Travel returned no valid current bookmark');
  return answer.data.bookmark;
}

/** Zero names an empty database; populated databases require a positive live schema stamp. */
export async function cloudflareSchemaVersion(options: CloudflareOptions & { databaseName: string }): Promise<number> {
  const tables = z.array(z.object({ name: z.string() })).parse(await queryCloudflareDatabase({ ...options,
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name != 'd1_migrations'",
    timeoutMs: D1_STATEMENT_TIMEOUT_MS }));
  if (tables.length === 0) return 0;
  const rows = await queryCloudflareDatabase({ ...options,
    sql: "SELECT value FROM schema_meta WHERE key = 'version'", timeoutMs: D1_STATEMENT_TIMEOUT_MS });
  const answer = z.array(z.object({ value: z.string().regex(/^[1-9][0-9]*$/) })).length(1).safeParse(rows);
  if (!answer.success) throw new Error('D1 returned no valid schema version; schema update refused');
  const version = Number(answer.data[0]!.value);
  if (!Number.isSafeInteger(version)) throw new Error('D1 schema version is outside the supported range');
  return version;
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
  if (id === undefined) throw new Error(`wrangler created ${options.databaseName} without printing its id; run \`myco doctor\` to find the selected tool, use it for d1 list, and add databaseId to the deployment record`);
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
  const existing = await findSecretsStore(options);
  if (existing !== null) return { storeId: existing, created: false };
  const { runner, env } = resolved(options);
  const result = await runOrThrow(runner, 'npx', wrangler('secrets-store', 'store', 'create', 'myco', '--remote'), { cwd: options.configDir, env });
  const id = /[0-9a-f]{32}/.exec(result.stdout)?.[0];
  if (id === undefined) throw new Error('wrangler created the secrets store without printing its id; run `myco doctor` to find the selected tool, use it for secrets-store store list --remote, and add storeId to the deployment record');
  return { storeId: id, created: true };
}

const STORE_SECRETS_PAGE = 100;
const STORE_SECRETS_PAGES = 100;
/** Wrangler's answer to a store-secret page past the last one, or to an empty store. */
const NO_STORE_SECRETS = /List request returned no secrets/;
/** Wrangler's answer when the account has no secrets store. */
const NO_SECRETS_STORES = /List request returned no stores/;
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
  const args = wrangler('secrets-store', 'store', 'list', '--remote');
  const listed = await runner.run('npx', args, { cwd: options.configDir, env });
  if (NO_SECRETS_STORES.test(listed.stdout + listed.stderr)) return null;
  if (listed.code !== 0) throw new CommandFailed('npx', args, listed);
  return /[0-9a-f]{32}/.exec(listed.stdout)?.[0] ?? null;
}

/** The names of the secrets a deployed Worker holds. Any failure to list them is thrown, never read as a Worker without one. */
export async function workerSecretNames(options: CloudflareOptions & { workerName: string; timeoutMs?: number }): Promise<string[]> {
  const { runner, env } = resolved(options);
  const listed = await runOrThrow(runner, 'npx', wrangler('secret', 'list', '--name', options.workerName), { cwd: options.configDir, env, timeoutMs: options.timeoutMs });
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
  propagation?: string;
}

const VERSION_PROPAGATING = /(?:\[code:\s*100146\]|"code"\s*:\s*100146\b)/;
const VERSION_PROPAGATION_MAX_AGE_MS = 10 * 60_000;
const VERSION_PATH = /\/versions\/([0-9a-f-]{36})\b/i;
const WORKER_PROPAGATION_HINT = 'The new version is still propagating; check again shortly with `myco server status --target cloudflare`.';

export async function cloudflareStatus(options: CloudflareOptions & {
  workerName: string;
  activeVersion?: string | null;
  deployedAt?: string;
  readRetry?: WorkerRetry;
}): Promise<CloudflareStatus> {
  const { runner, env } = resolved(options);
  const args = wrangler('deployments', 'list', '--name', options.workerName);
  const propagating = (error: unknown): boolean => {
    const age = (options.readRetry?.now ?? Date.now)() - Date.parse(options.deployedAt ?? '');
    if (!(error instanceof CommandFailed) || !options.activeVersion || !(age >= 0 && age < VERSION_PROPAGATION_MAX_AGE_MS)) return false;
    const output = error.stdout + '\n' + error.stderr;
    const requested = VERSION_PATH.exec(output)?.[1];
    return VERSION_PROPAGATING.test(output) && requested === options.activeVersion;
  };
  let result: CommandResult;
  try {
    result = await readCloudflarePropagation({
      retry: options.readRetry,
      read: async timeoutMs => {
        const listed = await runner.run('npx', args, { cwd: options.configDir, env, timeoutMs });
        if (listed.code !== 0 && !/\b10007\b/.test(listed.stdout + listed.stderr)) throw new CommandFailed('npx', args, listed);
        return listed;
      },
      confirmed: () => true,
      retryError: propagating,
    });
  } catch (error) {
    if (propagating(error)) return { deployed: true, versionId: null, raw: '', propagation: WORKER_PROPAGATION_HINT };
    if (error instanceof CommandTimedOut) throw new Error(`Cloudflare Worker could not be read: ${error.message}`, { cause: error });
    throw error;
  }
  // Wrangler lists deployments oldest first.
  const latest = result.stdout.split(/^(?:Created:|Deployment ID:)\s*/m).at(-1) ?? '';
  const versions = [...latest.matchAll(/(?:Version ID:|Version\(s\):\s*\((\d+)%\))\s*([0-9a-f-]{36})/g)];
  const version = versions.length === 1 && (versions[0]![1] === undefined || versions[0]![1] === '100') ? versions[0]![2]! : null;
  return {
    deployed: result.code === 0 && result.stdout.trim() !== '',
    versionId: version,
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
  const { env } = resolved(options);
  let credentials: Promise<Headers> | undefined;
  let admitted: Promise<CommandRunner> | undefined;
  const authenticate = async (): Promise<Headers> => {
    const selected = await (admitted ??= assertWranglerReady({ runner: options.runner, cwd: options.configDir, mycoHome: options.mycoHome }).catch((error: unknown) => { admitted = undefined; throw error; }));
    const result = await credentialRunner(selected, env, options.accountId).run('npx', wrangler('auth', 'token', '--json'), {
      cwd: options.configDir,
      timeoutMs: OPERATOR_AUTH_TIMEOUT_MS,
      env: { ...env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG: 'log', WRANGLER_LOG_SANITIZE: 'true' },
    });
    if (result.code !== 0) throw new Error(`Wrangler could not provide operator credentials (exit ${result.code}); run ${CLOUDFLARE_SETUP_COMMAND}. Check sign-in, then use the selected tool shown by myco doctor to check support for auth token --json`);
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
  /** Provider-observed serving version before the latest admitted update attempt. */
  previousVersionId?: string | null;
  deployedAt: string;
  /** Binary release recorded after a successful Worker deployment; absent on older records. */
  release?: string;
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
  /** Recovery points persisted before hosted schema advances, including attempts that did not finish. */
  schemaUpdates?: CloudflareSchemaUpdate[];
}

export const cloudflareSchemaUpdateSchema = z.object({
  bookmark: z.string().regex(TIME_TRAVEL_BOOKMARK),
  schemaBefore: z.number().int().nonnegative(),
  schemaAfter: z.number().int().positive(),
  recordedAt: z.string().datetime(),
  workerVersionBefore: z.string().nullable(),
  appliedAt: z.string().datetime().optional(),
});
export type CloudflareSchemaUpdate = z.infer<typeof cloudflareSchemaUpdateSchema>;

/** A complete sign-in pair, optionally with its App key, or an independent key rotation. */
export type WorkerSecrets =
  | { GITHUB_CLIENT_ID: string; GITHUB_CLIENT_SECRET: string; GITHUB_APP_PRIVATE_KEY?: string }
  | { GITHUB_APP_PRIVATE_KEY: string; GITHUB_CLIENT_ID?: never; GITHUB_CLIENT_SECRET?: never };

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

/** Missing or incompatible Wrangler requires an explicit setup installation. */
export class WranglerAbsent extends WranglerNotReady {
  constructor(detail?: string) {
    super(`${detail ?? `A compatible Wrangler is not installed (required major ${BUNDLED_WORKER_WRANGLER.split('.')[0]})`}. Run \`${CLOUDFLARE_SETUP_COMMAND}\` to install or repair Myco's pinned Wrangler without root.`);
    this.name = 'WranglerAbsent';
  }
}

/** Node is an operator prerequisite, independent of the member binary. */
export class NodeAbsent extends WranglerNotReady {
  constructor() {
    super(`Node.js is not installed; install Node.js ${BUNDLED_WORKER_NODE} from https://nodejs.org/en/download, then run \`${CLOUDFLARE_SETUP_COMMAND}\`.`);
    this.name = 'NodeAbsent';
  }
}

export class NodeTooOld extends WranglerNotReady {
  constructor(found: string) {
    super(`Node.js ${found} does not meet Wrangler ${BUNDLED_WORKER_WRANGLER}'s requirement ${BUNDLED_WORKER_NODE}; install a supported Node.js from https://nodejs.org/en/download, then run \`${CLOUDFLARE_SETUP_COMMAND}\`.`);
    this.name = 'NodeTooOld';
  }
}

const TOOL_INSTALL_TIMEOUT_MS = 5 * 60_000;
const npmCommand = (name: 'npm' | 'npx') => process.platform === 'win32' ? `${name}.cmd` : name;

function toolFiles(home = resolveMycoHome()): CloudflareToolFiles { return new CloudflareToolFiles(home, BUNDLED_WORKER_WRANGLER); }

/** Tool discovery is offline and suppresses npm and Wrangler state writes. */
function toolEnvironment(readiness: WranglerReadiness, mode: 'probe' | 'install'): NodeJS.ProcessEnv {
  const overrides: NodeJS.ProcessEnv = {
    npm_config_cache: path.join(toolFiles(readiness.mycoHome).root, '.npm-cache'),
    npm_config_update_notifier: 'false', npm_config_logs_max: '0',
    npm_config_global: 'false', npm_config_location: 'project',
    WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false', NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '',
    ...(mode === 'probe' ? { npm_config_offline: 'true' } : {}),
  };
  const replaced = new Set(Object.keys(overrides).map(name => name.toLowerCase()));
  const base = Object.fromEntries(Object.entries(readiness.env ?? process.env).filter(([name]) => !/^(?:CLOUDFLARE_|CF_)/i.test(name) && !replaced.has(name.toLowerCase())));
  return { ...base, ...overrides };
}

const selectedTools = new WeakMap<CommandRunner, WranglerTool>();
const operationTools = new WeakMap<CommandRunner, { tool?: Promise<WranglerTool>; selected?: WranglerTool; raw: CommandRunner }>();

/** An operator operation retains its tool through all provider sub-operations. */
export function operationWranglerRunner(runner: CommandRunner = cloudflareRunner()): CommandRunner {
  if (selectedTools.has(runner) || operationTools.has(runner)) return runner;
  const state: { tool?: Promise<WranglerTool>; selected?: WranglerTool; raw: CommandRunner } = { raw: runner };
  const scoped: CommandRunner = { run: (command, args, options) => (state.selected?.runner ?? runner).run(command, args, options) };
  operationTools.set(scoped, state);
  return scoped;
}

export interface WranglerTool {
  ready?: Promise<void>;
  version: string;
  source: string;
  entry?: string;
  note?: string;
  runner: CommandRunner;
}

/** Preserve the selected tool when an operation adds a command observer. */
export function decorateWranglerRunner(runner: CommandRunner, decorate: (runner: CommandRunner) => CommandRunner): CommandRunner {
  const decorated = decorate(runner);
  const tool = selectedTools.get(runner);
  if (tool) selectedTools.set(decorated, { ...tool, runner: decorated });
  return decorated;
}

/** Map the canonical non-fetching invocation to the selected executable. */
function selectedRunner(runner: CommandRunner, entry?: string): CommandRunner {
  return { run(command, args, options) {
    if (command !== 'npx' || args[0] !== '--no-install' || args[1] !== 'wrangler') return runner.run(command, args, options);
    return entry === undefined ? runner.run(npmCommand('npx'), args, options)
      : runner.run('node', [entry, ...args.slice(2)], options);
  } };
}

/** One prerequisite decision for setup, diagnostics and every Cloudflare verb. */
export async function resolveWrangler(readiness: WranglerReadiness = {}): Promise<WranglerTool> {
  const runner = readiness.runner ?? cloudflareRunner();
  const scope = operationTools.get(runner);
  if (scope) {
    scope.tool ??= selectWrangler({ ...readiness, runner }).then(tool => { scope.selected = tool; return tool; }).catch((error: unknown) => { scope.tool = undefined; throw error; });
    return scope.tool;
  }
  return selectWrangler({ ...readiness, runner });
}

async function selectWrangler(readiness: WranglerReadiness & { runner: CommandRunner }): Promise<WranglerTool> {
  const runner = readiness.runner;
  const selected = selectedTools.get(runner);
  if (selected) return selected;
  const sourceRunner = operationTools.get(runner)?.raw ?? runner;
  const choose = (version: string, source: string, entry?: string, note?: string): WranglerTool => {
    const tool = { version, source, note, entry: entry ?? operatorWranglerEntry(sourceRunner), runner: selectedRunner(sourceRunner, entry) };
    selectedTools.set(tool.runner, tool);
    return tool;
  };
  const where = { cwd: wranglerCheckDirectory(readiness), env: toolEnvironment(readiness, 'probe'), signal: readiness.signal, timeoutMs: TOOL_CHECK_TIMEOUT_MS };
  let node: CommandResult;
  try { node = await sourceRunner.run('node', ['--version'], where); }
  catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') throw new NodeAbsent();
    throw error;
  }
  const nodeVersion = valid(node.stdout.trim());
  if (node.code !== 0 || nodeVersion === null) throw new WranglerNotReady(`Node.js version check failed: ${versionDiagnostic(node)}`);
  if (!satisfies(nodeVersion, BUNDLED_WORKER_NODE, { includePrerelease: true })) throw new NodeTooOld(nodeVersion);
  let operator: string;
  try {
    const result = await sourceRunner.run(npmCommand('npx'), wrangler('--version'), where);
    const version = toolVersion(result);
    if (version.split('.')[0] === BUNDLED_WORKER_WRANGLER.split('.')[0]) return choose(version, `operator installation${operatorWranglerEntry(sourceRunner) ? ` at ${operatorWranglerEntry(sourceRunner)}` : ' (local/global lookup)'}`);
    operator = `Operator Wrangler ${version} has a different major from ${BUNDLED_WORKER_WRANGLER}`;
  } catch (error) { operator = `Operator Wrangler unavailable: ${error instanceof Error ? error.message : String(error)}`; }
  const files = toolFiles(readiness.mycoHome);
  let owned: string;
  if (existsSync(files.entry())) {
    try {
      const version = toolVersion(await sourceRunner.run('node', [files.entry(), '--version'], where));
      if (version === BUNDLED_WORKER_WRANGLER) return choose(version, files.entry(), files.entry(), `${operator}; using Myco's pinned tool.`);
      owned = `Myco's Wrangler at ${files.directory} reports ${version}; required ${BUNDLED_WORKER_WRANGLER}`;
    } catch (error) { owned = `Myco's Wrangler at ${files.directory} is unusable: ${error instanceof Error ? error.message : String(error)}`; }
  } else if (existsSync(files.directory)) owned = `Myco's Wrangler at ${files.directory} has no executable`;
  else {
    const older = files.versions();
    owned = older.length ? `Myco-owned ${older.join(', ')} at ${files.root} does not provide pinned Wrangler ${BUNDLED_WORKER_WRANGLER}` : `Myco's pinned Wrangler ${BUNDLED_WORKER_WRANGLER} is not installed`;
  }
  const unfinished = files.unfinished();
  throw new WranglerAbsent(`${operator}. ${owned}${unfinished.length ? `. Unfinished installations at ${files.root}: ${unfinished.join(', ')}` : ''}`);
}

/** The sole writer of Myco's versioned tools directories; callers obtain consent first. */
export async function installWrangler(readiness: WranglerReadiness = {}): Promise<void> {
  const home = readiness.mycoHome ?? resolveMycoHome();
  await withCloudflareOperation(home, async () => {
    try { await resolveWrangler(readiness); return; }
    catch (error) { if (!(error instanceof WranglerAbsent)) throw error; }
    const files = toolFiles(home);
    const runner = readiness.runner ?? cloudflareRunner();
    await files.install({ runner, env: toolEnvironment({ ...readiness, mycoHome: home }, 'probe'), signal: readiness.signal, prepare: async (stage) => {
      const env = toolEnvironment({ ...readiness, mycoHome: home }, 'install');
      await runOrThrow(runner, npmCommand('npm'), ['install', '--prefix', stage, '--global=false', '--location=project', '--no-audit', '--no-fund', '--package-lock=false', `wrangler@${BUNDLED_WORKER_WRANGLER}`], {
        cwd: stage, env, signal: readiness.signal, timeoutMs: TOOL_INSTALL_TIMEOUT_MS,
      });
    } });
  });
}

export function wranglerToolLine(tool: WranglerTool): string {
  const selected = tool.entry === undefined ? tool.source
    : process.platform === 'win32' ? `node '${tool.entry.replaceAll("'", "''")}'` : commandLine(['node', tool.entry]);
  const executable = tool.entry === undefined ? selected : `\`${selected}\`${process.platform === 'win32' ? ' (PowerShell)' : ''}`;
  return `Wrangler ${tool.version}: ${executable}.${tool.note ? ` ${tool.note}` : ''}`;
}

/** Raised when wrangler answers but reaches no Cloudflare account, which every command here needs before it touches anything. */
export class WranglerNotSignedIn extends WranglerNotReady {
  constructor() {
    super(
      'Wrangler is signed in to no Cloudflare account; run `myco setup --create cloudflare` to sign in, '
      + 'or set CLOUDFLARE_API_TOKEN in a shell that cannot open a browser (a token in the environment is taken on trust), and retry',
    );
    this.name = 'WranglerNotSignedIn';
  }
}

/** Refuse unless the selected Wrangler is ready to run. */
export async function assertWranglerPresent(runner: CommandRunner = cloudflareRunner(), cwd?: string, mycoHome?: string): Promise<CommandRunner> {
  return (await resolveWrangler({ runner, cwd, mycoHome })).runner;
}

function wranglerCheckDirectory(readiness: WranglerReadiness): string {
  if (readiness.cwd !== undefined) return readiness.cwd;
  let cwd = peekCommandDir(readiness.mycoHome);
  while (!existsSync(cwd) && path.dirname(cwd) !== cwd) cwd = path.dirname(cwd);
  return cwd;
}

export interface WranglerReadiness {
  signal?: AbortSignal;
  mycoHome?: string;
  runner?: CommandRunner;
  /** Where the check runs, which is where the commands it clears run: `npx` resolves wrangler from there. */
  cwd?: string;
  /** Where prerequisite and credential observations are reported. */
  report?: (line: string) => void;
  env?: NodeJS.ProcessEnv;
}

/** The selected tool and structured sign-in fact admit every Cloudflare verb. */
export async function assertWranglerReady(readiness: WranglerReadiness = {}): Promise<CommandRunner> {
  const env = readiness.env ?? process.env;
  const tool = await resolveWrangler(readiness);
  tool.ready ??= (async () => {
    readiness.report?.(wranglerToolLine(tool));
    const runner = credentialRunner(tool.runner, env);
    if (cloudflareCredentialSource(env) === 'OAuth login') {
      const who = await cloudflareWhoami(runner, { cwd: wranglerCheckDirectory(readiness), env, signal: readiness.signal, timeoutMs: TOOL_CHECK_TIMEOUT_MS });
      cloudflareIdentity(who);
    }
    for (const line of cloudflareCredentialLines(env)) readiness.report?.(line);
  })().catch((error: unknown) => { tool.ready = undefined; throw error; });
  await tool.ready;
  return tool.runner;
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
  const cwd = ensureCommandDir(target.mycoHome);
  const runner = await assertWranglerPresent(target.runner ?? cloudflareRunner(), cwd, target.mycoHome);
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

/** Resolve the operator command directory without creating or migrating it. */
export function peekCommandDir(mycoHome = resolveMycoHome()): string {
  return path.dirname(peekDeploymentRecordPath(mycoHome));
}

export function peekDeploymentRecordPath(mycoHome = resolveMycoHome()): string {
  const current = path.join(mycoHome, 'server', 'cloudflare', 'record.json');
  const legacy = path.join(mycoHome, 'server', 'cloudflare.json');
  return existsSync(current) || !existsSync(legacy) ? current : legacy;
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

/** Apply operator configuration to the current record under its publication lease. */
export function updateDeploymentRecord(patch: Pick<DeploymentRecord, 'fleet' | 'url'>, mycoHome = resolveMycoHome()): DeploymentRecord {
  return withCloudflareOperation(mycoHome, () => {
    if (Object.keys(patch).some(key => key !== 'fleet' && key !== 'url')) {
      throw new Error('Cloudflare configuration updates accept only fleet and url');
    }
    const record = readDeploymentRecord(mycoHome);
    if (record === null) throw new Error(missingDeploymentRecordMessage(mycoHome));
    const updated = { ...record, ...patch };
    writeDeploymentRecord(updated, mycoHome);
    return updated;
  });
}

/**
 * The deployment record as it stands, read without moving any file: the per-target path, else the single-directory
 * layout's. A plan reads this so it writes nothing under the home.
 */
export function peekDeploymentRecord(mycoHome = resolveMycoHome()): DeploymentRecord | null {
  const file = peekDeploymentRecordPath(mycoHome);
  if (existsSync(file)) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as DeploymentRecord;
    } catch (err) {
      throw new Error(`${file} is not readable as a deployment record: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return null;
}

/** Describe the record lookup and, for a resolved home, the rule that chose it. */
export function missingDeploymentRecordMessage(mycoHome?: string): string {
  const resolved = mycoHome === undefined ? resolveMycoHomeWithSource() : { home: mycoHome, source: 'explicit' as const };
  let home: string;
  try { home = nodeFs.realpathSync.native(resolved.home); }
  catch { home = path.resolve(resolved.home); }
  const sentences = [`No Cloudflare Deployment record at ${peekDeploymentRecordPath(home)}.`];
  if (resolved.source === 'env') sentences.push('This home comes from MYCO_HOME (set in your environment or by a runtime pin).');
  else if (resolved.source === 'project-pin' || resolved.source === 'machine-pin') {
    sentences.push(`This home comes from the pin ${resolved.pinPath}.`);
  } else if (resolved.source === 'default') sentences.push('This is the default home.');
  sentences.push('If the server is managed from another Myco home, run the command with MYCO_HOME set to that home.');
  return sentences.join(' ');
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
