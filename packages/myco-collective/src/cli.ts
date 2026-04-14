import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteSecrets, readSecrets } from '@myco/config/secrets.js';
import { COLLECTIVE_ADMIN_TOKEN_SECRET, COLLECTIVE_MCP_TOKEN_SECRET } from '@myco/constants.js';
import { resolveVaultDir } from '@myco/vault/resolve.js';
import {
  extractJsonArray,
  buildCommandEnv,
  createHexToken,
  maskSecret,
  parseD1Id,
  parseKvNamespaceId,
  parseWorkerUrl,
  readJsonConfig,
  resolveHomeDir,
  resolveNamedHomeConfigPath,
  resolveHomeConfigPath,
  resolveVaultConfigPath,
  runWrangler,
  stageDeploymentDir,
  writeJsonConfig,
} from '@myco-deploy/index.js';

const PROJECT_CONFIG_DIR = 'collective';
const COLLECTIVE_CONFIG_ROOT = '.myco-collective';
const CONFIG_FILE = 'config.json';
const DEPLOY_DIR = 'worker';
const COMMAND_TIMEOUT_MS = 60_000;
const TOKEN_BYTES = 24;
const CONFIG_VERSION = 2;
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
  admin_token: string;
  mcp_token: string;
}

interface LegacyCollectiveLocalConfig {
  worker_name?: string;
  worker_url?: string;
  created_at?: string;
  last_upgraded?: string;
  config_version?: number;
  d1_database_id?: string;
  kv_namespace_id?: string;
  deploy_dir?: string;
  admin_token?: string;
  mcp_token?: string;
}

function collectiveBaseDir(): string {
  return path.join(resolveHomeDir(), COLLECTIVE_CONFIG_ROOT);
}

function collectiveRootDir(name: string): string {
  return path.join(collectiveBaseDir(), name);
}

function configPath(name: string): string {
  return resolveNamedHomeConfigPath(COLLECTIVE_CONFIG_ROOT, name, CONFIG_FILE);
}

function legacyConfigPath(): string {
  return resolveHomeConfigPath(COLLECTIVE_CONFIG_ROOT, CONFIG_FILE);
}

function projectLocalConfigPath(vaultDir: string): string {
  return resolveVaultConfigPath(vaultDir, PROJECT_CONFIG_DIR, CONFIG_FILE);
}

function projectLocalDeployDir(vaultDir: string): string {
  return path.join(vaultDir, PROJECT_CONFIG_DIR, DEPLOY_DIR);
}

function resolveDeploymentDir(name: string): string {
  return path.join(collectiveRootDir(name), DEPLOY_DIR);
}

function readConfig(name: string): CollectiveLocalConfig | null {
  const parsed = readJsonConfig<Partial<CollectiveLocalConfig>>(configPath(name));
  if (!parsed) return null;
  if (
    !parsed.worker_name ||
    !parsed.worker_url ||
    !parsed.created_at ||
    !parsed.last_upgraded ||
    !parsed.d1_database_id ||
    !parsed.kv_namespace_id ||
    !parsed.admin_token ||
    !parsed.mcp_token
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
    deploy_dir: parsed.deploy_dir ?? resolveDeploymentDir(parsed.worker_name),
    admin_token: parsed.admin_token,
    mcp_token: parsed.mcp_token,
  };
}

function writeConfig(name: string, config: CollectiveLocalConfig): void {
  writeJsonConfig(configPath(name), config);
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

function collectHomeScopedNames(): string[] {
  if (!fs.existsSync(collectiveBaseDir())) return [];
  return fs.readdirSync(collectiveBaseDir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(configPath(name)))
    .sort();
}

function tryResolveVaultDirFromCwd(): string | null {
  try {
    return resolveVaultDir(process.cwd());
  } catch {
    return null;
  }
}

function tryReadProjectLocalState(): {
  vaultDir: string;
  config: LegacyCollectiveLocalConfig;
  adminToken: string | null;
  mcpToken: string | null;
} | null {
  const vaultDir = tryResolveVaultDirFromCwd();
  if (!vaultDir) return null;
  const config = readJsonConfig<Partial<LegacyCollectiveLocalConfig>>(projectLocalConfigPath(vaultDir));
  if (
    !config?.worker_name ||
    !config.worker_url ||
    !config.created_at ||
    !config.last_upgraded ||
    !config.d1_database_id ||
    !config.kv_namespace_id
  ) {
    return null;
  }

  const secrets = readSecrets(vaultDir);
  return {
    vaultDir,
    config: config as LegacyCollectiveLocalConfig,
    adminToken: secrets[COLLECTIVE_ADMIN_TOKEN_SECRET] ?? null,
    mcpToken: secrets[COLLECTIVE_MCP_TOKEN_SECRET] ?? null,
  };
}

function collectAvailableNames(): string[] {
  const names = new Set(collectHomeScopedNames());

  const legacy = readJsonConfig<Partial<LegacyCollectiveLocalConfig>>(legacyConfigPath());
  if (legacy?.worker_name) names.add(legacy.worker_name);

  const projectLocal = tryReadProjectLocalState();
  if (projectLocal?.config.worker_name) names.add(projectLocal.config.worker_name);

  return [...names].sort();
}

function requireCollectiveName(name?: string): string {
  if (name?.trim()) return name.trim();
  const availableNames = collectAvailableNames();
  if (availableNames.length === 1) return availableNames[0];
  if (availableNames.length === 0) {
    throw new Error('No local myco-collective config found. Provide a collective name or run `myco-collective install <name>`.');
  }
  throw new Error(`Multiple collectives are configured (${availableNames.join(', ')}). Provide the collective name explicitly.`);
}

function pruneIfEmpty(dirPath: string): void {
  if (!fs.existsSync(dirPath)) return;
  if (fs.readdirSync(dirPath).length > 0) return;
  fs.rmdirSync(dirPath);
}

function migrateDeployDir(fromDir: string | undefined, toDir: string): void {
  if (!fromDir || !fs.existsSync(fromDir) || fromDir === toDir || fs.existsSync(toDir)) return;
  fs.mkdirSync(path.dirname(toDir), { recursive: true });
  fs.renameSync(fromDir, toDir);
}

function cleanupMigratedProjectState(vaultDir: string): void {
  fs.rmSync(projectLocalConfigPath(vaultDir), { force: true });
  deleteSecrets(vaultDir, [COLLECTIVE_ADMIN_TOKEN_SECRET, COLLECTIVE_MCP_TOKEN_SECRET]);
  pruneIfEmpty(path.join(vaultDir, PROJECT_CONFIG_DIR));
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

function migrateLegacyConfig(name: string): CollectiveLocalConfig | null {
  const existing = readConfig(name);
  if (existing) return existing;

  const legacy = readJsonConfig<Partial<LegacyCollectiveLocalConfig>>(legacyConfigPath());
  if (legacy?.worker_name === name) {
    migrateDeployDir(legacy.deploy_dir, resolveDeploymentDir(name));
    const migrated: CollectiveLocalConfig = {
      worker_name: legacy.worker_name,
      worker_url: legacy.worker_url ?? '',
      created_at: legacy.created_at ?? new Date().toISOString(),
      last_upgraded: legacy.last_upgraded ?? new Date().toISOString(),
      config_version: legacy.config_version ?? CONFIG_VERSION,
      d1_database_id: legacy.d1_database_id ?? '',
      kv_namespace_id: legacy.kv_namespace_id ?? '',
      deploy_dir: resolveDeploymentDir(name),
      admin_token: legacy.admin_token ?? '',
      mcp_token: legacy.mcp_token ?? '',
    };
    if (
      migrated.worker_url &&
      migrated.d1_database_id &&
      migrated.kv_namespace_id &&
      migrated.admin_token &&
      migrated.mcp_token
    ) {
      writeConfig(name, migrated);
      fs.rmSync(legacyConfigPath(), { force: true });
      return migrated;
    }
  }

  const projectLocal = tryReadProjectLocalState();
  if (projectLocal?.config.worker_name !== name) return null;
  const projectConfig = projectLocal.config;

  migrateDeployDir(projectConfig.deploy_dir ?? projectLocalDeployDir(projectLocal.vaultDir), resolveDeploymentDir(name));
  const migrated: CollectiveLocalConfig = {
    worker_name: projectConfig.worker_name!,
    worker_url: projectConfig.worker_url!,
    created_at: projectConfig.created_at!,
    last_upgraded: projectConfig.last_upgraded!,
    config_version: projectConfig.config_version ?? CONFIG_VERSION,
    d1_database_id: projectConfig.d1_database_id!,
    kv_namespace_id: projectConfig.kv_namespace_id!,
    deploy_dir: resolveDeploymentDir(name),
    admin_token: projectLocal.adminToken ?? '',
    mcp_token: projectLocal.mcpToken ?? '',
  };
  if (!migrated.admin_token || !migrated.mcp_token) {
    throw new Error(`Project-local Collective state for "${name}" is missing bootstrap tokens and cannot be migrated cleanly.`);
  }
  writeConfig(name, migrated);
  cleanupMigratedProjectState(projectLocal.vaultDir);
  return migrated;
}

function ensureConfig(name?: string): CollectiveLocalConfig {
  const collectiveName = requireCollectiveName(name);
  const config = migrateLegacyConfig(collectiveName);
  if (!config) {
    throw new Error(`No local myco-collective config found at ${configPath(collectiveName)}`);
  }
  return config;
}

async function putBootstrapSecrets(config: CollectiveLocalConfig): Promise<void> {
  wrangler(['secret', 'put', ADMIN_BOOTSTRAP_SECRET, '--name', config.worker_name], config.deploy_dir, config.admin_token);
  wrangler(['secret', 'put', MCP_BOOTSTRAP_SECRET, '--name', config.worker_name], config.deploy_dir, config.mcp_token);
}

async function deployCollective(config: CollectiveLocalConfig): Promise<CollectiveLocalConfig> {
  prepareDeployDir(config);
  await putBootstrapSecrets(config);

  const deployOutput = wrangler(['deploy'], config.deploy_dir);
  return {
    ...config,
    worker_url: parseWorkerUrl(deployOutput),
    last_upgraded: new Date().toISOString(),
    config_version: CONFIG_VERSION,
  };
}

export async function collectiveInstall(name = 'myco-collective'): Promise<void> {
  ensureUiBuild();
  if (migrateLegacyConfig(name)) {
    throw new Error(`Collective "${name}" already exists. Use \`myco-collective upgrade ${name}\`.`);
  }

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
    deploy_dir: resolveDeploymentDir(name),
    admin_token: createHexToken(TOKEN_BYTES),
    mcp_token: createHexToken(TOKEN_BYTES),
  };

  const deployedConfig = await deployCollective(config);
  writeConfig(name, deployedConfig);
  console.log(`Collective deployed at ${deployedConfig.worker_url}`);
}

export async function collectiveUpgrade(name?: string): Promise<void> {
  ensureUiBuild();
  const currentConfig = ensureConfig(name);
  const nextConfig = await deployCollective(currentConfig);
  writeConfig(currentConfig.worker_name, nextConfig);

  console.log(`Collective upgraded at ${nextConfig.worker_url}`);
}

export async function collectiveStatus(name?: string): Promise<void> {
  const config = ensureConfig(name);
  let remoteHealth: unknown = null;

  try {
    const verifyResponse = await fetch(`${config.worker_url}/api/auth/verify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.admin_token}`,
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
    admin_token: maskSecret(config.admin_token),
    mcp_token: maskSecret(config.mcp_token),
    created_at: config.created_at,
    last_upgraded: config.last_upgraded,
    config_version: config.config_version,
    d1_database_id: config.d1_database_id,
    kv_namespace_id: config.kv_namespace_id,
    deploy_dir: config.deploy_dir,
    remote_health: remoteHealth,
  }, null, 2));
}

export async function collectiveAddProject(name: string, workerUrl: string, apiKey: string, collectiveName?: string): Promise<void> {
  const config = ensureConfig(collectiveName);
  const response = await fetch(`${config.worker_url}/api/projects`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.admin_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name, worker_url: workerUrl, api_key: apiKey }),
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  console.log(await response.text());
}

export async function collectiveRotateTokens(name: string | undefined, which: 'admin' | 'mcp' | 'all' = 'all'): Promise<void> {
  if (!ROTATE_CHOICES.has(which)) {
    throw new Error('Token selection must be one of admin, mcp, or all');
  }

  const config = ensureConfig(name);
  const response = await fetch(`${config.worker_url}/api/auth/rotate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.admin_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ which }),
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const body = await response.json() as { admin_token?: string | null; mcp_token?: string | null };
  const nextConfig: CollectiveLocalConfig = {
    ...config,
    last_upgraded: new Date().toISOString(),
    admin_token: body.admin_token ?? config.admin_token,
    mcp_token: body.mcp_token ?? config.mcp_token,
  };
  writeConfig(config.worker_name, nextConfig);

  console.log(JSON.stringify({
    rotated: which,
    admin_token: maskSecret(nextConfig.admin_token),
    mcp_token: maskSecret(nextConfig.mcp_token),
  }, null, 2));
}

export async function collectiveDestroy(name?: string): Promise<void> {
  const config = ensureConfig(name);
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

  fs.rmSync(collectiveRootDir(config.worker_name), { recursive: true, force: true });
  pruneIfEmpty(collectiveBaseDir());
  console.log(`Destroyed local myco-collective state for ${config.worker_name}.`);
}
