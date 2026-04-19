/**
 * CLI team commands — provision and manage Cloudflare team sync infrastructure.
 *
 * `myco team init`    — Provision D1 database, Vectorize index, deploy worker.
 * `myco team upgrade` — Redeploy worker with updated source.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILENAME, loadConfig, updateTeamConfig } from '@myco/config/loader.js';
import { writeSecret, readSecrets } from '@myco/config/secrets.js';
import { WRANGLER_COMMAND_TIMEOUT_MS, TEAM_API_KEY_SECRET, TEAM_MCP_TOKEN_SECRET } from '@myco/constants.js';
import { SCHEMA_VERSION } from '@myco/db/schema.js';
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

/** Number of random bytes for API key generation. */
const API_KEY_BYTES = 32;

/** Vectorize index dimensions (must match the embedding model). */
const VECTORIZE_DIMENSIONS = '1024';

/** Vectorize distance metric. */
const VECTORIZE_METRIC = 'cosine';

/** Prefix for team resource names. */
const TEAM_RESOURCE_PREFIX = 'myco-team';

/** Length of the project hash suffix for unique resource naming. */
const PROJECT_HASH_LENGTH = 8;


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
const TEAM_VECTOR_REINDEX_BATCH_SIZE = 20;
const TEAM_VECTOR_REINDEX_REQUEST_TIMEOUT_MS = WRANGLER_COMMAND_TIMEOUT_MS * 6;
const TEAM_VECTOR_REINDEX_TABLES = ['spores', 'sessions', 'plans', 'artifacts', 'skill_records'] as const;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a project hash from vault dir for unique resource naming. */
function projectHash(vaultDir: string): string {
  const hash = crypto.createHash('sha256').update(vaultDir).digest('hex');
  return hash.slice(0, PROJECT_HASH_LENGTH);
}

/** Build the unique resource name for this project's team infrastructure. */
function resourceName(vaultDir: string): string {
  return `${TEAM_RESOURCE_PREFIX}-${projectHash(vaultDir)}`;
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

function resolveLocalConfigPath(vaultDir: string): string {
  return resolveVaultConfigPath(vaultDir, TEAM_STATE_DIR, TEAM_CONFIG_FILE);
}

function resolveLegacyLocalConfigPath(): string {
  return resolveHomeConfigPath(LEGACY_TEAM_CONFIG_DIR, TEAM_CONFIG_FILE);
}

function resolveDeployDir(vaultDir: string): string {
  return path.join(vaultDir, TEAM_STATE_DIR, TEAM_DEPLOY_DIR);
}

function resolveLegacyDeployDir(vaultDir: string): string {
  return path.join(vaultDir, LEGACY_TEAM_DEPLOY_DIR);
}

function writeLocalConfig(vaultDir: string, config: TeamLocalConfig): void {
  writeJsonConfig(resolveLocalConfigPath(vaultDir), config);
}

function migrateLegacyDeployDir(vaultDir: string): void {
  const legacyDeployDir = resolveLegacyDeployDir(vaultDir);
  const nextDeployDir = resolveDeployDir(vaultDir);
  if (!fs.existsSync(legacyDeployDir) || fs.existsSync(nextDeployDir)) return;

  fs.mkdirSync(path.dirname(nextDeployDir), { recursive: true });
  fs.renameSync(legacyDeployDir, nextDeployDir);
}

function readLocalConfig(vaultDir: string): TeamLocalConfig | null {
  const config = readJsonConfig<TeamLocalConfig>(resolveLocalConfigPath(vaultDir));
  if (config) {
    migrateLegacyDeployDir(vaultDir);
    return config;
  }

  const legacyConfig = readJsonConfig<LegacyTeamLocalConfig>(resolveLegacyLocalConfigPath());
  if (!legacyConfig) return null;
  if (legacyConfig.vault_dir && legacyConfig.vault_dir !== vaultDir) return null;

  const migrated: TeamLocalConfig = {
    worker_name: legacyConfig.worker_name,
    worker_url: legacyConfig.worker_url,
    package_version: legacyConfig.package_version,
    created_at: legacyConfig.created_at,
    last_upgraded: legacyConfig.last_upgraded,
    config_version: legacyConfig.config_version ?? TEAM_CONFIG_VERSION,
  };
  writeLocalConfig(vaultDir, migrated);
  if (legacyConfig.api_key) writeSecret(vaultDir, TEAM_API_KEY_SECRET, legacyConfig.api_key);
  if (legacyConfig.mcp_token) writeSecret(vaultDir, TEAM_MCP_TOKEN_SECRET, legacyConfig.mcp_token);
  migrateLegacyDeployDir(vaultDir);
  return migrated;
}

function requireLocalConfig(vaultDir: string): TeamLocalConfig {
  const config = readLocalConfig(vaultDir);
  if (config) return config;

  console.error(`No local myco-team config found at ${resolveLocalConfigPath(vaultDir)}`);
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
        lastError.message.includes('Invalid API key') &&
        attempt < TEAM_MCP_ROTATION_RETRY_ATTEMPTS;
      if (!isRetryable) {
        throw lastError;
      }
      await delay(TEAM_MCP_ROTATION_RETRY_DELAY_MS);
    }
  }

  throw lastError ?? new Error('MCP token rotation failed');
}

async function reindexWorkerVectors(vaultDir: string, workerUrlOverride?: string): Promise<void> {
  const config = workerUrlOverride ? null : requireLocalConfig(vaultDir);
  const secrets = readSecrets(vaultDir);
  const apiKey = secrets[TEAM_API_KEY_SECRET];
  if (!apiKey) {
    throw new Error(`Missing ${TEAM_API_KEY_SECRET} secret in ${vaultDir}`);
  }
  const workerUrl = workerUrlOverride ?? config?.worker_url;
  if (!workerUrl) {
    throw new Error('No team worker URL configured');
  }

  for (const table of TEAM_VECTOR_REINDEX_TABLES) {
    let cursor: string | null = null;
    let processed = 0;
    let reindexed = 0;
    let deleted = 0;

    while (true) {
      let response: Response | null = null;
      let retryableError: Error | null = null;

      for (let attempt = 1; attempt <= TEAM_VECTOR_REINDEX_RETRY_ATTEMPTS; attempt += 1) {
        try {
          response = await fetch(`${workerUrl.replace(/\/+$/, '')}/vectors/reindex`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({ table, limit: TEAM_VECTOR_REINDEX_BATCH_SIZE, cursor }),
            signal: AbortSignal.timeout(TEAM_VECTOR_REINDEX_REQUEST_TIMEOUT_MS),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const isTimeout = message.includes('timeout');
          if (!isTimeout || attempt >= TEAM_VECTOR_REINDEX_RETRY_ATTEMPTS) {
            throw error;
          }
          retryableError = new Error(`Worker vector reindex timed out for ${table} (attempt ${attempt}/${TEAM_VECTOR_REINDEX_RETRY_ATTEMPTS})`);
          await delay(TEAM_VECTOR_REINDEX_RETRY_DELAY_MS);
          continue;
        }

        if (response.ok) {
          retryableError = null;
          break;
        }

        const body = await response.text();
        const isRetryable = response.status === 404 && body.includes('Not found') && attempt < TEAM_VECTOR_REINDEX_RETRY_ATTEMPTS;
        if (!isRetryable) {
          throw new Error(`Worker vector reindex failed for ${table}: ${response.status} ${body}`);
        }

        retryableError = new Error(`Worker vector reindex route not ready for ${table} yet (attempt ${attempt}/${TEAM_VECTOR_REINDEX_RETRY_ATTEMPTS})`);
        await delay(TEAM_VECTOR_REINDEX_RETRY_DELAY_MS);
      }

      if (!response?.ok) {
        throw retryableError ?? new Error(`Worker vector reindex failed for ${table}`);
      }

      const body = await response.json() as {
        processed: number;
        reindexed: number;
        deleted: number;
        next_cursor: string | null;
      };
      processed += body.processed;
      reindexed += body.reindexed;
      deleted += body.deleted;
      cursor = body.next_cursor;
      if (!cursor) break;
    }

    console.log(`  ✓ Reindexed ${table}: ${reindexed} upserted, ${deleted} deleted (${processed} processed)`);
  }
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

/**
 * Copy worker source to the vault deployment directory and patch wrangler.toml
 * with actual D1 database ID and resource names.
 */
function prepareDeployDir(vaultDir: string, d1Id: string, kvId: string): string {
  const srcDir = locateWorkerSource();
  const deployDir = resolveDeployDir(vaultDir);
  const name = resourceName(vaultDir);
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
        (toml) => toml.replace(TOML_TEAM_PACKAGE_VERSION_REGEX, `MYCO_TEAM_PACKAGE_VERSION = "${getTeamPackageVersion()}"`),
        (toml) => toml.replace(TOML_MYCO_SCHEMA_VERSION_REGEX, `MYCO_SCHEMA_VERSION = "${getMycoSchemaVersion()}"`),
      ],
    }],
    installDepsTimeoutMs: WRANGLER_COMMAND_TIMEOUT_MS * 3,
  });
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
  console.log('Provisioning team sync infrastructure...\n');

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

  const name = resourceName(vaultDir);
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

  // 6. Generate API key
  const apiKey = crypto.randomBytes(API_KEY_BYTES).toString('hex');

  // 7. Prepare deployment directory
  console.log('Preparing worker deployment...');
  const deployDir = prepareDeployDir(vaultDir, d1Id, kvId);

  // 7. Set API key secret via wrangler
  console.log('Setting API key secret...');
  try {
    runWrangler(['secret', 'put', TEAM_API_KEY_SECRET, '--name', name], {
      cwd: deployDir,
      input: apiKey,
      timeoutMs: WRANGLER_COMMAND_TIMEOUT_MS,
    });
    console.log('Secret set\n');
  } catch (err) {
    console.error(`Failed to set API key secret: ${(err as Error).message}`);
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

  // 9. Seed team config in the Worker
  console.log('Setting team configuration...');
  try {
    const { getMachineId } = await import('@myco/daemon/machine-id.js');
    const creatorMachineId = await getMachineId(vaultDir);
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

  // 10. Save config and API key locally
  updateTeamConfig(vaultDir, {
    enabled: true,
    worker_url: workerUrl,
  });
  writeSecret(vaultDir, TEAM_API_KEY_SECRET, apiKey);
  if (mcpToken) writeSecret(vaultDir, TEAM_MCP_TOKEN_SECRET, mcpToken);
  writeLocalConfig(vaultDir, {
    worker_name: name,
    worker_url: workerUrl,
    package_version: getTeamPackageVersion(),
    created_at: new Date().toISOString(),
    last_upgraded: new Date().toISOString(),
    config_version: TEAM_CONFIG_VERSION,
  });

  console.log('Team sync configured!\n');
  console.log(`  URL:     ${workerUrl}`);
  console.log(`  API Key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);
  if (mcpToken) {
    console.log(`  MCP:     ${mcpToken.slice(0, 8)}...${mcpToken.slice(-4)}`);
  }
  console.log('\nShare the URL and API key with teammates so they can connect.');
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
export function upgradeWorker(vaultDir: string): UpgradeResult {
  const config = loadConfig(vaultDir);
  if (!config.team.worker_url) {
    return { success: false, error: 'No team sync configured. Run: myco team init' };
  }

  migrateLegacyDeployDir(vaultDir);
  const deployDir = resolveDeployDir(vaultDir);
  const tomlPath = path.join(deployDir, 'wrangler.toml');

  if (!fs.existsSync(tomlPath)) {
    return { success: false, error: 'No deployment directory found. Run: myco team init' };
  }

  // Read ALL existing resource identifiers from current wrangler.toml.
  const existingToml = fs.readFileSync(tomlPath, 'utf-8');
  const d1Match = existingToml.match(TOML_DB_ID_REGEX);
  if (!d1Match || d1Match[1] === '<YOUR_D1_DATABASE_ID>') {
    return { success: false, error: 'Cannot determine D1 database ID from existing deployment. Run: myco team init' };
  }
  const d1Id = d1Match[1];

  const nameMatch = existingToml.match(/^name\s*=\s*"([^"]*)"/m);
  const dbNameMatch = existingToml.match(/database_name\s*=\s*"([^"]*)"/);
  const indexNameMatch = existingToml.match(/index_name\s*=\s*"([^"]*)"/);
  const workerName = nameMatch?.[1] ?? resourceName(vaultDir);

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
          (toml) => toml.replace(TOML_TEAM_PACKAGE_VERSION_REGEX, `MYCO_TEAM_PACKAGE_VERSION = "${getTeamPackageVersion()}"`),
          (toml) => toml.replace(TOML_MYCO_SCHEMA_VERSION_REGEX, `MYCO_SCHEMA_VERSION = "${getMycoSchemaVersion()}"`),
        ],
      }],
      installDepsTimeoutMs: WRANGLER_COMMAND_TIMEOUT_MS * 3,
    });
  } catch (err) {
    return { success: false, error: `Failed to install worker dependencies: ${(err as Error).message}` };
  }

  // Re-set API key secret before deploy (deploy can wipe secrets)
  const secrets = readSecrets(vaultDir);
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

    updateTeamConfig(vaultDir, {
      worker_url: workerUrl,
    });
    const localConfig = readLocalConfig(vaultDir);
    if (localConfig) {
      writeLocalConfig(vaultDir, {
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

export async function teamUpgrade(vaultDir: string, options: { reindexVectors?: boolean } = {}): Promise<void> {
  console.log('Upgrading team sync worker...\n');
  const result = upgradeWorker(vaultDir);
  if (!result.success) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(`Worker deployed: ${result.worker_url}`);
  console.log(`Version: ${result.version}`);
  if (options.reindexVectors) {
    console.log('Refreshing remote Vectorize metadata...');
    await reindexWorkerVectors(vaultDir, result.worker_url);
  }
  console.log('\nUpgrade complete.');
}

export async function teamReindexVectors(vaultDir: string): Promise<void> {
  console.log('Reindexing remote team vectors...\n');
  await reindexWorkerVectors(vaultDir);
  console.log('\nRemote vector reindex complete.');
}

export async function teamStatus(vaultDir: string): Promise<void> {
  const config = requireLocalConfig(vaultDir);
  const secrets = readSecrets(vaultDir);

  console.log(`Worker:      ${config.worker_name}`);
  console.log(`URL:         ${config.worker_url}`);
  console.log(`API Key:     ${maskSecret(secrets[TEAM_API_KEY_SECRET] ?? null)}`);
  console.log(`MCP Token:   ${maskSecret(secrets[TEAM_MCP_TOKEN_SECRET] ?? null)}`);
  console.log(`Package v:   ${config.package_version}`);
  console.log(`Created:     ${config.created_at}`);
  console.log(`Upgraded:    ${config.last_upgraded}`);
  console.log(`Config v:    ${config.config_version}`);
}

export async function teamRotateTokens(vaultDir: string, which: 'api' | 'mcp' | 'all' = 'all'): Promise<void> {
  const config = requireLocalConfig(vaultDir);
  const secrets = readSecrets(vaultDir);
  let currentApiKey = secrets[TEAM_API_KEY_SECRET] ?? '';
  let currentMcpToken = secrets[TEAM_MCP_TOKEN_SECRET] ?? null;

  let nextConfig = { ...config };

  if (which === 'api' || which === 'all') {
    const apiKey = crypto.randomBytes(API_KEY_BYTES).toString('hex');
    runWrangler(['secret', 'put', TEAM_API_KEY_SECRET, '--name', config.worker_name], {
      cwd: resolveDeployDir(vaultDir),
      input: apiKey,
      timeoutMs: WRANGLER_COMMAND_TIMEOUT_MS,
    });
    writeSecret(vaultDir, TEAM_API_KEY_SECRET, apiKey);
    currentApiKey = apiKey;
    nextConfig = {
      ...nextConfig,
      package_version: getTeamPackageVersion(),
      last_upgraded: new Date().toISOString(),
    };
    writeLocalConfig(vaultDir, nextConfig);
  }

  if (which === 'mcp' || which === 'all') {
    try {
      currentMcpToken = await rotateMcpTokenWithRetry(config.worker_url, currentApiKey);
      if (currentMcpToken) writeSecret(vaultDir, TEAM_MCP_TOKEN_SECRET, currentMcpToken);
    } catch (error) {
      writeLocalConfig(vaultDir, {
        ...nextConfig,
        last_upgraded: new Date().toISOString(),
      });
      throw new Error(
        `API key rotation completed, but MCP token rotation failed. Local config was updated to the new API key.\n${(error as Error).message}`,
      );
    }
  }

  nextConfig.last_upgraded = new Date().toISOString();
  writeLocalConfig(vaultDir, nextConfig);

  console.log(`API Key:   ${maskSecret(currentApiKey)}`);
  console.log(`MCP Token: ${maskSecret(currentMcpToken)}`);
}

export async function teamDestroy(vaultDir: string): Promise<void> {
  const config = requireLocalConfig(vaultDir);
  const errors: string[] = [];
  const deployDir = resolveDeployDir(vaultDir);

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

  if (errors.length > 0) {
    throw new Error(`Team destroy incomplete. Local state preserved for retry.\n${errors.join('\n')}`);
  }

  fs.rmSync(path.join(vaultDir, TEAM_STATE_DIR), { recursive: true, force: true });
  console.log(`Destroyed local myco-team state for ${config.worker_name}.`);
}
