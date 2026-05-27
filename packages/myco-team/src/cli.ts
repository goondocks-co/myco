/**
 * CLI team commands — provision and manage Cloudflare team sync infrastructure.
 *
 * Exposed via the standalone `myco-team` binary (see `main.ts`):
 *   `myco-team install` — Provision D1 database, Vectorize index, deploy worker.
 *   `myco-team upgrade` — Redeploy worker with updated source.
 *
 * The daemon's `POST /api/team/upgrade-worker` handler also imports
 * `upgradeWorker` from this module at build time (via the tsconfig `@myco-team/*`
 * path alias) so the UI's "Update Worker" button works without requiring the
 * user to have `myco-team` on PATH.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WRANGLER_COMMAND_TIMEOUT_MS, TEAM_API_KEY_SECRET, TEAM_MCP_TOKEN_SECRET } from '@myco/constants.js';
import { SCHEMA_VERSION } from '@myco/db/schema.js';
import { loadProjectManifest } from '@myco/config/project-manifest.js';
import { resolveGroveDbPath, resolveProjectVaultDir } from '@myco/grove/paths.js';
import { findRegisteredProject, loadGroveRecord } from '@myco/grove/registry.js';
import { assertGroveProjectId, slugifyGroveName } from '@myco/grove/ids.js';
import {
  loadTeamConnectionConfig,
  readTeamConnectionSecrets,
  resolveTeamConnectionStore,
  updateTeamConnectionConfig,
  writeTeamConnectionSecret,
} from '@myco/grove/team-connection.js';
import type { MycoRequestContext } from '@myco/tools/request-context.js';
import {
  extractJsonArray,
  installDeploymentDeps,
  maskSecret,
  parseD1Id,
  parseKvNamespaceId,
  parseWorkerUrl,
  readJsonConfig,
  resolveHomeConfigPath,
  resolveVaultConfigPath,
  runWrangler,
  stageDeploymentDir,
  writeJsonConfig,
} from '@myco-deploy/index.js';

declare const __MYCO_TEAM_VERSION__: string;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of random bytes for Team key generation. */
const API_KEY_BYTES = 32;

/** Vectorize index dimensions (must match the embedding model). */
const VECTORIZE_DIMENSIONS = '1024';

/** Vectorize distance metric. */
const VECTORIZE_METRIC = 'cosine';

/** Prefix for team resource names. */
const TEAM_RESOURCE_PREFIX = 'myco-team';

/** Length of the project hash suffix for unique resource naming. */
const PROJECT_HASH_LENGTH = 8;

/** Max base length leaves room for suffixes like "-sync-dlq" within 63 chars. */
const RESOURCE_NAME_MAX_LENGTH = 54;


/** Source directory for worker files (relative to package root). */
const WORKER_SOURCE_DIR = 'worker';

/** Team sync state directory within the vault. */
const TEAM_STATE_DIR = 'team';
const TEAM_DEPLOY_DIR = 'worker';
const TEAM_CONFIG_FILE = 'config.json';
const LEGACY_TEAM_CONFIG_DIR = '.myco-team';
const LEGACY_TEAM_DEPLOY_DIR = '.team-worker';
const TEAM_CONFIG_VERSION = 1;
const TEAM_MCP_ROTATION_RETRY_ATTEMPTS = 10;
const TEAM_MCP_ROTATION_RETRY_DELAY_MS = 1500;
const TEAM_VECTOR_REINDEX_RETRY_ATTEMPTS = 10;
const TEAM_VECTOR_REINDEX_RETRY_DELAY_MS = 1500;
// Reindex now returns immediately after enqueueing, but the producer
// still scans every embeddable table in D1. Keep a generous timeout
// for the listing phase on large datasets.
const TEAM_VECTOR_REINDEX_REQUEST_TIMEOUT_MS = WRANGLER_COMMAND_TIMEOUT_MS * 6;
const REQUEST_CONTEXT_ENV = {
  projectRoot: 'MYCO_PROJECT_ROOT',
  projectId: 'MYCO_PROJECT_ID',
  groveId: 'MYCO_GROVE_ID',
  machineId: 'MYCO_MACHINE_ID',
  sessionId: 'MYCO_SESSION_ID',
} as const;

/** Regex to match wrangler.toml name field. */
const TOML_NAME_REGEX = /^name\s*=\s*"[^"]*"/m;

/** Regex to match wrangler.toml D1 placeholder. */
const TOML_D1_PLACEHOLDER_REGEX = /<YOUR_D1_DATABASE_ID>/g;

/** Regex to match wrangler.toml database_name field. */
const TOML_DB_NAME_REGEX = /database_name\s*=\s*"[^"]*"/g;

/** Regex to match wrangler.toml index_name field. */
const TOML_INDEX_NAME_REGEX = /index_name\s*=\s*"[^"]*"/g;

/** Regex to match wrangler.toml team package version placeholder. */
const TOML_TEAM_PACKAGE_VERSION_REGEX = /MYCO_TEAM_PACKAGE_VERSION\s*=\s*"[^"]*"/g;

/** Regex to match wrangler.toml Myco schema version placeholder. */
const TOML_MYCO_SCHEMA_VERSION_REGEX = /MYCO_SCHEMA_VERSION\s*=\s*"[^"]*"/g;

/** Regex to match database_id in existing wrangler.toml. */
const TOML_DB_ID_REGEX = /database_id\s*=\s*"([^"]+)"/;

/** Regex to match wrangler.toml KV namespace placeholder. */
const TOML_KV_PLACEHOLDER_REGEX = /<YOUR_KV_NAMESPACE_ID>/g;

/** Regex to extract the KV namespace ID from an existing wrangler.toml. */
const TOML_KV_ID_REGEX = /\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*"([0-9a-f]+)"/;

/** Regex to match wrangler.toml sync queue placeholder. */
const TOML_SYNC_QUEUE_PLACEHOLDER_REGEX = /<YOUR_SYNC_QUEUE_NAME>/g;

/** Regex to match wrangler.toml sync DLQ placeholder. */
const TOML_SYNC_DLQ_PLACEHOLDER_REGEX = /<YOUR_SYNC_DLQ_NAME>/g;

/** Regex matching the observability placeholder line in the template. */
const TOML_OBSERVABILITY_PLACEHOLDER_REGEX = /^# <MYCO_OBSERVABILITY_BLOCK>$/m;

/** Regex matching a previously-rendered observability block (for re-runs). */
const TOML_OBSERVABILITY_BLOCK_REGEX = /\n?\[observability\][\s\S]*?(?=\n\[|\n*$)/g;

const OBSERVABILITY_TOML_BLOCK = `[observability]
[observability.logs]
enabled = true
invocation_logs = true
`;

/**
 * Render the wrangler.toml observability section. Defaults to a
 * commented placeholder so deploys don't quietly enable Cloudflare's
 * persistent log stream (it costs extra). Pass `enabled: true` from
 * `--observability` on `upgrade` to opt in for a single deploy.
 */
function renderObservabilitySection(enabled: boolean): string {
  return enabled
    ? OBSERVABILITY_TOML_BLOCK
    : '# Observability disabled. Pass `--observability` to `myco-team-dev upgrade` to enable.';
}

/**
 * Reset the toml's observability block — strips any existing
 * `[observability]` block (from a prior `--observability` deploy) and
 * restores the placeholder line. Lets the patch transform run idempotently
 * regardless of which state the previous deploy left behind.
 */
function resetObservabilityBlock(toml: string): string {
  if (TOML_OBSERVABILITY_PLACEHOLDER_REGEX.test(toml)) return toml;
  const stripped = toml.replace(TOML_OBSERVABILITY_BLOCK_REGEX, '');
  return `${stripped.trimEnd()}\n# <MYCO_OBSERVABILITY_BLOCK>\n`;
}

/** Regex to extract the bound sync queue name from an existing wrangler.toml producer block. */
const TOML_SYNC_QUEUE_NAME_REGEX = /\[\[queues\.producers\]\][\s\S]*?queue\s*=\s*"([^"]+)"/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a stable hash for unique resource naming. */
function resourceHash(scope: TeamCliScope): string {
  const hash = crypto.createHash('sha256').update(scope.resourceSeed).digest('hex');
  return hash.slice(0, PROJECT_HASH_LENGTH);
}

/** Build the unique resource name for this Grove. */
function resourceName(scope: GroveTeamCliScope): string {
  const hash = resourceHash(scope);
  const maxSlugLength =
    RESOURCE_NAME_MAX_LENGTH
    - TEAM_RESOURCE_PREFIX.length
    - hash.length
    - 2;
  const slug = scope.resourceSlug
    .slice(0, Math.max(1, maxSlugLength))
    .replace(/-+$/g, '')
    || 'grove';
  return `${TEAM_RESOURCE_PREFIX}-${slug}-${hash}`;
}

function resolvePackageRoot(): string {
  const override = process.env.MYCO_TEAM_PACKAGE_ROOT?.trim();
  if (override) return override;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function getTeamPackageVersion(): string {
  if (typeof __MYCO_TEAM_VERSION__ !== 'undefined') {
    return __MYCO_TEAM_VERSION__;
  }

  const packageRoot = resolvePackageRoot();
  const candidatePaths = [
    path.join(packageRoot, 'package.json'),
    path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'package.json'),
  ];

  for (const candidatePath of candidatePaths) {
    if (!fs.existsSync(candidatePath)) continue;
    const packageJson = JSON.parse(fs.readFileSync(candidatePath, 'utf-8')) as { version?: string };
    if (packageJson.version) return packageJson.version;
  }

  return '0.1.0';
}

function getMycoSchemaVersion(): string {
  return String(SCHEMA_VERSION);
}

export interface TeamLocalConfig {
  worker_name: string;
  worker_url: string;
  package_version: string;
  created_at: string;
  last_upgraded: string;
  config_version: number;
}

interface LegacyTeamLocalConfig extends TeamLocalConfig {
  api_key?: string;
  mcp_token?: string | null;
  vault_dir?: string;
}

interface TeamCliScope {
  vaultDir: string;
  requestContext: MycoRequestContext;
  stateDir: string;
  resourceSeed: string;
  resourceSlug: string | null;
  label: string;
}

type GroveTeamCliScope = TeamCliScope & {
  requestContext: MycoRequestContext & { groveId: string };
  resourceSlug: string;
};

function hasGroveTeamScope(scope: TeamCliScope): scope is GroveTeamCliScope {
  return Boolean(scope.requestContext.groveId && scope.resourceSlug);
}

/**
 * Gate that asserts the resolved CLI scope is bound to a Grove. Pre-Grove
 * vaults (no project.toml, no Grove binding) hit the friendly migration
 * prompt below. Operators can override with `--legacy` when they're
 * intentionally provisioning sync against a legacy vault — that flag is
 * read from `process.argv` here because the CLI parser hasn't yet split
 * arguments at this point in `teamInit`. Exits with code 2
 * (configuration error) rather than the historical generic 1, so caller
 * scripts can branch on the migration prompt vs. an unrelated failure.
 */
function requireGroveInstallScope(scope: TeamCliScope): asserts scope is GroveTeamCliScope {
  if (hasGroveTeamScope(scope)) return;

  if (process.argv.includes('--legacy')) {
    // Operator-acknowledged legacy install path — preserved for
    // intentional re-provisioning of pre-Grove vaults. The cast is
    // safe at runtime because resolveTeamCliScope already filled in
    // the resourceSlug fallback from the vault dir; `groveId` is the
    // only field still null, and the historical legacy code path
    // never read it.
    return;
  }

  console.error('');
  console.error('myco-team install requires a Grove-bound project.');
  console.error('');
  console.error('To activate Grove for this project:');
  console.error('  1. Open this project in any supported agent so Myco auto-registers it.');
  console.error('  2. Re-run `myco-team install` to provision team sync.');
  console.error('');
  console.error('If you are intentionally provisioning team sync against a legacy');
  console.error('project-local vault, re-run with `--legacy` to bypass this gate.');
  console.error('');
  process.exit(2);
}

function resolveTeamCliScope(vaultDir: string): TeamCliScope {
  const requestContext = resolveTeamRequestContext(vaultDir);
  const store = resolveTeamConnectionStore(vaultDir, requestContext);
  const grove = store.groveId ? loadGroveRecord(store.groveId) : null;
  return {
    vaultDir,
    requestContext,
    stateDir: store.configDir,
    resourceSeed: store.groveId ?? vaultDir,
    resourceSlug: grove ? slugifyGroveName(grove.name) : null,
    label: store.groveId
      ? `Grove ${grove?.name ?? requestContext.groveId}`
      : `project vault ${vaultDir}`,
  };
}

function resolveTeamRequestContext(vaultDir: string): MycoRequestContext {
  const machineId = readEnv(REQUEST_CONTEXT_ENV.machineId) ?? 'team-cli';
  const sessionId = readEnv(REQUEST_CONTEXT_ENV.sessionId) ?? null;
  const fallbackProjectRoot = path.dirname(vaultDir);
  const envProjectRoot = readEnv(REQUEST_CONTEXT_ENV.projectRoot);
  const envProjectId = readEnv(REQUEST_CONTEXT_ENV.projectId);
  const envGroveId = readEnv(REQUEST_CONTEXT_ENV.groveId);

  if (envGroveId) {
    const projectRoot = path.resolve(envProjectRoot ?? fallbackProjectRoot);
    const manifest = loadProjectManifest(resolveProjectVaultDir(projectRoot)) ?? loadProjectManifest(vaultDir);
    const projectId = envProjectId ?? manifest?.project.id;
    if (!projectId) throw new Error('Incomplete Myco request context: missing project id');
    const registered = findRegisteredProject({
      projectId,
      groveId: envGroveId,
      bindingId: manifest?.grove?.binding_id ?? null,
      projectRoot,
    });
    if (!registered) throw new Error(`Project ${projectId} is not registered in Grove ${envGroveId}`);
    const registeredRoot = path.resolve(registered.project.root);
    return {
      projectRoot: registeredRoot,
      projectId: assertGroveProjectId(projectId),
      callerRoot: null,
      groveId: registered.grove.id,
      machineId,
      sessionId,
      projectVaultDir: resolveProjectVaultDir(registeredRoot),
      databasePath: resolveGroveDbPath(registered.grove.id),
      source: 'explicit',
    };
  }

  const manifest = loadProjectManifest(vaultDir);
  if (manifest?.grove?.binding_id) {
    const registered = findRegisteredProject({
      projectId: manifest.project.id,
      bindingId: manifest.grove.binding_id,
      projectRoot: fallbackProjectRoot,
    });
    if (registered) {
      const registeredRoot = path.resolve(registered.project.root);
      return {
        projectRoot: registeredRoot,
        callerRoot: null,
        projectId: assertGroveProjectId(registered.project.project_id),
        groveId: registered.grove.id,
        machineId,
        sessionId,
        projectVaultDir: resolveProjectVaultDir(registeredRoot),
        databasePath: resolveGroveDbPath(registered.grove.id),
        source: 'explicit',
      };
    }
  }

  // Fall back to a non-Grove context with a branded project id from
  // env or manifest. `requireGroveInstallScope` (called downstream)
  // rejects this for ops that need an actual Grove binding; ops that
  // only need a local project id (e.g. token rotation against a local
  // worker config) can still proceed.
  const fallbackProjectId = envProjectId ?? manifest?.project.id;
  if (!fallbackProjectId) {
    throw new Error('No Grove project id available. Open this project in any supported agent so Myco auto-registers it, then retry.');
  }
  return {
    projectRoot: fallbackProjectRoot,
    callerRoot: null,
    projectId: assertGroveProjectId(fallbackProjectId),
    groveId: null,
    machineId,
    sessionId,
    projectVaultDir: vaultDir,
    databasePath: path.join(vaultDir, 'myco.db'),
    source: 'legacy-vault',
  };
}

function readEnv(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

function resolveLocalConfigPath(scope: TeamCliScope): string {
  return resolveVaultConfigPath(scope.stateDir, TEAM_STATE_DIR, TEAM_CONFIG_FILE);
}

function resolveLegacyLocalConfigPath(): string {
  return resolveHomeConfigPath(LEGACY_TEAM_CONFIG_DIR, TEAM_CONFIG_FILE);
}

function resolveDeployDir(scope: TeamCliScope): string {
  return path.join(scope.stateDir, TEAM_STATE_DIR, TEAM_DEPLOY_DIR);
}

function resolveLegacyDeployDir(vaultDir: string): string {
  return path.join(vaultDir, LEGACY_TEAM_DEPLOY_DIR);
}

function writeLocalConfig(scope: TeamCliScope, config: TeamLocalConfig): void {
  writeJsonConfig(resolveLocalConfigPath(scope), config);
}

function migrateLegacyDeployDir(scope: TeamCliScope): void {
  const legacyDeployDir = resolveLegacyDeployDir(scope.vaultDir);
  const nextDeployDir = resolveDeployDir(scope);
  if (!fs.existsSync(legacyDeployDir) || fs.existsSync(nextDeployDir)) return;

  fs.mkdirSync(path.dirname(nextDeployDir), { recursive: true });
  fs.renameSync(legacyDeployDir, nextDeployDir);
}

function readLocalConfig(scope: TeamCliScope): TeamLocalConfig | null {
  const config = readJsonConfig<TeamLocalConfig>(resolveLocalConfigPath(scope));
  if (config) {
    migrateLegacyDeployDir(scope);
    return config;
  }

  const legacyConfig = readJsonConfig<LegacyTeamLocalConfig>(resolveLegacyLocalConfigPath());
  if (!legacyConfig) return null;
  if (
    legacyConfig.vault_dir
    && legacyConfig.vault_dir !== scope.vaultDir
    && legacyConfig.vault_dir !== scope.stateDir
  ) return null;

  const migrated: TeamLocalConfig = {
    worker_name: legacyConfig.worker_name,
    worker_url: legacyConfig.worker_url,
    package_version: legacyConfig.package_version,
    created_at: legacyConfig.created_at,
    last_upgraded: legacyConfig.last_upgraded,
    config_version: legacyConfig.config_version ?? TEAM_CONFIG_VERSION,
  };
  writeLocalConfig(scope, migrated);
  if (legacyConfig.api_key) writeTeamConnectionSecret(scope.vaultDir, scope.requestContext, TEAM_API_KEY_SECRET, legacyConfig.api_key);
  if (legacyConfig.mcp_token) writeTeamConnectionSecret(scope.vaultDir, scope.requestContext, TEAM_MCP_TOKEN_SECRET, legacyConfig.mcp_token);
  migrateLegacyDeployDir(scope);
  return migrated;
}

function requireLocalConfig(scope: TeamCliScope): TeamLocalConfig {
  const config = readLocalConfig(scope);
  if (config) return config;

  console.error(`No local myco-team config found at ${resolveLocalConfigPath(scope)}`);
  process.exit(1);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function rotateMcpTokenWithRetry(workerUrl: string, apiKey: string): Promise<string> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= TEAM_MCP_ROTATION_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await rotateMcpTokenForWorker(workerUrl, apiKey);
    } catch (error) {
      lastError = error as Error;
      const isRetryable =
        lastError.message.includes('401') &&
        lastError.message.includes('Invalid Team key') &&
        attempt < TEAM_MCP_ROTATION_RETRY_ATTEMPTS;
      if (!isRetryable) {
        throw lastError;
      }
      await delay(TEAM_MCP_ROTATION_RETRY_DELAY_MS);
    }
  }

  throw lastError ?? new Error('MCP token rotation failed');
}

/**
 * Trigger a remote reindex by asking the worker to enqueue per-row
 * `embed` jobs onto its sync queue. Returns immediately with the
 * count — actual embedding happens asynchronously as the queue
 * consumer drains. Watch progress on the Sync page (vector_count
 * climbing) rather than blocking on this call.
 */
export async function reindexWorkerVectors(vaultDir: string, workerUrlOverride?: string): Promise<{ enqueued: number; by_table: Record<string, number> }> {
  const scope = resolveTeamCliScope(vaultDir);
  const config = workerUrlOverride ? null : requireLocalConfig(scope);
  const secrets = readTeamConnectionSecrets(vaultDir, scope.requestContext);
  const apiKey = secrets[TEAM_API_KEY_SECRET];
  if (!apiKey) {
    throw new Error(`Missing ${TEAM_API_KEY_SECRET} secret for ${scope.label}`);
  }
  const workerUrl = workerUrlOverride ?? config?.worker_url;
  if (!workerUrl) {
    throw new Error('No team worker URL configured');
  }

  let response: Response | null = null;
  let retryableError: Error | null = null;
  for (let attempt = 1; attempt <= TEAM_VECTOR_REINDEX_RETRY_ATTEMPTS; attempt += 1) {
    try {
      response = await fetch(`${workerUrl.replace(/\/+$/, '')}/vectors/reindex`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: '{}',
        signal: AbortSignal.timeout(TEAM_VECTOR_REINDEX_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isTimeout = message.includes('timeout');
      if (!isTimeout || attempt >= TEAM_VECTOR_REINDEX_RETRY_ATTEMPTS) throw error;
      retryableError = new Error(`Worker vector reindex timed out (attempt ${attempt}/${TEAM_VECTOR_REINDEX_RETRY_ATTEMPTS})`);
      await delay(TEAM_VECTOR_REINDEX_RETRY_DELAY_MS);
      continue;
    }

    if (response.ok) { retryableError = null; break; }
    const body = await response.text();
    const isRetryable = response.status === 404 && body.includes('Not found') && attempt < TEAM_VECTOR_REINDEX_RETRY_ATTEMPTS;
    if (!isRetryable) throw new Error(`Worker vector reindex failed: ${response.status} ${body}`);
    retryableError = new Error(`Worker vector reindex route not ready yet (attempt ${attempt}/${TEAM_VECTOR_REINDEX_RETRY_ATTEMPTS})`);
    await delay(TEAM_VECTOR_REINDEX_RETRY_DELAY_MS);
  }

  if (!response?.ok) {
    throw retryableError ?? new Error('Worker vector reindex failed');
  }

  return await response.json() as { enqueued: number; by_table: Record<string, number> };
}

/** Run a wrangler command and return stdout. Throws on failure, surfacing stderr. */
function wrangler(args: string[], options?: { cwd?: string }): string {
  return runWrangler(args, { cwd: options?.cwd, timeoutMs: WRANGLER_COMMAND_TIMEOUT_MS });
}

/** Find the worker source directory. Checks dist layout first (installed), then source layout (dev). */
function locateWorkerSource(): string {
  const root = resolvePackageRoot();
  const distPath = path.join(root, 'dist', WORKER_SOURCE_DIR);
  if (fs.existsSync(distPath)) return distPath;
  const srcPath = path.join(root, WORKER_SOURCE_DIR);
  if (fs.existsSync(srcPath)) return srcPath;
  throw new Error(`Cannot find ${WORKER_SOURCE_DIR} — are you running from the myco-team package?`);
}

/** Compute the sync queue name for this project. */
function syncQueueName(name: string): string {
  return `${name}-sync`;
}

/** Compute the sync dead-letter queue name for this project. */
function syncDlqName(name: string): string {
  return `${name}-sync-dlq`;
}

/**
 * Copy worker source to the vault deployment directory and patch wrangler.toml
 * with actual D1 database ID and resource names.
 */
function prepareDeployDir(scope: GroveTeamCliScope, d1Id: string, kvId: string): string {
  const srcDir = locateWorkerSource();
  const deployDir = resolveDeployDir(scope);
  const name = resourceName(scope);
  return stageDeploymentDir({
    sourceDir: srcDir,
    deployDir,
    reset: true,
    textPatches: [{
      filePath: 'wrangler.toml',
      transforms: [
        (toml) => toml.replace(TOML_NAME_REGEX, `name = "${name}"`),
        (toml) => toml.replace(TOML_D1_PLACEHOLDER_REGEX, d1Id),
        (toml) => toml.replace(TOML_DB_NAME_REGEX, `database_name = "${name}"`),
        (toml) => toml.replace(TOML_INDEX_NAME_REGEX, `index_name = "${name}-vectors"`),
        (toml) => toml.replace(TOML_KV_PLACEHOLDER_REGEX, kvId),
        (toml) => toml.replace(TOML_SYNC_QUEUE_PLACEHOLDER_REGEX, syncQueueName(name)),
        (toml) => toml.replace(TOML_SYNC_DLQ_PLACEHOLDER_REGEX, syncDlqName(name)),
        (toml) => toml.replace(TOML_TEAM_PACKAGE_VERSION_REGEX, `MYCO_TEAM_PACKAGE_VERSION = "${getTeamPackageVersion()}"`),
        (toml) => toml.replace(TOML_MYCO_SCHEMA_VERSION_REGEX, `MYCO_SCHEMA_VERSION = "${getMycoSchemaVersion()}"`),
      ],
    }],
    installDepsTimeoutMs: WRANGLER_COMMAND_TIMEOUT_MS * 3,
  });
}

/**
 * Ensure a Cloudflare Queue exists for this project. Idempotent — treats
 * "already exists" as success. Queues are bound by name in wrangler.toml,
 * so no ID lookup is needed.
 */
function ensureQueue(queueName: string): void {
  try {
    wrangler(['queues', 'create', queueName]);
  } catch (err) {
    const errMsg = (err as Error).message;
    // Wrangler reports collisions in several shapes depending on version
    // and the underlying CF API response. The current 4.x + Queues API
    // returns "is already taken" with code 11009; older variants used
    // "already exists" / "duplicate". Treat any of them as success so
    // re-running install/upgrade is idempotent.
    if (
      errMsg.includes('already exists')
      || errMsg.includes('is already taken')
      || errMsg.includes('duplicate')
      || errMsg.includes('11009')
    ) {
      return;
    }
    throw err;
  }
}

function isMissingQueueConsumerError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('not found')
    || normalized.includes('does not exist')
    || normalized.includes('no worker consumer')
    || normalized.includes('no consumer')
    || normalized.includes('not configured')
    || normalized.includes('10003')
  );
}

function isExistingQueueConsumerError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('already exists')
    || normalized.includes('already configured')
    || normalized.includes('already has a consumer')
    || normalized.includes('is already taken')
    || normalized.includes('duplicate')
  );
}

function ensureDlqPullConsumer(dlqName: string, workerName: string): void {
  try {
    wrangler(['queues', 'consumer', 'worker', 'remove', dlqName, workerName]);
  } catch (err) {
    const errMsg = (err as Error).message;
    if (!isMissingQueueConsumerError(errMsg)) throw err;
  }

  try {
    wrangler(['queues', 'consumer', 'http', 'add', dlqName]);
  } catch (err) {
    const errMsg = (err as Error).message;
    if (!isExistingQueueConsumerError(errMsg)) throw err;
  }
}

/** Ensure a KV namespace exists for this project. Returns the namespace ID. */
function ensureKvNamespace(name: string): string {
  const kvName = `${name}-secrets`;
  const lookupExisting = (): string => {
    const listOutput = wrangler(['kv', 'namespace', 'list']);
    const namespaces = extractJsonArray(listOutput) as Array<{ id: string; title: string }>;
    // Wrangler sometimes rewrites hyphens to underscores in titles
    const normalize = (s: string) => s.replace(/[-_]/g, '');
    const target = normalize(kvName);
    const existing = namespaces.find((ns) => normalize(ns.title) === target || normalize(ns.title).endsWith(target));
    if (!existing) throw new Error(`KV namespace "${kvName}" not found in list of ${namespaces.length} namespaces`);
    return existing.id;
  };

  try {
    const output = wrangler(['kv', 'namespace', 'create', kvName]);
    return parseKvNamespaceId(output);
    // Created successfully but we couldn't parse — fall back to list lookup
  } catch (err) {
    const errMsg = (err as Error).message;
    if (errMsg.includes('already exists') || errMsg.includes('duplicate') || errMsg.includes('same title')) {
      return lookupExisting();
    }
    throw err;
  }
}

async function rotateMcpTokenForWorker(workerUrl: string, apiKey: string): Promise<string> {
  const response = await fetch(`${workerUrl}/mcp/rotate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`MCP token rotation failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json() as { token?: string };
  if (!body.token) {
    throw new Error('MCP token rotation response did not include a token');
  }
  return body.token;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function teamInit(vaultDir: string): Promise<void> {
  const scope = resolveTeamCliScope(vaultDir);
  requireGroveInstallScope(scope);

  console.log('Provisioning team sync infrastructure...\n');
  console.log(`Scope: ${scope.label}\n`);

  // 1. Check for wrangler
  try {
    const version = wrangler(['--version']).trim();
    console.log(`wrangler: ${version}`);
  } catch {
    console.error('Error: wrangler CLI not found. Install it with: npm install -g wrangler');
    process.exit(1);
  }

  // 2. Check auth
  try {
    wrangler(['whoami']);
    console.log('Cloudflare auth: OK\n');
  } catch {
    console.error('Error: Not authenticated with Cloudflare. Run: wrangler login');
    process.exit(1);
  }

  const name = resourceName(scope);
  console.log(`Resource name: ${name}\n`);

  // 3. Create D1 database (or reuse existing)
  console.log('Creating D1 database...');
  let d1Id: string;
  try {
    const d1Output = wrangler(['d1', 'create', name]);
    d1Id = parseD1Id(d1Output);
    console.log(`D1 database created: ${d1Id}\n`);
  } catch (err) {
    const errMsg = (err as Error).message;
    if (errMsg.includes('already exists')) {
      console.log('D1 database already exists, looking up ID...');
      const listOutput = wrangler(['d1', 'list', '--json']);
      const databases = JSON.parse(listOutput) as Array<{ name: string; uuid: string }>;
      const existing = databases.find((db) => db.name === name);
      if (!existing) {
        console.error(`D1 database "${name}" reported as existing but not found in list`);
        process.exit(1);
      }
      d1Id = existing.uuid;
      console.log(`Reusing D1 database: ${d1Id}\n`);
    } else {
      console.error(`Failed to create D1 database: ${errMsg}`);
      process.exit(1);
    }
  }

  // 4. Create Vectorize index (or reuse existing)
  console.log('Creating Vectorize index...');
  try {
    wrangler(['vectorize', 'create', `${name}-vectors`, '--dimensions', VECTORIZE_DIMENSIONS, '--metric', VECTORIZE_METRIC]);
    console.log('Vectorize index created\n');
  } catch (err) {
    const errMsg = (err as Error).message;
    if (errMsg.includes('already exists') || errMsg.includes('duplicate_name')) {
      console.log('Vectorize index already exists, reusing\n');
    } else {
      console.error(`Failed to create Vectorize index: ${errMsg}`);
      process.exit(1);
    }
  }

  // 5. Create KV namespace for runtime secrets (MCP tokens)
  console.log('Creating KV namespace for secrets...');
  let kvId: string;
  try {
    kvId = ensureKvNamespace(name);
    console.log(`KV namespace ready: ${kvId}\n`);
  } catch (err) {
    console.error(`Failed to create KV namespace: ${(err as Error).message}`);
    process.exit(1);
  }

  // 6. Create Cloudflare Queues for sync + dead-letter (idempotent)
  console.log('Creating sync queues...');
  try {
    ensureQueue(syncQueueName(name));
    ensureQueue(syncDlqName(name));
    console.log(`Sync queues ready: ${syncQueueName(name)}, ${syncDlqName(name)}\n`);
  } catch (err) {
    console.error(`Failed to create sync queues: ${(err as Error).message}`);
    process.exit(1);
  }

  // 7. Generate team key
  const apiKey = crypto.randomBytes(API_KEY_BYTES).toString('hex');

  // 8. Prepare deployment directory
  console.log('Preparing worker deployment...');
  const deployDir = prepareDeployDir(scope, d1Id, kvId);

  // 7. Set team key secret via wrangler
  console.log('Setting Team key secret...');
  try {
    runWrangler(['secret', 'put', TEAM_API_KEY_SECRET, '--name', name], {
      cwd: deployDir,
      input: apiKey,
      timeoutMs: WRANGLER_COMMAND_TIMEOUT_MS,
    });
    console.log('Secret set\n');
  } catch (err) {
    console.error(`Failed to set Team key secret: ${(err as Error).message}`);
    process.exit(1);
  }

  // 8. Deploy worker
  console.log('Deploying worker...');
  let workerUrl: string;
  try {
    const deployOutput = wrangler(['deploy'], { cwd: deployDir });
    workerUrl = parseWorkerUrl(deployOutput);
    console.log(`Worker deployed: ${workerUrl}\n`);
  } catch (err) {
    console.error(`Failed to deploy worker: ${(err as Error).message}`);
    process.exit(1);
  }

  // 9. Configure the DLQ for HTTP pull so the daemon UI can inspect,
  // retry, or discard failed deliveries without a separate Worker consumer
  // draining those messages.
  try {
    ensureDlqPullConsumer(syncDlqName(name), name);
  } catch (err) {
    console.error(`Failed to configure failed-sync queue: ${(err as Error).message}`);
    process.exit(1);
  }

  // 10. Seed team config in the Worker
  console.log('Setting team configuration...');
  try {
    const { getMachineId } = await import('@myco/daemon/machine-id.js');
    const creatorMachineId = getMachineId();
    await fetch(`${workerUrl}/config`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_name: name,
        embedding_model: '@cf/baai/bge-m3',
        embedding_dimensions: '1024',
        created_at: String(Math.floor(Date.now() / 1000)),
        created_by: creatorMachineId,
      }),
    });
    console.log('Team config saved\n');
  } catch {
    console.log('Warning: could not seed team config (non-fatal)\n');
  }

  let mcpToken: string | null = null;
  try {
    mcpToken = await rotateMcpTokenForWorker(workerUrl, apiKey);
  } catch {
    // Non-fatal. The daemon can also fetch the token later through /connect.
  }

  // 11. Save config and team key locally
  updateTeamConnectionConfig(vaultDir, scope.requestContext, {
    enabled: true,
    worker_url: workerUrl,
  });
  writeTeamConnectionSecret(vaultDir, scope.requestContext, TEAM_API_KEY_SECRET, apiKey);
  if (mcpToken) writeTeamConnectionSecret(vaultDir, scope.requestContext, TEAM_MCP_TOKEN_SECRET, mcpToken);
  writeLocalConfig(scope, {
    worker_name: name,
    worker_url: workerUrl,
    package_version: getTeamPackageVersion(),
    created_at: new Date().toISOString(),
    last_upgraded: new Date().toISOString(),
    config_version: TEAM_CONFIG_VERSION,
  });

  console.log('Team sync configured!\n');
  console.log(`  URL:     ${workerUrl}`);
  console.log(`  Team key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);
  if (mcpToken) {
    console.log(`  MCP:     ${mcpToken.slice(0, 8)}...${mcpToken.slice(-4)}`);
  }
  console.log('\nShare the URL and Team key with teammates so they can connect.');
}

// ---------------------------------------------------------------------------
// Shared upgrade logic (used by CLI and daemon API)
// ---------------------------------------------------------------------------

export interface UpgradeResult {
  success: boolean;
  worker_url?: string;
  version?: string;
  error?: string;
}

/**
 * Upgrade the team sync worker: re-copy source, patch config, redeploy.
 * Returns a result instead of calling process.exit — safe for both CLI and daemon.
 */
export function upgradeWorker(vaultDir: string, options: { observability?: boolean } = {}): UpgradeResult {
  const scope = resolveTeamCliScope(vaultDir);
  const config = loadTeamConnectionConfig(vaultDir, scope.requestContext);
  if (!config.worker_url) {
    return { success: false, error: 'No team sync configured. Run: myco-team install' };
  }

  migrateLegacyDeployDir(scope);
  const deployDir = resolveDeployDir(scope);
  const tomlPath = path.join(deployDir, 'wrangler.toml');

  if (!fs.existsSync(tomlPath)) {
    return { success: false, error: 'No deployment directory found. Run: myco-team install' };
  }

  // Read ALL existing resource identifiers from current wrangler.toml.
  const existingToml = fs.readFileSync(tomlPath, 'utf-8');
  const d1Match = existingToml.match(TOML_DB_ID_REGEX);
  if (!d1Match || d1Match[1] === '<YOUR_D1_DATABASE_ID>') {
    return { success: false, error: 'Cannot determine D1 database ID from existing deployment. Run: myco-team install' };
  }
  const d1Id = d1Match[1];

  const nameMatch = existingToml.match(/^name\s*=\s*"([^"]*)"/m);
  const dbNameMatch = existingToml.match(/database_name\s*=\s*"([^"]*)"/);
  const indexNameMatch = existingToml.match(/index_name\s*=\s*"([^"]*)"/);
  let workerName: string;
  if (nameMatch) {
    workerName = nameMatch[1];
  } else {
    if (!hasGroveTeamScope(scope)) {
      return { success: false, error: 'Cannot determine worker name from existing deployment. Run: myco-team install from a Grove-bound project' };
    }
    workerName = resourceName(scope);
  }

  // KV namespace may not exist on older deployments — create or reuse.
  const kvMatch = existingToml.match(TOML_KV_ID_REGEX);
  let kvId: string;
  if (kvMatch) {
    kvId = kvMatch[1];
  } else {
    try {
      kvId = ensureKvNamespace(workerName);
    } catch (err) {
      return { success: false, error: `Failed to provision KV namespace: ${(err as Error).message}` };
    }
  }

  // Sync queues may not exist on pre-queues deployments — create idempotently.
  // ensureQueue is a no-op when the queue is already provisioned.
  try {
    ensureQueue(syncQueueName(workerName));
    ensureQueue(syncDlqName(workerName));
  } catch (err) {
    return { success: false, error: `Failed to provision sync queues: ${(err as Error).message}` };
  }

  try {
    stageDeploymentDir({
      sourceDir: locateWorkerSource(),
      deployDir,
      textPatches: [{
        filePath: 'wrangler.toml',
        transforms: [
          (toml) => toml.replace(TOML_NAME_REGEX, `name = "${workerName}"`),
          (toml) => toml.replace(TOML_D1_PLACEHOLDER_REGEX, d1Id),
          (toml) => toml.replace(TOML_DB_NAME_REGEX, `database_name = "${dbNameMatch?.[1] ?? workerName}"`),
          (toml) => toml.replace(TOML_INDEX_NAME_REGEX, `index_name = "${indexNameMatch?.[1] ?? `${workerName}-vectors`}"`),
          (toml) => toml.replace(TOML_KV_PLACEHOLDER_REGEX, kvId),
          (toml) => toml.replace(TOML_SYNC_QUEUE_PLACEHOLDER_REGEX, syncQueueName(workerName)),
          (toml) => toml.replace(TOML_SYNC_DLQ_PLACEHOLDER_REGEX, syncDlqName(workerName)),
          (toml) => toml.replace(TOML_TEAM_PACKAGE_VERSION_REGEX, `MYCO_TEAM_PACKAGE_VERSION = "${getTeamPackageVersion()}"`),
          (toml) => toml.replace(TOML_MYCO_SCHEMA_VERSION_REGEX, `MYCO_SCHEMA_VERSION = "${getMycoSchemaVersion()}"`),
          (toml) => resetObservabilityBlock(toml).replace(
            TOML_OBSERVABILITY_PLACEHOLDER_REGEX,
            renderObservabilitySection(options.observability ?? false),
          ),
        ],
      }],
      installDepsTimeoutMs: WRANGLER_COMMAND_TIMEOUT_MS * 3,
    });
  } catch (err) {
    return { success: false, error: `Failed to install worker dependencies: ${(err as Error).message}` };
  }

  // Re-set Team key secret before deploy (deploy can wipe secrets)
  const secrets = readTeamConnectionSecrets(vaultDir, scope.requestContext);
  const apiKey = secrets[TEAM_API_KEY_SECRET];
  if (apiKey) {
    try {
      runWrangler(['secret', 'put', TEAM_API_KEY_SECRET, '--name', workerName], {
        cwd: deployDir,
        input: apiKey,
        timeoutMs: WRANGLER_COMMAND_TIMEOUT_MS,
      });
    } catch {
      // Non-fatal — secret may already be set
    }
  }

  // Redeploy
  try {
    const deployOutput = wrangler(['deploy'], { cwd: deployDir });
    const workerUrl = parseWorkerUrl(deployOutput);
    const version = getTeamPackageVersion();

    try {
      ensureDlqPullConsumer(syncDlqName(workerName), workerName);
    } catch (err) {
      return { success: false, error: `Failed to configure failed-sync queue: ${(err as Error).message}` };
    }

    updateTeamConnectionConfig(vaultDir, scope.requestContext, {
      worker_url: workerUrl,
    });
    const localConfig = readLocalConfig(scope);
    if (localConfig) {
      writeLocalConfig(scope, {
        ...localConfig,
        worker_name: workerName,
        worker_url: workerUrl,
        package_version: version,
        last_upgraded: new Date().toISOString(),
      });
    }

    return { success: true, worker_url: workerUrl, version };
  } catch (err) {
    return { success: false, error: `Failed to deploy worker: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function teamUpgrade(vaultDir: string, options: { reindexVectors?: boolean; observability?: boolean } = {}): Promise<void> {
  console.log('Upgrading team sync worker...\n');
  if (options.observability) {
    console.log('Observability: enabled (Cloudflare logs persist for this deploy)');
  }
  const result = upgradeWorker(vaultDir, { observability: options.observability });
  if (!result.success) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(`Worker deployed: ${result.worker_url}`);
  console.log(`Version: ${result.version}`);
  if (options.reindexVectors) {
    console.log('Enqueueing remote vector reindex...');
    const { enqueued, by_table } = await reindexWorkerVectors(vaultDir, result.worker_url);
    console.log(`  Queued ${enqueued} vectors (${formatTableCounts(by_table)})`);
    console.log('  Watch progress on the Sync page; the queue consumer drains in the background.');
  }
  console.log('\nUpgrade complete.');
}

export async function teamReindexVectors(vaultDir: string): Promise<void> {
  const { enqueued, by_table } = await reindexWorkerVectors(vaultDir);
  console.log(`Queued ${enqueued} vectors for reindex (${formatTableCounts(by_table)}).`);
  console.log('Watch progress on the Sync page; the queue consumer drains in the background.');
}

function formatTableCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts).map(([table, count]) => `${table}: ${count}`);
  return parts.length > 0 ? parts.join(', ') : 'no rows';
}

export async function teamStatus(vaultDir: string): Promise<void> {
  const scope = resolveTeamCliScope(vaultDir);
  const config = requireLocalConfig(scope);
  const secrets = readTeamConnectionSecrets(vaultDir, scope.requestContext);

  console.log(`Scope:       ${scope.label}`);
  console.log(`Worker:      ${config.worker_name}`);
  console.log(`URL:         ${config.worker_url}`);
  console.log(`Team key:    ${maskSecret(secrets[TEAM_API_KEY_SECRET] ?? null)}`);
  console.log(`MCP Token:   ${maskSecret(secrets[TEAM_MCP_TOKEN_SECRET] ?? null)}`);
  console.log(`Package v:   ${config.package_version}`);
  console.log(`Created:     ${config.created_at}`);
  console.log(`Upgraded:    ${config.last_upgraded}`);
  console.log(`Config v:    ${config.config_version}`);
}

export async function teamRotateTokens(vaultDir: string, which: 'api' | 'mcp' | 'all' = 'all'): Promise<void> {
  const scope = resolveTeamCliScope(vaultDir);
  const config = requireLocalConfig(scope);
  const secrets = readTeamConnectionSecrets(vaultDir, scope.requestContext);
  let currentApiKey = secrets[TEAM_API_KEY_SECRET] ?? '';
  let currentMcpToken = secrets[TEAM_MCP_TOKEN_SECRET] ?? null;

  let nextConfig = { ...config };

  if (which === 'api' || which === 'all') {
    const apiKey = crypto.randomBytes(API_KEY_BYTES).toString('hex');
    runWrangler(['secret', 'put', TEAM_API_KEY_SECRET, '--name', config.worker_name], {
      cwd: resolveDeployDir(scope),
      input: apiKey,
      timeoutMs: WRANGLER_COMMAND_TIMEOUT_MS,
    });
    writeTeamConnectionSecret(vaultDir, scope.requestContext, TEAM_API_KEY_SECRET, apiKey);
    currentApiKey = apiKey;
    nextConfig = {
      ...nextConfig,
      package_version: getTeamPackageVersion(),
      last_upgraded: new Date().toISOString(),
    };
    writeLocalConfig(scope, nextConfig);
  }

  if (which === 'mcp' || which === 'all') {
    try {
      currentMcpToken = await rotateMcpTokenWithRetry(config.worker_url, currentApiKey);
      if (currentMcpToken) writeTeamConnectionSecret(vaultDir, scope.requestContext, TEAM_MCP_TOKEN_SECRET, currentMcpToken);
    } catch (error) {
      writeLocalConfig(scope, {
        ...nextConfig,
        last_upgraded: new Date().toISOString(),
      });
      throw new Error(
        `Team key rotation completed, but MCP token rotation failed. Local config was updated to the new Team key.\n${(error as Error).message}`,
      );
    }
  }

  nextConfig.last_upgraded = new Date().toISOString();
  writeLocalConfig(scope, nextConfig);

  console.log(`Team key:  ${maskSecret(currentApiKey)}`);
  console.log(`MCP Token: ${maskSecret(currentMcpToken)}`);
}

export async function teamDestroy(vaultDir: string): Promise<void> {
  const scope = resolveTeamCliScope(vaultDir);
  const config = requireLocalConfig(scope);
  const errors: string[] = [];
  const deployDir = resolveDeployDir(scope);

  try {
    wrangler(['delete', config.worker_name], { cwd: deployDir });
  } catch (error) {
    errors.push(`worker delete failed: ${(error as Error).message}`);
  }

  try {
    wrangler(['vectorize', 'delete', `${config.worker_name}-vectors`]);
  } catch (error) {
    errors.push(`vectorize delete failed: ${(error as Error).message}`);
  }

  try {
    const databases = JSON.parse(wrangler(['d1', 'list', '--json'])) as Array<{ name: string; uuid: string }>;
    const database = databases.find((entry) => entry.name === config.worker_name);
    if (database) {
      wrangler(['d1', 'delete', database.name, '--skip-confirmation']);
    }
  } catch (error) {
    errors.push(`d1 delete failed: ${(error as Error).message}`);
  }

  try {
    const namespaces = extractJsonArray(wrangler(['kv', 'namespace', 'list'])) as Array<{ id: string; title: string }>;
    const namespace = namespaces.find((entry) => entry.title === `${config.worker_name}-secrets`);
    if (namespace) {
      wrangler(['kv', 'namespace', 'delete', '--namespace-id', namespace.id, '--skip-confirmation']);
    }
  } catch (error) {
    errors.push(`kv delete failed: ${(error as Error).message}`);
  }

  // Delete sync queues. Missing queues (older deployments) yield a not-found
  // error from wrangler, which we swallow.
  for (const queueName of [syncQueueName(config.worker_name), syncDlqName(config.worker_name)]) {
    try {
      wrangler(['queues', 'delete', queueName]);
    } catch (error) {
      const errMsg = (error as Error).message;
      if (errMsg.includes('not found') || errMsg.includes('does not exist') || errMsg.includes('no queue')) continue;
      errors.push(`queue ${queueName} delete failed: ${errMsg}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Team destroy incomplete. Local state preserved for retry.\n${errors.join('\n')}`);
  }

  fs.rmSync(path.join(scope.stateDir, TEAM_STATE_DIR), { recursive: true, force: true });
  console.log(`Destroyed local myco-team state for ${config.worker_name}.`);
}
