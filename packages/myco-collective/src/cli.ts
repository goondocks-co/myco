import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  runWrangler,
  stageDeploymentDir,
  writeJsonConfig,
} from '@myco-deploy/index.js';

const CONFIG_DIR = '.myco-collective';
const CONFIG_FILE = 'config.json';
const DEPLOYMENTS_DIR = 'deployments';
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
  admin_token: string;
  mcp_token: string;
  created_at: string;
  last_upgraded: string;
  config_version: number;
  d1_database_id: string;
  kv_namespace_id: string;
  deploy_dir: string;
}

function configPath(): string {
  return resolveHomeConfigPath(CONFIG_DIR, CONFIG_FILE);
}

function readConfig(): CollectiveLocalConfig | null {
  const parsed = readJsonConfig<Partial<CollectiveLocalConfig>>(configPath());
  if (!parsed) return null;
  if (
    !parsed.worker_name ||
    !parsed.worker_url ||
    !parsed.admin_token ||
    !parsed.mcp_token ||
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
    admin_token: parsed.admin_token,
    mcp_token: parsed.mcp_token,
    created_at: parsed.created_at,
    last_upgraded: parsed.last_upgraded,
    config_version: parsed.config_version ?? CONFIG_VERSION,
    d1_database_id: parsed.d1_database_id,
    kv_namespace_id: parsed.kv_namespace_id,
    deploy_dir: parsed.deploy_dir ?? resolveDeploymentDir(parsed.worker_name),
  };
}

function writeConfig(config: CollectiveLocalConfig): void {
  writeJsonConfig(configPath(), config);
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

function resolveDeploymentDir(workerName: string): string {
  return path.join(os.homedir(), CONFIG_DIR, DEPLOYMENTS_DIR, workerName);
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

function ensureConfig(): CollectiveLocalConfig {
  const config = readConfig();
  if (!config) {
    throw new Error(`No local myco-collective config found at ${configPath()}`);
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

  const adminToken = createHexToken(TOKEN_BYTES);
  const mcpToken = createHexToken(TOKEN_BYTES);
  const d1Id = ensureD1Database(name);
  const kvId = ensureKvNamespace(name);

  const config: CollectiveLocalConfig = {
    worker_name: name,
    worker_url: '',
    admin_token: adminToken,
    mcp_token: mcpToken,
    created_at: new Date().toISOString(),
    last_upgraded: new Date().toISOString(),
    config_version: CONFIG_VERSION,
    d1_database_id: d1Id,
    kv_namespace_id: kvId,
    deploy_dir: resolveDeploymentDir(name),
  };

  const deployedConfig = await deployCollective(config);
  writeConfig(deployedConfig);
  console.log(`Collective deployed at ${deployedConfig.worker_url}`);
}

export async function collectiveUpgrade(): Promise<void> {
  ensureUiBuild();
  const nextConfig = await deployCollective(ensureConfig());
  writeConfig(nextConfig);

  console.log(`Collective upgraded at ${nextConfig.worker_url}`);
}

export async function collectiveStatus(): Promise<void> {
  const config = ensureConfig();
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

export async function collectiveAddProject(name: string, workerUrl: string, apiKey: string): Promise<void> {
  const config = ensureConfig();
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

export async function collectiveRotateTokens(which: 'admin' | 'mcp' | 'all' = 'all'): Promise<void> {
  if (!ROTATE_CHOICES.has(which)) {
    throw new Error('Token selection must be one of admin, mcp, or all');
  }

  const config = ensureConfig();
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
    admin_token: body.admin_token ?? config.admin_token,
    mcp_token: body.mcp_token ?? config.mcp_token,
    last_upgraded: new Date().toISOString(),
  };
  writeConfig(nextConfig);

  console.log(JSON.stringify({
    rotated: which,
    admin_token: maskSecret(nextConfig.admin_token),
    mcp_token: maskSecret(nextConfig.mcp_token),
  }, null, 2));
}

export async function collectiveDestroy(): Promise<void> {
  const config = ensureConfig();
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

  fs.rmSync(config.deploy_dir, { recursive: true, force: true });
  fs.rmSync(configPath(), { force: true });
  console.log(`Destroyed local myco-collective config for ${config.worker_name}.`);
}
