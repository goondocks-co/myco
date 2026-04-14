import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSecret, readSecrets } from '@myco/config/secrets.js';
import { COLLECTIVE_ADMIN_TOKEN_SECRET, COLLECTIVE_MCP_TOKEN_SECRET } from '@myco/constants.js';
import {
  extractJsonArray,
  buildCommandEnv,
  createHexToken,
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

const CONFIG_DIR = 'collective';
const CONFIG_FILE = 'config.json';
const DEPLOY_DIR = 'worker';
const COMMAND_TIMEOUT_MS = 60_000;
const TOKEN_BYTES = 24;
const CONFIG_VERSION = 2;
const LEGACY_CONFIG_DIR = '.myco-collective';
const TOML_NAME_REGEX = /^name\s*=\s*"[^"]*"/m;
const TOML_D1_PLACEHOLDER_REGEX = /<YOUR_D1_DATABASE_ID>/g;
const TOML_KV_PLACEHOLDER_REGEX = /<YOUR_KV_NAMESPACE_ID>/g;
const UI_BUILD_SCRIPT = 'build:ui';
const ROTATE_CHOICES = new Set(['admin', 'mcp', 'all']);
const ADMIN_BOOTSTRAP_SECRET = 'MYCO_BOOTSTRAP_ADMIN_TOKEN';
const MCP_BOOTSTRAP_SECRET = 'MYCO_BOOTSTRAP_MCP_TOKEN';

interface CollectiveLocalConfig {
  worker_name: string;
  worker_url: string;
  created_at: string;
  last_upgraded: string;
  config_version: number;
  d1_database_id: string;
  kv_namespace_id: string;
  deploy_dir: string;
}

interface LegacyCollectiveLocalConfig extends CollectiveLocalConfig {
  admin_token?: string;
  mcp_token?: string;
}

function configPath(vaultDir: string): string {
  return resolveVaultConfigPath(vaultDir, CONFIG_DIR, CONFIG_FILE);
}

function legacyConfigPath(): string {
  return resolveHomeConfigPath(LEGACY_CONFIG_DIR, CONFIG_FILE);
}

function resolveDeploymentDir(vaultDir: string): string {
  return path.join(vaultDir, CONFIG_DIR, DEPLOY_DIR);
}

function migrateLegacyDeployDir(vaultDir: string, legacyDeployDir?: string): void {
  if (!legacyDeployDir || !fs.existsSync(legacyDeployDir)) return;
  const nextDeployDir = resolveDeploymentDir(vaultDir);
  if (nextDeployDir === legacyDeployDir || fs.existsSync(nextDeployDir)) return;

  fs.mkdirSync(path.dirname(nextDeployDir), { recursive: true });
  fs.renameSync(legacyDeployDir, nextDeployDir);
}

function readConfig(vaultDir: string): CollectiveLocalConfig | null {
  const parsed = readJsonConfig<Partial<CollectiveLocalConfig>>(configPath(vaultDir));
  if (!parsed) return null;
  if (
    !parsed.worker_name ||
    !parsed.worker_url ||
    !parsed.created_at ||
    !parsed.last_upgraded ||
    !parsed.d1_database_id ||
    !parsed.kv_namespace_id
  ) {
    return null;
  }

  return {
    worker_name: parsed.worker_name,
    worker_url: parsed.worker_url,
    created_at: parsed.created_at,
    last_upgraded: parsed.last_upgraded,
    config_version: parsed.config_version ?? CONFIG_VERSION,
    d1_database_id: parsed.d1_database_id,
    kv_namespace_id: parsed.kv_namespace_id,
    deploy_dir: parsed.deploy_dir ?? resolveDeploymentDir(vaultDir),
  };
}

function writeConfig(vaultDir: string, config: CollectiveLocalConfig): void {
  writeJsonConfig(configPath(vaultDir), config);
}

function wrangler(args: string[], cwd?: string, input?: string): string {
  return runWrangler(args, { cwd, input, timeoutMs: COMMAND_TIMEOUT_MS });
}

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function workerSourceDir(): string {
  return path.join(packageRoot(), 'worker');
}

function uiBuildDir(): string {
  return path.join(packageRoot(), 'dist', 'ui');
}

function ensureUiBuild(): void {
  fs.rmSync(uiBuildDir(), { recursive: true, force: true });
  execFileSync('npm', ['run', UI_BUILD_SCRIPT], {
    cwd: packageRoot(),
    env: buildCommandEnv(),
    encoding: 'utf-8',
    timeout: COMMAND_TIMEOUT_MS * 6,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const indexPath = path.join(uiBuildDir(), 'index.html');
  if (!fs.existsSync(indexPath)) {
    throw new Error(`Collective UI build output is missing at ${indexPath}`);
  }
}

function ensureD1Database(name: string): string {
  try {
    const d1Output = wrangler(['d1', 'create', name]);
    return parseD1Id(d1Output);
  } catch (error) {
    const message = (error as Error).message;
    if (!message.includes('already exists')) throw error;
    const listOutput = wrangler(['d1', 'list', '--json']);
    const databases = extractJsonArray(listOutput) as Array<{ name: string; uuid: string }>;
    const existing = databases.find((database) => database.name === name);
    if (!existing) {
      throw new Error(`D1 database "${name}" already exists but could not be resolved`);
    }
    return existing.uuid;
  }
}

function ensureKvNamespace(name: string): string {
  const namespaceName = `${name}-secrets`;
  const lookupExisting = (): string => {
    const listOutput = wrangler(['kv', 'namespace', 'list']);
    const namespaces = extractJsonArray(listOutput) as Array<{ id: string; title: string }>;
    const normalize = (value: string) => value.replace(/[-_]/g, '');
    const target = normalize(namespaceName);
    const existing = namespaces.find((namespace) =>
      normalize(namespace.title) === target || normalize(namespace.title).endsWith(target),
    );
    if (!existing) {
      throw new Error(`KV namespace "${namespaceName}" already exists but could not be resolved`);
    }
    return existing.id;
  };

  try {
    const kvOutput = wrangler(['kv', 'namespace', 'create', namespaceName]);
    return parseKvNamespaceId(kvOutput);
  } catch (error) {
    const message = (error as Error).message;
    if (!message.includes('already exists') && !message.includes('duplicate') && !message.includes('same title')) {
      throw error;
    }
    return lookupExisting();
  }
}

function prepareDeployDir(config: { worker_name: string; d1_database_id: string; kv_namespace_id: string; deploy_dir: string }): string {
  return stageDeploymentDir({
    sourceDir: workerSourceDir(),
    deployDir: config.deploy_dir,
    reset: true,
    extraCopies: [{ sourceDir: uiBuildDir(), destinationSubdir: 'ui' }],
    textPatches: [{
      filePath: 'wrangler.toml',
      transforms: [
        (wranglerToml) => wranglerToml.replace(TOML_NAME_REGEX, `name = "${config.worker_name}"`),
        (wranglerToml) => wranglerToml.replace(TOML_D1_PLACEHOLDER_REGEX, config.d1_database_id),
        (wranglerToml) => wranglerToml.replace(TOML_KV_PLACEHOLDER_REGEX, config.kv_namespace_id),
      ],
    }],
    installDepsTimeoutMs: COMMAND_TIMEOUT_MS * 3,
  });
}

function migrateLegacyConfig(vaultDir: string): CollectiveLocalConfig | null {
  const existing = readConfig(vaultDir);
  if (existing) return existing;

  const legacy = readJsonConfig<Partial<LegacyCollectiveLocalConfig>>(legacyConfigPath());
  if (!legacy) return null;
  if (
    !legacy.worker_name ||
    !legacy.worker_url ||
    !legacy.created_at ||
    !legacy.last_upgraded ||
    !legacy.d1_database_id ||
    !legacy.kv_namespace_id
  ) {
    return null;
  }

  migrateLegacyDeployDir(vaultDir, legacy.deploy_dir);
  if (legacy.admin_token) writeSecret(vaultDir, COLLECTIVE_ADMIN_TOKEN_SECRET, legacy.admin_token);
  if (legacy.mcp_token) writeSecret(vaultDir, COLLECTIVE_MCP_TOKEN_SECRET, legacy.mcp_token);

  const migrated: CollectiveLocalConfig = {
    worker_name: legacy.worker_name,
    worker_url: legacy.worker_url,
    created_at: legacy.created_at,
    last_upgraded: legacy.last_upgraded,
    config_version: legacy.config_version ?? CONFIG_VERSION,
    d1_database_id: legacy.d1_database_id,
    kv_namespace_id: legacy.kv_namespace_id,
    deploy_dir: resolveDeploymentDir(vaultDir),
  };
  writeConfig(vaultDir, migrated);
  return migrated;
}

function ensureConfig(vaultDir: string): CollectiveLocalConfig {
  const config = migrateLegacyConfig(vaultDir);
  if (!config) {
    throw new Error(`No local myco-collective config found at ${configPath(vaultDir)}`);
  }
  return config;
}

async function putBootstrapSecrets(vaultDir: string, config: CollectiveLocalConfig): Promise<void> {
  const tokens = readSecrets(vaultDir);
  const adminToken = tokens[COLLECTIVE_ADMIN_TOKEN_SECRET];
  const mcpToken = tokens[COLLECTIVE_MCP_TOKEN_SECRET];
  if (!adminToken || !mcpToken) {
    throw new Error('Missing Collective bootstrap tokens in .myco/secrets.env');
  }
  wrangler(['secret', 'put', ADMIN_BOOTSTRAP_SECRET, '--name', config.worker_name], config.deploy_dir, adminToken);
  wrangler(['secret', 'put', MCP_BOOTSTRAP_SECRET, '--name', config.worker_name], config.deploy_dir, mcpToken);
}

async function deployCollective(vaultDir: string, config: CollectiveLocalConfig): Promise<CollectiveLocalConfig> {
  prepareDeployDir(config);
  await putBootstrapSecrets(vaultDir, config);

  const deployOutput = wrangler(['deploy'], config.deploy_dir);
  return {
    ...config,
    worker_url: parseWorkerUrl(deployOutput),
    last_upgraded: new Date().toISOString(),
    config_version: CONFIG_VERSION,
  };
}

export async function collectiveInstall(vaultDir: string, name = 'myco-collective'): Promise<void> {
  ensureUiBuild();

  const adminToken = createHexToken(TOKEN_BYTES);
  const mcpToken = createHexToken(TOKEN_BYTES);
  writeSecret(vaultDir, COLLECTIVE_ADMIN_TOKEN_SECRET, adminToken);
  writeSecret(vaultDir, COLLECTIVE_MCP_TOKEN_SECRET, mcpToken);
  const d1Id = ensureD1Database(name);
  const kvId = ensureKvNamespace(name);

  const config: CollectiveLocalConfig = {
    worker_name: name,
    worker_url: '',
    created_at: new Date().toISOString(),
    last_upgraded: new Date().toISOString(),
    config_version: CONFIG_VERSION,
    d1_database_id: d1Id,
    kv_namespace_id: kvId,
    deploy_dir: resolveDeploymentDir(vaultDir),
  };

  const deployedConfig = await deployCollective(vaultDir, config);
  writeConfig(vaultDir, deployedConfig);
  console.log(`Collective deployed at ${deployedConfig.worker_url}`);
}

export async function collectiveUpgrade(vaultDir: string): Promise<void> {
  ensureUiBuild();
  const nextConfig = await deployCollective(vaultDir, ensureConfig(vaultDir));
  writeConfig(vaultDir, nextConfig);

  console.log(`Collective upgraded at ${nextConfig.worker_url}`);
}

export async function collectiveStatus(vaultDir: string): Promise<void> {
  const config = ensureConfig(vaultDir);
  const secrets = readSecrets(vaultDir);
  const adminToken = secrets[COLLECTIVE_ADMIN_TOKEN_SECRET] ?? '';
  const mcpToken = secrets[COLLECTIVE_MCP_TOKEN_SECRET] ?? '';
  let remoteHealth: unknown = null;

  try {
    const verifyResponse = await fetch(`${config.worker_url}/api/auth/verify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });

    if (verifyResponse.ok) {
      remoteHealth = await verifyResponse.json();
    } else {
      const healthResponse = await fetch(`${config.worker_url}/health`);
      remoteHealth = healthResponse.ok ? await healthResponse.json() : { status: healthResponse.status };
    }
  } catch (error) {
    remoteHealth = { error: (error as Error).message };
  }

  console.log(JSON.stringify({
    worker_name: config.worker_name,
    worker_url: config.worker_url,
    admin_token: maskSecret(adminToken),
    mcp_token: maskSecret(mcpToken),
    created_at: config.created_at,
    last_upgraded: config.last_upgraded,
    config_version: config.config_version,
    d1_database_id: config.d1_database_id,
    kv_namespace_id: config.kv_namespace_id,
    deploy_dir: config.deploy_dir,
    remote_health: remoteHealth,
  }, null, 2));
}

export async function collectiveAddProject(vaultDir: string, name: string, workerUrl: string, apiKey: string): Promise<void> {
  const config = ensureConfig(vaultDir);
  const secrets = readSecrets(vaultDir);
  const response = await fetch(`${config.worker_url}/api/projects`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secrets[COLLECTIVE_ADMIN_TOKEN_SECRET] ?? ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, worker_url: workerUrl, api_key: apiKey }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  console.log(await response.text());
}

export async function collectiveRotateTokens(vaultDir: string, which: 'admin' | 'mcp' | 'all' = 'all'): Promise<void> {
  if (!ROTATE_CHOICES.has(which)) {
    throw new Error('Token selection must be one of admin, mcp, or all');
  }

  const config = ensureConfig(vaultDir);
  const secrets = readSecrets(vaultDir);
  const response = await fetch(`${config.worker_url}/api/auth/rotate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secrets[COLLECTIVE_ADMIN_TOKEN_SECRET] ?? ''}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ which }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const body = await response.json() as { admin_token?: string | null; mcp_token?: string | null };
  if (body.admin_token) writeSecret(vaultDir, COLLECTIVE_ADMIN_TOKEN_SECRET, body.admin_token);
  if (body.mcp_token) writeSecret(vaultDir, COLLECTIVE_MCP_TOKEN_SECRET, body.mcp_token);
  const nextConfig: CollectiveLocalConfig = { ...config, last_upgraded: new Date().toISOString() };
  writeConfig(vaultDir, nextConfig);

  console.log(JSON.stringify({
    rotated: which,
    admin_token: maskSecret(body.admin_token ?? secrets[COLLECTIVE_ADMIN_TOKEN_SECRET] ?? null),
    mcp_token: maskSecret(body.mcp_token ?? secrets[COLLECTIVE_MCP_TOKEN_SECRET] ?? null),
  }, null, 2));
}

export async function collectiveDestroy(vaultDir: string): Promise<void> {
  const config = ensureConfig(vaultDir);
  const errors: string[] = [];

  try {
    wrangler(['delete', config.worker_name], config.deploy_dir);
  } catch (error) {
    errors.push(`worker delete failed: ${(error as Error).message}`);
  }

  try {
    wrangler(['d1', 'delete', config.worker_name, '--skip-confirmation']);
  } catch (error) {
    errors.push(`d1 delete failed: ${(error as Error).message}`);
  }

  try {
    wrangler([
      'kv',
      'namespace',
      'delete',
      '--namespace-id',
      config.kv_namespace_id,
      '--skip-confirmation',
    ]);
  } catch (error) {
    errors.push(`kv delete failed: ${(error as Error).message}`);
  }

  if (errors.length > 0) {
    throw new Error(`Collective destroy incomplete. Local state preserved for retry.\n${errors.join('\n')}`);
  }

  fs.rmSync(path.join(vaultDir, CONFIG_DIR), { recursive: true, force: true });
  console.log(`Destroyed local myco-collective state for ${config.worker_name}.`);
}
