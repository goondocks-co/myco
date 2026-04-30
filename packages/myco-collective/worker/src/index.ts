import { createMcpServerInstance } from './mcp/server';
import {
  ensureBootstrapTokens,
  rotateTokens,
  tokenHash,
  validateAdminAuth,
  validateMcpAuth,
  validateWorkerAuth,
  ADMIN_TOKEN_KEY,
  MCP_TOKEN_KEY,
  WORKER_TOKEN_KEY,
} from './auth';
import { projectSupportsTool } from './fanout';
import { initD1Schema } from './schema';
import { handleCollectiveProject, handleCollectiveProjects, handleCollectiveSearch, handleCollectiveSettings, listProjects, listSettings } from './tools';
import { COLLECTIVE_SETTING_DEFINITIONS, validateCollectiveSetting } from './settings';

export interface Env {
  MYCO_COLLECTIVE_DB: D1Database;
  MYCO_SECRETS: KVNamespace;
  COLLECTIVE_NAME?: string;
  MYCO_BOOTSTRAP_ADMIN_TOKEN?: string;
  MYCO_BOOTSTRAP_MCP_TOKEN?: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  worker_url: string;
  api_key_hash: string;
  capabilities: string[];
  package_version: string | null;
  schema_version: number | null;
  last_seen: number | null;
  registered_at: number;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;
let schemaInitialized = false;
const AUTH_ROTATE_CHOICES = new Set(['admin', 'mcp', 'all']);
const WORKER_QUERY_TOOLS = new Set(['collective_search', 'collective_projects', 'collective_project', 'collective_settings']);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function collectiveOrigin(request: Request): string {
  return new URL(request.url).origin;
}

async function persistTokenHashes(env: Env): Promise<void> {
  const [adminToken, mcpToken] = await Promise.all([
    env.MYCO_SECRETS.get(ADMIN_TOKEN_KEY),
    env.MYCO_SECRETS.get(MCP_TOKEN_KEY),
  ]);
  await env.MYCO_COLLECTIVE_DB.batch([
    env.MYCO_COLLECTIVE_DB.prepare('INSERT OR REPLACE INTO collective_meta (key, value) VALUES (?, ?)').bind('admin_token_hash', tokenHash(adminToken) ?? ''),
    env.MYCO_COLLECTIVE_DB.prepare('INSERT OR REPLACE INTO collective_meta (key, value) VALUES (?, ?)').bind('mcp_token_hash', tokenHash(mcpToken) ?? ''),
  ]);
}

async function configureProjectWorker(
  env: Env,
  collectiveUrl: string,
  project: { id: string; worker_url: string },
  workerApiKey: string,
): Promise<Record<string, unknown>> {
  const collectiveWorkerToken = await env.MYCO_SECRETS.get(WORKER_TOKEN_KEY);
  if (!collectiveWorkerToken) {
    throw new Error('Collective worker token is not configured');
  }

  const response = await fetch(`${project.worker_url.replace(/\/+$/, '')}/collective/configure`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${workerApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      collective_url: collectiveUrl,
      collective_api_key: collectiveWorkerToken,
      project_id: project.id,
    }),
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new Error(`Team worker configure failed: ${response.status} ${responseText}`);
  }

  const body = responseText ? JSON.parse(responseText) as Record<string, unknown> : {};
  const capabilities = Array.isArray(body.capabilities) ? JSON.stringify(body.capabilities) : null;
  const packageVersion = typeof body.package_version === 'string' ? body.package_version : null;
  const schemaVersion = typeof body.schema_version === 'number' ? body.schema_version : null;
  await env.MYCO_COLLECTIVE_DB.prepare(
    `UPDATE projects
       SET capabilities = COALESCE(?, capabilities),
           package_version = COALESCE(?, package_version),
           schema_version = COALESCE(?, schema_version),
           last_seen = ?
     WHERE id = ?`,
  ).bind(capabilities, packageVersion, schemaVersion, epochSeconds(), project.id).run();
  return body;
}

async function ensureInitialized(env: Env): Promise<void> {
  if (!schemaInitialized) {
    await initD1Schema(env.MYCO_COLLECTIVE_DB);
    schemaInitialized = true;
  }
  const { adminToken, mcpToken } = await ensureBootstrapTokens(
    env.MYCO_SECRETS,
    env.MYCO_BOOTSTRAP_ADMIN_TOKEN,
    env.MYCO_BOOTSTRAP_MCP_TOKEN,
  );
  const statements = [
    env.MYCO_COLLECTIVE_DB.prepare('INSERT OR REPLACE INTO collective_meta (key, value) VALUES (?, ?)').bind('collective_name', env.COLLECTIVE_NAME ?? 'Myco Collective'),
    env.MYCO_COLLECTIVE_DB.prepare('INSERT OR REPLACE INTO collective_meta (key, value) VALUES (?, ?)').bind('admin_token_hash', tokenHash(adminToken) ?? ''),
    env.MYCO_COLLECTIVE_DB.prepare('INSERT OR REPLACE INTO collective_meta (key, value) VALUES (?, ?)').bind('mcp_token_hash', tokenHash(mcpToken) ?? ''),
  ];
  await env.MYCO_COLLECTIVE_DB.batch(statements);
}

function hashToken(token: string): string {
  let hash = 0;
  for (let index = 0; index < token.length; index++) {
    hash = ((hash << 5) - hash + token.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(16).padStart(8, '0').slice(0, 8);
}

async function handleHealth(env: Env): Promise<Response> {
  const projects = await listProjects(env);
  const adminToken = await env.MYCO_SECRETS.get(ADMIN_TOKEN_KEY);
  const mcpToken = await env.MYCO_SECRETS.get(MCP_TOKEN_KEY);
  return jsonResponse({
    status: 'ok',
    collective_name: env.COLLECTIVE_NAME ?? 'Myco Collective',
    project_count: projects.length,
    admin_token_hash: tokenHash(adminToken),
    mcp_token_hash: tokenHash(mcpToken),
  });
}

async function handleListProjects(env: Env): Promise<Response> {
  const projects = await listProjects(env);
  return jsonResponse({ projects });
}

async function handleAddProject(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    name?: string;
    worker_url?: string;
    api_key?: string;
    capabilities?: string[];
    package_version?: string;
    schema_version?: number;
  };
  if (!body.name || !body.worker_url || !body.api_key) {
    return jsonResponse({ error: 'name, worker_url, and api_key are required' }, 400);
  }

  const projectId = crypto.randomUUID();
  const collectiveUrl = collectiveOrigin(request);
  await env.MYCO_SECRETS.put(`project:${projectId}:api_key`, body.api_key);
  await env.MYCO_COLLECTIVE_DB.prepare(
    `INSERT INTO projects (id, name, worker_url, api_key_hash, capabilities, package_version, schema_version, last_seen, registered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    projectId,
    body.name,
    body.worker_url,
    hashToken(body.api_key),
    JSON.stringify(body.capabilities ?? ['search', 'collective_proxy']),
    body.package_version ?? null,
    body.schema_version ?? null,
    null,
    epochSeconds(),
  ).run();

  try {
    const configuration = await configureProjectWorker(
      env,
      collectiveUrl,
      { id: projectId, worker_url: body.worker_url },
      body.api_key,
    );

    return jsonResponse({
      id: projectId,
      name: body.name,
      worker_url: body.worker_url,
      configured: true,
      configuration,
    });
  } catch (error) {
    await env.MYCO_COLLECTIVE_DB.prepare('DELETE FROM projects WHERE id = ?').bind(projectId).run();
    await env.MYCO_SECRETS.delete(`project:${projectId}:api_key`);
    throw error;
  }
}

async function handleDeleteProject(projectId: string, env: Env): Promise<Response> {
  const existing = await env.MYCO_COLLECTIVE_DB.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first<{ id: string }>();
  if (!existing?.id) {
    return jsonResponse({ error: 'Project not found' }, 404);
  }

  await env.MYCO_COLLECTIVE_DB.prepare('DELETE FROM projects WHERE id = ?').bind(projectId).run();
  await env.MYCO_SECRETS.delete(`project:${projectId}:api_key`);

  return jsonResponse({ deleted: projectId });
}

async function handleConfigureProject(projectId: string, request: Request, env: Env): Promise<Response> {
  const project = await env.MYCO_COLLECTIVE_DB.prepare(
    'SELECT id, worker_url FROM projects WHERE id = ?',
  ).bind(projectId).first<{ id: string; worker_url: string }>();
  if (!project?.id) {
    return jsonResponse({ error: 'Project not found' }, 404);
  }

  const workerApiKey = await env.MYCO_SECRETS.get(`project:${projectId}:api_key`);
  if (!workerApiKey) {
    return jsonResponse({ error: 'Project worker API key is missing' }, 500);
  }

  const collectiveUrl = collectiveOrigin(request);
  const configuration = await configureProjectWorker(env, collectiveUrl, project, workerApiKey);
  return jsonResponse({ configured: projectId, configuration });
}

async function handleProjectHeartbeat(projectId: string, request: Request, env: Env): Promise<Response> {
  const existing = await env.MYCO_COLLECTIVE_DB.prepare('SELECT id FROM projects WHERE id = ?').bind(projectId).first<{ id: string }>();
  if (!existing?.id) {
    return jsonResponse({ error: 'Project not found' }, 404);
  }

  const body = await request.json() as {
    capabilities?: unknown;
    package_version?: unknown;
    schema_version?: unknown;
  };

  const capabilities = Array.isArray(body.capabilities)
    ? JSON.stringify(body.capabilities.filter((value): value is string => typeof value === 'string'))
    : null;
  const packageVersion = typeof body.package_version === 'string' ? body.package_version : null;
  const schemaVersion = typeof body.schema_version === 'number' ? body.schema_version : null;
  const lastSeen = epochSeconds();

  await env.MYCO_COLLECTIVE_DB.prepare(
    `UPDATE projects
       SET capabilities = COALESCE(?, capabilities),
           package_version = COALESCE(?, package_version),
           schema_version = COALESCE(?, schema_version),
           last_seen = ?
     WHERE id = ?`,
  ).bind(capabilities, packageVersion, schemaVersion, lastSeen, projectId).run();

  const settings = await listSettings(env);
  return jsonResponse({
    acknowledged: projectId,
    last_seen: lastSeen,
    capabilities: capabilities ? JSON.parse(capabilities) as string[] : undefined,
    settings_overrides: Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, value.value])),
  });
}

async function handleUpsertSetting(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { key?: string; value?: unknown; description?: string; updated_by?: string };
  if (!body.key) {
    return jsonResponse({ error: 'key is required' }, 400);
  }
  const validation = validateCollectiveSetting(body.key, body.value);
  if (!validation.ok) {
    return jsonResponse({ error: validation.error }, 400);
  }
  await env.MYCO_COLLECTIVE_DB.prepare(
    'INSERT OR REPLACE INTO settings_overrides (key, value, description, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)',
  ).bind(
    body.key,
    JSON.stringify(body.value ?? null),
    body.description ?? validation.definition.description,
    epochSeconds(),
    body.updated_by ?? 'admin',
  ).run();
  return jsonResponse({ updated: body.key });
}

async function handleApiSettings(env: Env): Promise<Response> {
  const settings = await listSettings(env);
  return jsonResponse({
    settings_overrides: Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, value.value])),
    settings_records: settings,
    setting_definitions: COLLECTIVE_SETTING_DEFINITIONS,
    capabilities: ['collective_search', 'collective_projects', 'collective_project', 'collective_settings'],
  });
}

async function handleAuthVerify(env: Env): Promise<Response> {
  const projects = await listProjects(env);
  return jsonResponse({
    authenticated: true,
    collective_name: env.COLLECTIVE_NAME ?? 'Myco Collective',
    project_count: projects.length,
  });
}

async function handleAuthAccess(request: Request, env: Env): Promise<Response> {
  const [adminToken, mcpToken] = await Promise.all([
    env.MYCO_SECRETS.get(ADMIN_TOKEN_KEY),
    env.MYCO_SECRETS.get(MCP_TOKEN_KEY),
  ]);

  return jsonResponse({
    collective_name: env.COLLECTIVE_NAME ?? 'Myco Collective',
    mcp_endpoint: `${collectiveOrigin(request)}/mcp`,
    mcp_token: mcpToken,
    admin_token_hash: tokenHash(adminToken),
    mcp_token_hash: tokenHash(mcpToken),
  });
}

async function handleAuthRotate(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { which?: string };
  const which = body.which ?? 'all';
  if (!AUTH_ROTATE_CHOICES.has(which)) {
    return jsonResponse({ error: 'which must be one of admin, mcp, or all' }, 400);
  }

  const rotated = await rotateTokens(env.MYCO_SECRETS, which as 'admin' | 'mcp' | 'all');
  await persistTokenHashes(env);

  return jsonResponse({
    rotated: which,
    admin_token: rotated.adminToken,
    mcp_token: rotated.mcpToken,
    admin_token_hash: tokenHash(rotated.adminToken),
    mcp_token_hash: tokenHash(rotated.mcpToken),
  });
}

export async function dispatchApiQuery(
  env: Env,
  body: { tool?: string; args?: Record<string, unknown> },
): Promise<Response> {
  const tool = body.tool ?? '';
  if (!tool) {
    return jsonResponse({ error: 'tool is required' }, 400);
  }

  const projects = await listProjects(env);
  if (tool !== 'collective_projects' && tool !== 'collective_settings' && !projects.some((project) => projectSupportsTool(project, tool))) {
    return jsonResponse({ error: `No registered project supports ${tool}` }, 400);
  }

  switch (tool) {
    case 'collective_search': {
      const result = await handleCollectiveSearch(env, body.args as { query: string; project?: string; limit?: number });
      return jsonResponse(JSON.parse(result.content[0].text));
    }
    case 'collective_projects': {
      const result = await handleCollectiveProjects(env);
      return jsonResponse(JSON.parse(result.content[0].text));
    }
    case 'collective_project': {
      const result = await handleCollectiveProject(env, body.args as { project: string; include_digest?: boolean });
      return jsonResponse(JSON.parse(result.content[0].text));
    }
    case 'collective_settings': {
      const result = await handleCollectiveSettings(env);
      return jsonResponse(JSON.parse(result.content[0].text));
    }
    default:
      return jsonResponse({ error: `Unknown collective tool: ${tool}` }, 404);
  }
}

async function handleApiQuery(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { tool?: string; args?: Record<string, unknown> };
  return dispatchApiQuery(env, body);
}

async function handleWorkerSettings(env: Env): Promise<Response> {
  const settings = await listSettings(env);
  return jsonResponse({
    settings_overrides: Object.fromEntries(Object.entries(settings).map(([key, value]) => [key, value.value])),
    capabilities: ['collective_search', 'collective_projects', 'collective_project', 'collective_settings'],
  });
}

async function handleWorkerQuery(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { tool?: string; args?: Record<string, unknown> };
  const tool = body.tool ?? '';
  if (!tool) {
    return jsonResponse({ error: 'tool is required' }, 400);
  }
  if (!WORKER_QUERY_TOOLS.has(tool)) {
    return jsonResponse({ error: `Worker queries do not support ${tool}` }, 400);
  }
  return dispatchApiQuery(env, body);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    await ensureInitialized(env);

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'GET' && path === '/health') {
      return handleHealth(env);
    }

    if (path.startsWith('/mcp')) {
      const authError = await validateMcpAuth(request, env.MYCO_SECRETS);
      if (authError) return authError;
      const server = createMcpServerInstance(env);
      const { createMcpHandler } = await import('agents/mcp');
      const handler = createMcpHandler(server);
      return handler(request, env, ctx);
    }

    if (path.startsWith('/api/')) {
      const projectMatch = path.match(/^\/api\/projects\/([^/]+)(?:\/(configure|heartbeat))?$/);
      if (projectMatch) {
        const [, projectId, action] = projectMatch;
        if (action === 'heartbeat') {
          const workerAuthError = await validateWorkerAuth(request, env.MYCO_SECRETS);
          if (workerAuthError) return workerAuthError;
          if (method === 'POST') return handleProjectHeartbeat(projectId, request, env);
        }

        const adminAuthError = await validateAdminAuth(request, env.MYCO_SECRETS);
        if (adminAuthError) return adminAuthError;
        if (method === 'DELETE' && !action) return handleDeleteProject(projectId, env);
        if (method === 'POST' && action === 'configure') return handleConfigureProject(projectId, request, env);
      }

      if (path === '/api/worker/settings' || path === '/api/worker/query') {
        const workerAuthError = await validateWorkerAuth(request, env.MYCO_SECRETS);
        if (workerAuthError) return workerAuthError;
        if (method === 'GET' && path === '/api/worker/settings') return handleWorkerSettings(env);
        if (method === 'POST' && path === '/api/worker/query') return handleWorkerQuery(request, env);
      }

      const authError = await validateAdminAuth(request, env.MYCO_SECRETS);
      if (authError) return authError;

      if (method === 'POST' && path === '/api/auth/verify') return handleAuthVerify(env);
      if (method === 'GET' && path === '/api/auth/access') return handleAuthAccess(request, env);
      if (method === 'POST' && path === '/api/auth/rotate') return handleAuthRotate(request, env);
      if (method === 'GET' && path === '/api/projects') return handleListProjects(env);
      if (method === 'POST' && path === '/api/projects') return handleAddProject(request, env);
      if (method === 'GET' && path === '/api/settings') return handleApiSettings(env);
      if (method === 'PUT' && path === '/api/settings') return handleUpsertSetting(request, env);
      if (method === 'POST' && path === '/api/query') return handleApiQuery(request, env);
    }

    return jsonResponse({ error: 'Not found' }, 404);
  },
} satisfies ExportedHandler<Env>;
