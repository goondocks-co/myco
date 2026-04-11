/**
 * CLI team commands — provision and manage Cloudflare team sync infrastructure.
 *
 * `myco team init`    — Provision D1 database, Vectorize index, deploy worker.
 * `myco team upgrade` — Redeploy worker with updated source.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, updateTeamConfig } from '../config/loader.js';
import { writeSecret, readSecrets } from '../config/secrets.js';
import { resolvePackageRoot } from '../symbionts/detect.js';
import { getPluginVersion } from '../version.js';
import { WRANGLER_COMMAND_TIMEOUT_MS, TEAM_API_KEY_SECRET } from '../constants.js';

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
const WORKER_SOURCE_DIR = 'src/worker';

/** Deployment directory name within the vault. */
const TEAM_WORKER_DIR = '.team-worker';

/** Regex to extract D1 database ID from wrangler d1 create output (JSON format). */
const D1_ID_JSON_REGEX = /"database_id"\s*:\s*"([0-9a-f-]{36})"/i;

/** Regex to extract D1 database ID from wrangler d1 create output (text format). */
const D1_ID_TEXT_REGEX = /id:\s*([0-9a-f-]{36})/i;

/** Regex to extract worker URL from wrangler deploy output. */
const WORKER_URL_REGEX = /(https:\/\/[^\s]+\.workers\.dev)/;

/** Regex to match wrangler.toml name field. */
const TOML_NAME_REGEX = /^name\s*=\s*"[^"]*"/m;

/** Regex to match wrangler.toml D1 placeholder. */
const TOML_D1_PLACEHOLDER_REGEX = /<YOUR_D1_DATABASE_ID>/g;

/** Regex to match wrangler.toml database_name field. */
const TOML_DB_NAME_REGEX = /database_name\s*=\s*"[^"]*"/g;

/** Regex to match wrangler.toml index_name field. */
const TOML_INDEX_NAME_REGEX = /index_name\s*=\s*"[^"]*"/g;

/** Regex to match database_id in existing wrangler.toml. */
const TOML_DB_ID_REGEX = /database_id\s*=\s*"([^"]+)"/;

/** Regex to match wrangler.toml KV namespace placeholder. */
const TOML_KV_PLACEHOLDER_REGEX = /<YOUR_KV_NAMESPACE_ID>/g;

/** Regex to extract the KV namespace ID from an existing wrangler.toml. */
const TOML_KV_ID_REGEX = /\[\[kv_namespaces\]\][\s\S]*?id\s*=\s*"([0-9a-f]+)"/;

/**
 * Regex to extract the KV namespace ID from `wrangler kv namespace create` output.
 * Wrangler prints a JSON configuration snippet like:
 *   { "kv_namespaces": [ { "binding": "...", "id": "7cc069cb32b4438b29079cca4714056" } ] }
 * Note: Cloudflare KV IDs are hex strings of variable length (observed 31-32 chars).
 */
const KV_ID_REGEX = /"id":\s*"([0-9a-f]+)"/i;


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

/** Run a wrangler command and return stdout. Throws on failure, surfacing stderr. */
function wrangler(args: string[], options?: { cwd?: string }): string {
  try {
    return execFileSync('wrangler', args, {
      encoding: 'utf-8',
      timeout: WRANGLER_COMMAND_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options,
    });
  } catch (err) {
    // execFileSync loses stderr in err.message — reconstruct it here so
    // callers see the actual wrangler failure instead of just "Command failed".
    const execErr = err as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
    const stderr = execErr.stderr?.toString() ?? '';
    const stdout = execErr.stdout?.toString() ?? '';
    const detail = [stderr, stdout].filter(Boolean).join('\n').trim();
    throw new Error(detail || execErr.message);
  }
}

/** Find the worker source directory. Checks dist layout first (installed), then source layout (dev). */
function locateWorkerSource(): string {
  const root = resolvePackageRoot();
  const distPath = path.join(root, 'dist', WORKER_SOURCE_DIR);
  if (fs.existsSync(distPath)) return distPath;
  const srcPath = path.join(root, WORKER_SOURCE_DIR);
  if (fs.existsSync(srcPath)) return srcPath;
  throw new Error(`Cannot find ${WORKER_SOURCE_DIR} — are you running from the myco package?`);
}

/**
 * Copy worker source to the vault deployment directory and patch wrangler.toml
 * with actual D1 database ID and resource names.
 */
function prepareDeployDir(vaultDir: string, d1Id: string, kvId: string): string {
  const srcDir = locateWorkerSource();
  const deployDir = path.join(vaultDir, TEAM_WORKER_DIR);

  // Copy all worker source files
  fs.cpSync(srcDir, deployDir, { recursive: true });

  // Patch wrangler.toml with actual IDs
  const tomlPath = path.join(deployDir, 'wrangler.toml');
  let toml = fs.readFileSync(tomlPath, 'utf-8');
  const name = resourceName(vaultDir);
  toml = toml.replace(TOML_NAME_REGEX, `name = "${name}"`);
  toml = toml.replace(TOML_D1_PLACEHOLDER_REGEX, d1Id);
  toml = toml.replace(TOML_DB_NAME_REGEX, `database_name = "${name}"`);
  toml = toml.replace(TOML_INDEX_NAME_REGEX, `index_name = "${name}-vectors"`);
  toml = toml.replace(TOML_KV_PLACEHOLDER_REGEX, kvId);
  fs.writeFileSync(tomlPath, toml, 'utf-8');

  // Install runtime dependencies before deploy (required for bundled imports)
  installDeploymentDeps(deployDir);

  return deployDir;
}

/** Extract a JSON array from wrangler output that may be prefixed with banner text. */
function extractJsonArray(output: string): unknown[] {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON array found in output:\n${output}`);
  }
  return JSON.parse(output.slice(start, end + 1));
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
    const match = output.match(KV_ID_REGEX);
    if (match) return match[1];
    // Created successfully but we couldn't parse — fall back to list lookup
    return lookupExisting();
  } catch (err) {
    const errMsg = (err as Error).message;
    if (errMsg.includes('already exists') || errMsg.includes('duplicate') || errMsg.includes('same title')) {
      return lookupExisting();
    }
    throw err;
  }
}

/** Install npm dependencies in the deploy directory. Required for runtime imports. */
function installDeploymentDeps(deployDir: string): void {
  const packageJsonPath = path.join(deployDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return;
  execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund'], {
    encoding: 'utf-8',
    timeout: WRANGLER_COMMAND_TIMEOUT_MS * 3,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: deployDir,
  });
}

/** Extract D1 database ID from wrangler d1 create output (handles both JSON and text formats). */
function parseD1Id(output: string): string {
  const jsonMatch = output.match(D1_ID_JSON_REGEX);
  if (jsonMatch) return jsonMatch[1];
  const textMatch = output.match(D1_ID_TEXT_REGEX);
  if (textMatch) return textMatch[1];
  throw new Error(`Could not parse D1 database ID from wrangler output:\n${output}`);
}

/** Extract worker URL from wrangler deploy output. */
function parseWorkerUrl(output: string): string {
  // Output typically contains: "https://<name>.<subdomain>.workers.dev"
  const match = output.match(WORKER_URL_REGEX);
  if (!match) throw new Error(`Could not parse worker URL from deploy output:\n${output}`);
  return match[1];
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
    execFileSync('wrangler', ['secret', 'put', TEAM_API_KEY_SECRET, '--name', name], {
      encoding: 'utf-8',
      timeout: WRANGLER_COMMAND_TIMEOUT_MS,
      input: apiKey,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: deployDir,
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
    const { getMachineId } = await import('../daemon/machine-id.js');
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

  // 10. Save config and API key locally
  updateTeamConfig(vaultDir, {
    enabled: true,
    worker_url: workerUrl,
    deployed_worker_version: getPluginVersion(),
  });
  writeSecret(vaultDir, TEAM_API_KEY_SECRET, apiKey);

  console.log('Team sync configured!\n');
  console.log(`  URL:     ${workerUrl}`);
  console.log(`  API Key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);
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

  const deployDir = path.join(vaultDir, TEAM_WORKER_DIR);
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

  // Re-copy worker source from package (updated code)
  const srcDir = locateWorkerSource();
  fs.cpSync(srcDir, deployDir, { recursive: true });

  // Patch wrangler.toml preserving existing resource names
  let toml = fs.readFileSync(path.join(deployDir, 'wrangler.toml'), 'utf-8');
  toml = toml.replace(TOML_NAME_REGEX, `name = "${workerName}"`);
  toml = toml.replace(TOML_D1_PLACEHOLDER_REGEX, d1Id);
  toml = toml.replace(TOML_DB_NAME_REGEX, `database_name = "${dbNameMatch?.[1] ?? workerName}"`);
  toml = toml.replace(TOML_INDEX_NAME_REGEX, `index_name = "${indexNameMatch?.[1] ?? `${workerName}-vectors`}"`);
  toml = toml.replace(TOML_KV_PLACEHOLDER_REGEX, kvId);
  fs.writeFileSync(path.join(deployDir, 'wrangler.toml'), toml, 'utf-8');

  // Install runtime dependencies before deploy (required for bundled imports)
  try {
    installDeploymentDeps(deployDir);
  } catch (err) {
    return { success: false, error: `Failed to install worker dependencies: ${(err as Error).message}` };
  }

  // Re-set API key secret before deploy (deploy can wipe secrets)
  const secrets = readSecrets(vaultDir);
  const apiKey = secrets[TEAM_API_KEY_SECRET];
  if (apiKey) {
    try {
      execFileSync('wrangler', ['secret', 'put', TEAM_API_KEY_SECRET, '--name', workerName], {
        encoding: 'utf-8',
        timeout: WRANGLER_COMMAND_TIMEOUT_MS,
        input: apiKey,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: deployDir,
      });
    } catch {
      // Non-fatal — secret may already be set
    }
  }

  // Redeploy
  try {
    const deployOutput = wrangler(['deploy'], { cwd: deployDir });
    const workerUrl = parseWorkerUrl(deployOutput);
    const version = getPluginVersion();

    updateTeamConfig(vaultDir, {
      worker_url: workerUrl,
      deployed_worker_version: version,
    });

    return { success: true, worker_url: workerUrl, version };
  } catch (err) {
    return { success: false, error: `Failed to deploy worker: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function teamUpgrade(vaultDir: string): Promise<void> {
  console.log('Upgrading team sync worker...\n');
  const result = upgradeWorker(vaultDir);
  if (!result.success) {
    console.error(result.error);
    process.exit(1);
  }
  console.log(`Worker deployed: ${result.worker_url}`);
  console.log(`Version: ${result.version}`);
  console.log('\nUpgrade complete.');
}
