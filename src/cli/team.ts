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
import { fileURLToPath } from 'node:url';
import { loadConfig, updateTeamConfig } from '../config/loader.js';
import { writeSecret } from '../config/secrets.js';
import { findPackageRoot } from '../utils/find-package-root.js';
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


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a project hash from cwd for unique resource naming. */
function projectHash(): string {
  const hash = crypto.createHash('sha256').update(process.cwd()).digest('hex');
  return hash.slice(0, PROJECT_HASH_LENGTH);
}

/** Build the unique resource name for this project's team infrastructure. */
function resourceName(): string {
  return `${TEAM_RESOURCE_PREFIX}-${projectHash()}`;
}

/** Run a wrangler command and return stdout. Throws on failure. */
function wrangler(args: string[], options?: { cwd?: string }): string {
  return execFileSync('wrangler', args, {
    encoding: 'utf-8',
    timeout: WRANGLER_COMMAND_TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...options,
  });
}

/** Find the package root (where src/worker/ lives). */
function locatePackageRoot(): string {
  // Check CLAUDE_PLUGIN_ROOT first (dogfooding), then traverse up
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? process.env.CURSOR_PLUGIN_ROOT;
  if (pluginRoot && fs.existsSync(path.join(pluginRoot, WORKER_SOURCE_DIR))) {
    return pluginRoot;
  }

  // Walk up from this file's compiled location
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const root = findPackageRoot(scriptDir);
  if (root && fs.existsSync(path.join(root, WORKER_SOURCE_DIR))) return root;

  throw new Error(`Cannot find ${WORKER_SOURCE_DIR} — are you running from the myco package?`);
}

/**
 * Copy worker source to the vault deployment directory and patch wrangler.toml
 * with actual D1 database ID and resource names.
 */
function prepareDeployDir(vaultDir: string, d1Id: string): string {
  const pkgRoot = locatePackageRoot();
  const srcDir = path.join(pkgRoot, WORKER_SOURCE_DIR);
  const deployDir = path.join(vaultDir, TEAM_WORKER_DIR);

  // Copy all worker source files
  fs.cpSync(srcDir, deployDir, { recursive: true });

  // Patch wrangler.toml with actual IDs
  const tomlPath = path.join(deployDir, 'wrangler.toml');
  let toml = fs.readFileSync(tomlPath, 'utf-8');
  const name = resourceName();
  toml = toml.replace(TOML_NAME_REGEX, `name = "${name}"`);
  toml = toml.replace(TOML_D1_PLACEHOLDER_REGEX, d1Id);
  toml = toml.replace(TOML_DB_NAME_REGEX, `database_name = "${name}"`);
  toml = toml.replace(TOML_INDEX_NAME_REGEX, `index_name = "${name}-vectors"`);
  fs.writeFileSync(tomlPath, toml, 'utf-8');

  return deployDir;
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

  const name = resourceName();
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
    if (errMsg.includes('already exists')) {
      console.log('Vectorize index already exists, reusing\n');
    } else {
      console.error(`Failed to create Vectorize index: ${errMsg}`);
      process.exit(1);
    }
  }

  // 5. Generate API key
  const apiKey = crypto.randomBytes(API_KEY_BYTES).toString('hex');

  // 6. Prepare deployment directory
  console.log('Preparing worker deployment...');
  const deployDir = prepareDeployDir(vaultDir, d1Id);

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
  });
  writeSecret(vaultDir, TEAM_API_KEY_SECRET, apiKey);

  console.log('Team sync configured!\n');
  console.log(`  URL:     ${workerUrl}`);
  console.log(`  API Key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);
  console.log('\nShare the URL and API key with teammates so they can connect.');
}

export async function teamUpgrade(vaultDir: string): Promise<void> {
  console.log('Upgrading team sync worker...\n');

  const config = loadConfig(vaultDir);
  if (!config.team.worker_url) {
    console.error('No team sync configured. Run: myco team init');
    process.exit(1);
  }

  const deployDir = path.join(vaultDir, TEAM_WORKER_DIR);
  const tomlPath = path.join(deployDir, 'wrangler.toml');

  if (!fs.existsSync(tomlPath)) {
    console.error('No deployment directory found. Run: myco team init');
    process.exit(1);
  }

  // Read existing D1 ID from current wrangler.toml
  const existingToml = fs.readFileSync(tomlPath, 'utf-8');
  const d1Match = existingToml.match(TOML_DB_ID_REGEX);
  if (!d1Match || d1Match[1] === '<YOUR_D1_DATABASE_ID>') {
    console.error('Cannot determine D1 database ID from existing deployment. Run: myco team init');
    process.exit(1);
  }
  const d1Id = d1Match[1];

  // Re-copy worker source and patch
  console.log('Updating worker source...');
  prepareDeployDir(vaultDir, d1Id);

  // Redeploy
  console.log('Deploying...');
  try {
    const deployOutput = wrangler(['deploy'], { cwd: deployDir });
    const workerUrl = parseWorkerUrl(deployOutput);
    console.log(`Worker deployed: ${workerUrl}\n`);

    // Update URL in config in case it changed
    updateTeamConfig(vaultDir, { worker_url: workerUrl });
  } catch (err) {
    console.error(`Failed to deploy worker: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log('Upgrade complete.');
}
