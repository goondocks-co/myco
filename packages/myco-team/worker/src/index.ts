/**
 * Myco Team Sync — Cloudflare Worker
 *
 * Provides team-wide storage and vector search backed by D1 + Vectorize + Workers AI.
 * Each node (machine) pushes its outbox records here; the worker deduplicates by
 * content_hash and maintains a shared Vectorize index for semantic search.
 */

import { initD1Schema } from './schema';
import { validateAuth } from './auth';
import { createMcpHandler } from 'agents/mcp';
import { createMcpServerInstance } from './mcp/server';
import { authenticateMcpRequest, ensureMcpToken, rotateMcpToken, getMcpTokenHash, MCP_TOKEN_KEY } from './mcp/auth';
import { toCloudSearchResult } from './mcp/result-shape';
import { searchKnowledge, embedText, type TeamVectorMetadata } from './search-helpers';
import { fetchRecord, isAllowedRecordType } from './records';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Env {
  MYCO_TEAM_DB: D1Database;
  MYCO_TEAM_VECTORS: VectorizeIndex;
  AI: Ai;
  MYCO_TEAM_API_KEY: string;
  SYNC_PROTOCOL_VERSION: string;
  MYCO_SECRETS: KVNamespace;
  MYCO_TEAM_PACKAGE_VERSION?: string;
  MYCO_SCHEMA_VERSION?: string;
}

/** Tables that support embedding in Vectorize. */
const EMBEDDABLE_TABLES: Record<string, string> = {
  spores: 'content',
  sessions: 'summary',
  plans: 'content',
  artifacts: 'content',
  skill_records: 'description',
};

/** All tables the sync endpoint accepts records for. */
const SYNCED_TABLES = [
  'sessions',
  'prompt_batches',
  'spores',
  'entities',
  'graph_edges',
  'entity_mentions',
  'resolution_events',
  'plans',
  'artifacts',
  'digest_extracts',
  'skill_candidates',
  'skill_records',
  'skill_usage',
] as const;

type SyncedTable = (typeof SYNCED_TABLES)[number];

interface SyncRecord {
  table: SyncedTable;
  operation: 'upsert' | 'delete';
  id: string;
  machine_id: string;
  content_hash?: string | null;
  data: Record<string, unknown>;
}

interface ConnectPayload {
  machine_id: string;
  package_version?: string;
  schema_version?: number;
  sync_protocol_version?: number;
}

interface SyncPayload {
  sync_protocol_version: number;
  machine_id: string;
  records: SyncRecord[];
}

interface SearchResult {
  table: string;
  id: string;
  machine_id: string;
  score: number;
  data: Record<string, unknown>;
}

interface VectorReindexCursor {
  created_at: number;
  id: string;
  machine_id: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Whether initD1Schema has already run for this Worker instance. */
let schemaInitialized = false;

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 50;
const COLLECTIVE_WORKER_TOKEN_KV = 'collective_worker_token';
const LEGACY_COLLECTIVE_API_KEY_KV = 'collective_api_key';
const COLLECTIVE_SETTINGS_SYNC_INTERVAL_SECONDS = 5 * 60;
const COLLECTIVE_HEARTBEAT_INTERVAL_SECONDS = 5 * 60;
const COLLECTIVE_STALE_AFTER_SECONDS = COLLECTIVE_HEARTBEAT_INTERVAL_SECONDS * 3;
const DEFAULT_TEAM_PACKAGE_VERSION = '0.1.0';
const TEAM_COLLECTIVE_CAPABILITIES = ['search', 'digest', 'collective_proxy'] as const;
const TEAM_COLLECTIVE_QUERY_TOOLS = new Set(['collective_search', 'collective_projects', 'collective_project', 'collective_settings']);
const VECTOR_REINDEX_DEFAULT_BATCH = 100;
const VECTOR_REINDEX_MAX_BATCH = 250;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

function errorResponse(message: string, status: number): Response {
  return jsonResponse({ error: message }, status);
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Build a Vectorize namespace ID for a record: `{table}:{id}:{machine_id}`.
 */
function legacyVectorId(table: string, id: string, machineId: string): string {
  return `${table}:${id}:${machineId}`;
}

async function vectorId(table: string, id: string, machineId: string): Promise<string> {
  const payload = new TextEncoder().encode(`${table}:${id}:${machineId}`);
  const digest = await crypto.subtle.digest('SHA-256', payload);
  const bytes = new Uint8Array(digest).slice(0, 16);
  const encoded = btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `v1:${encoded}`;
}

async function readTeamConfig(env: Env): Promise<Record<string, string>> {
  const rows = await env.MYCO_TEAM_DB.prepare('SELECT key, value FROM team_config').all<{
    key: string;
    value: string;
  }>();
  const config: Record<string, string> = {};
  for (const row of rows.results) {
    config[row.key] = row.value;
  }
  return config;
}

async function writeTeamConfig(env: Env, entries: Record<string, string>): Promise<void> {
  const statements = Object.entries(entries).map(([key, value]) =>
    env.MYCO_TEAM_DB.prepare('INSERT OR REPLACE INTO team_config (key, value) VALUES (?, ?)').bind(key, value),
  );
  if (statements.length > 0) {
    await env.MYCO_TEAM_DB.batch(statements);
  }
}

function parseCollectiveSettings(config: Record<string, string>): Record<string, unknown> {
  const raw = config.collective_settings_cache;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseCapabilities(config: Record<string, string>): string[] {
  const raw = config.collective_capabilities_cache;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function parseSchemaVersion(env: Env): number | null {
  const rawValue = env.MYCO_SCHEMA_VERSION?.trim();
  if (!rawValue) return null;
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function teamCollectiveMetadata(env: Env): { capabilities: string[]; package_version: string; schema_version: number | null } {
  return {
    capabilities: [...TEAM_COLLECTIVE_CAPABILITIES],
    package_version: env.MYCO_TEAM_PACKAGE_VERSION?.trim() || DEFAULT_TEAM_PACKAGE_VERSION,
    schema_version: parseSchemaVersion(env),
  };
}

async function syncCollectiveSettings(env: Env, force = false): Promise<Record<string, unknown>> {
  const config = await readTeamConfig(env);
  const enabled = config.collective_enabled === 'true';
  const collectiveUrl = config.collective_url;
  const lastSync = Number(config.last_collective_settings_sync ?? '0');

  if (!enabled || !collectiveUrl) {
    return parseCollectiveSettings(config);
  }

  const now = epochSeconds();
  if (!force && lastSync > 0 && now - lastSync < COLLECTIVE_SETTINGS_SYNC_INTERVAL_SECONDS) {
    return parseCollectiveSettings(config);
  }

  const collectiveWorkerToken = await getCollectiveWorkerToken(env);
  if (!collectiveWorkerToken) {
    return parseCollectiveSettings(config);
  }

  try {
    const response = await fetch(`${collectiveUrl.replace(/\/+$/, '')}/api/worker/settings`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${collectiveWorkerToken}`,
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Collective settings sync failed: ${response.status}`);
    }

    const body = await response.json() as {
      settings_overrides?: Record<string, unknown>;
      capabilities?: string[];
      project_id?: string;
    };
    const settings = body.settings_overrides ?? {};

    await writeTeamConfig(env, {
      collective_enabled: 'true',
      collective_url: collectiveUrl,
      collective_project_id: body.project_id ?? config.collective_project_id ?? '',
      collective_capabilities_cache: JSON.stringify(body.capabilities ?? parseCapabilities(config)),
      collective_settings_cache: JSON.stringify(settings),
      last_collective_settings_sync: String(now),
    });

    return settings;
  } catch {
    return parseCollectiveSettings(config);
  }
}

async function sendCollectiveHeartbeat(env: Env, force = false): Promise<void> {
  const config = await readTeamConfig(env);
  const enabled = config.collective_enabled === 'true';
  const collectiveUrl = config.collective_url;
  const projectId = config.collective_project_id;
  const lastHeartbeat = Number(config.last_collective_heartbeat ?? '0');

  if (!enabled || !collectiveUrl || !projectId) return;

  const now = epochSeconds();
  if (!force && lastHeartbeat > 0 && now - lastHeartbeat < COLLECTIVE_HEARTBEAT_INTERVAL_SECONDS) {
    return;
  }

  const collectiveWorkerToken = await getCollectiveWorkerToken(env);
  if (!collectiveWorkerToken) return;

  const metadata = teamCollectiveMetadata(env);

  try {
    const response = await fetch(`${collectiveUrl.replace(/\/+$/, '')}/api/projects/${projectId}/heartbeat`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${collectiveWorkerToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(metadata),
    });
    if (!response.ok) {
      throw new Error(`Collective heartbeat failed: ${response.status}`);
    }

    const body = await response.json() as {
      capabilities?: string[];
      settings_overrides?: Record<string, unknown>;
      last_seen?: number;
    };

    await writeTeamConfig(env, {
      collective_capabilities_cache: JSON.stringify(body.capabilities ?? metadata.capabilities),
      collective_settings_cache: JSON.stringify(body.settings_overrides ?? parseCollectiveSettings(config)),
      last_collective_heartbeat: String(body.last_seen ?? now),
    });
  } catch {
    // Best-effort heartbeat. Status pages should reflect the last successful sync.
  }
}


/**
 * Build column names and placeholders for an INSERT OR REPLACE from a data object.
 * Always includes id and machine_id.
 */
function buildInsertParts(
  table: string,
  data: Record<string, unknown>,
  id: string,
  machineId: string,
): { sql: string; values: unknown[] } {
  const row: Record<string, unknown> = { id, machine_id: machineId, ...data, synced_at: epochSeconds() };

  // Remove fields that don't belong in D1 (local-only fields)
  delete row.embedded;

  const columns = Object.keys(row);
  const placeholders = columns.map(() => '?').join(', ');
  const quotedColumns = columns.map((c) => (c === 'user' ? `"user"` : c)).join(', ');

  return {
    sql: `INSERT OR REPLACE INTO ${table} (${quotedColumns}) VALUES (${placeholders})`,
    values: Object.values(row),
  };
}

async function getCollectiveWorkerToken(env: Env): Promise<string | null> {
  const token = await env.MYCO_SECRETS.get(COLLECTIVE_WORKER_TOKEN_KV);
  if (token) return token;

  const legacyToken = await env.MYCO_SECRETS.get(LEGACY_COLLECTIVE_API_KEY_KV);
  if (!legacyToken) return null;

  await env.MYCO_SECRETS.put(COLLECTIVE_WORKER_TOKEN_KV, legacyToken);
  return legacyToken;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleHealth(env: Env): Promise<Response> {
  const metadata = teamCollectiveMetadata(env);
  const [countResult, storedToken] = await Promise.all([
    env.MYCO_TEAM_DB.prepare('SELECT COUNT(*) as count FROM nodes').first<{ count: number }>(),
    env.MYCO_SECRETS.get(MCP_TOKEN_KEY),
  ]);

  const count = countResult?.count ?? 0;
  const mcpTokenHash = storedToken ? getMcpTokenHash(storedToken) : null;

  return jsonResponse({
    status: 'ok',
    nodes: count,
    node_count: count,
    sync_protocol_version: parseInt(env.SYNC_PROTOCOL_VERSION, 10),
    package_version: metadata.package_version,
    schema_version: metadata.schema_version,
    mcp_token_hash: mcpTokenHash,
  });
}

async function handleConnect(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as ConnectPayload;
  if (!body.machine_id) {
    return errorResponse('machine_id is required', 400);
  }

  const now = epochSeconds();

  await env.MYCO_TEAM_DB.prepare(
    `INSERT INTO nodes (machine_id, package_version, schema_version, sync_protocol_version, last_seen, registered_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (machine_id) DO UPDATE SET
       package_version = excluded.package_version,
       schema_version = excluded.schema_version,
       sync_protocol_version = excluded.sync_protocol_version,
       last_seen = excluded.last_seen`,
  ).bind(
    body.machine_id,
    body.package_version ?? null,
    body.schema_version ?? null,
    body.sync_protocol_version ?? null,
    now,
    now,
  ).run();

  // Return team config
  const config = await readTeamConfig(env);

  // MCP token is stored in KV (encrypted at rest), not in team_config
  const mcpToken = await ensureMcpToken(env.MYCO_SECRETS);

  return jsonResponse({
    status: 'connected',
    sync_protocol_version: parseInt(env.SYNC_PROTOCOL_VERSION, 10),
    config,
    mcp_token: mcpToken,
    mcp_endpoint: '/mcp',
  });
}

async function handleSync(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as SyncPayload;

  // Version check
  const serverVersion = parseInt(env.SYNC_PROTOCOL_VERSION, 10);
  if (body.sync_protocol_version !== serverVersion) {
    return errorResponse(
      `Protocol version mismatch: client=${body.sync_protocol_version}, server=${serverVersion}`,
      409,
    );
  }

  if (!Array.isArray(body.records) || body.records.length === 0) {
    return jsonResponse({ synced: 0, skipped: 0, errors: [] });
  }

  let synced = 0;
  let skipped = 0;
  const errors: Array<{ id: string; table: string; error: string }> = [];

  // Collect embedding tasks so they can be parallelized after DB writes
  const embeddingTasks: Array<() => Promise<void>> = [];

  for (const record of body.records) {
    try {
      if (!SYNCED_TABLES.includes(record.table)) {
        errors.push({ id: record.id, table: record.table, error: `Unknown table: ${record.table}` });
        continue;
      }

      if (record.operation === 'delete') {
        await handleDelete(env, record);
        synced++;
        continue;
      }

      // Check content_hash — skip if unchanged
      if (record.content_hash) {
        const existing = await env.MYCO_TEAM_DB.prepare(
          `SELECT content_hash FROM ${record.table} WHERE id = ? AND machine_id = ?`,
        )
          .bind(record.id, record.machine_id)
          .first<{ content_hash: string | null }>();

        if (existing?.content_hash === record.content_hash) {
          skipped++;
          continue;
        }
      }

      // INSERT OR REPLACE into D1
      const { sql, values } = buildInsertParts(record.table, record.data, record.id, record.machine_id);
      await env.MYCO_TEAM_DB.prepare(sql).bind(...values).run();

      // Queue embedding if the table has embeddable content
      const embeddableField = EMBEDDABLE_TABLES[record.table];
      if (embeddableField) {
        const textContent = record.data[embeddableField] as string | undefined;
        if (textContent) {
          const { table, id, machine_id } = record;
          if (table === 'spores' && record.data.status !== 'active') {
            embeddingTasks.push(() => deleteVector(env, table, id, machine_id));
          } else {
            embeddingTasks.push(() => embedAndUpsert(env, table, id, machine_id, textContent, buildVectorMetadata(table, record.data)));
          }
        }
      }

      synced++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ id: record.id, table: record.table, error: message });
    }
  }

  // Run all embedding tasks in parallel
  if (embeddingTasks.length > 0) {
    await Promise.allSettled(embeddingTasks.map((t) => t()));
  }

  // Update node last_seen
  await env.MYCO_TEAM_DB.prepare('UPDATE nodes SET last_seen = ? WHERE machine_id = ?')
    .bind(epochSeconds(), body.machine_id)
    .run();

  return jsonResponse({ synced, skipped, errors });
}

async function handleDelete(env: Env, record: SyncRecord): Promise<void> {
  await env.MYCO_TEAM_DB.prepare(`DELETE FROM ${record.table} WHERE id = ? AND machine_id = ?`)
    .bind(record.id, record.machine_id)
    .run();

  // Remove from Vectorize if embeddable
  if (record.table in EMBEDDABLE_TABLES) {
    await deleteVector(env, record.table, record.id, record.machine_id);
  }
}

async function embedAndUpsert(
  env: Env,
  table: string,
  id: string,
  machineId: string,
  text: string,
  extra?: Partial<TeamVectorMetadata>,
): Promise<void> {
  const vector = await embedText(env.AI, text);
  const vid = await vectorId(table, id, machineId);
  const legacyId = legacyVectorId(table, id, machineId);
  if (legacyId !== vid) {
    try {
      await env.MYCO_TEAM_VECTORS.deleteByIds([legacyId]);
    } catch {
      // Legacy vector may not exist — safe to ignore.
    }
  }
  await env.MYCO_TEAM_VECTORS.upsert([
    {
      id: vid,
      values: vector,
      metadata: { table, id, machine_id: machineId, ...extra },
    },
  ]);
}

function buildVectorMetadata(table: string, data: Record<string, unknown>): Partial<TeamVectorMetadata> {
  const metadata: Partial<TeamVectorMetadata> = {};

  const maybeString = (key: keyof TeamVectorMetadata, value: unknown) => {
    if (typeof value === 'string' && value.length > 0) metadata[key] = value as never;
  };
  const maybeNumber = (key: keyof TeamVectorMetadata, value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) metadata[key] = value as never;
  };

  switch (table) {
    case 'spores':
      maybeString('status', data.status);
      maybeString('observation_type', data.observation_type);
      maybeString('session_id', data.session_id);
      maybeNumber('created_at', data.created_at);
      break;
    case 'sessions':
      maybeString('status', data.status);
      maybeString('project_root', data.project_root);
      maybeNumber('created_at', data.created_at);
      break;
    case 'plans':
      maybeString('status', data.status);
      maybeString('session_id', data.session_id);
      maybeString('source_path', data.source_path);
      maybeNumber('created_at', data.created_at);
      break;
    case 'artifacts':
      maybeString('source_path', data.source_path);
      maybeNumber('created_at', data.created_at);
      break;
    case 'skill_records':
      maybeString('status', data.status);
      maybeString('name', data.name);
      maybeNumber('created_at', data.created_at);
      break;
  }

  return metadata;
}

function parseCsvParam(value: string | null): string[] | undefined {
  if (!value) return undefined;
  const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
  return parts.length > 0 ? parts : undefined;
}

function parseNumberParam(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function encodeReindexCursor(cursor: VectorReindexCursor | null): string | null {
  return cursor ? JSON.stringify(cursor) : null;
}

function decodeReindexCursor(value: unknown): VectorReindexCursor | null {
  if (!value || typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value) as Partial<VectorReindexCursor>;
    if (
      typeof parsed.created_at === 'number' &&
      typeof parsed.id === 'string' &&
      typeof parsed.machine_id === 'string'
    ) {
      return {
        created_at: parsed.created_at,
        id: parsed.id,
        machine_id: parsed.machine_id,
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function listReindexRows(
  env: Env,
  table: keyof typeof EMBEDDABLE_TABLES,
  limit: number,
  cursor: VectorReindexCursor | null,
): Promise<Array<{ id: string; machine_id: string; text: string; data: Record<string, unknown> }>> {
  const textField = EMBEDDABLE_TABLES[table];
  const params: unknown[] = [];
  let whereClause = '';
  if (cursor) {
    whereClause = `
      WHERE (
        created_at > ?
        OR (created_at = ? AND id > ?)
        OR (created_at = ? AND id = ? AND machine_id > ?)
      )`;
    params.push(cursor.created_at, cursor.created_at, cursor.id, cursor.created_at, cursor.id, cursor.machine_id);
  }

  const sql = `
    SELECT *
    FROM ${table}
    ${whereClause}
    ORDER BY created_at ASC, id ASC, machine_id ASC
    LIMIT ?
  `;
  params.push(limit);
  const { results } = await env.MYCO_TEAM_DB.prepare(sql).bind(...params).all<Record<string, unknown>>();

  return (results ?? [])
    .map((row) => {
      const text = row[textField];
      if (typeof row.id !== 'string' || typeof row.machine_id !== 'string' || typeof text !== 'string' || text.length === 0) {
        return null;
      }
      return {
        id: row.id,
        machine_id: row.machine_id,
        text,
        data: row,
      };
    })
    .filter((row): row is { id: string; machine_id: string; text: string; data: Record<string, unknown> } => row !== null);
}

async function handleVectorReindex(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as {
    table?: keyof typeof EMBEDDABLE_TABLES;
    limit?: number;
    cursor?: string | null;
  };
  const table = body.table;
  if (!table || !(table in EMBEDDABLE_TABLES)) {
    return errorResponse('table must be one of spores, sessions, plans, artifacts, skill_records', 400);
  }

  const limit = Math.min(Math.max(body.limit ?? VECTOR_REINDEX_DEFAULT_BATCH, 1), VECTOR_REINDEX_MAX_BATCH);
  const cursor = decodeReindexCursor(body.cursor ?? null);
  const rows = await listReindexRows(env, table, limit, cursor);
  const startedAt = epochSeconds();

  await writeTeamConfig(env, {
    vector_reindex_status: 'running',
    vector_reindex_last_table: table,
    vector_reindex_last_run_at: String(startedAt),
    vector_reindex_last_error: '',
  });

  try {
    let reindexed = 0;
    let deleted = 0;
    for (const row of rows) {
      if (table === 'spores' && row.data.status !== 'active') {
        await deleteVector(env, table, row.id, row.machine_id);
        deleted += 1;
        continue;
      }
      await embedAndUpsert(env, table, row.id, row.machine_id, row.text, buildVectorMetadata(table, row.data));
      reindexed += 1;
    }

    const next = rows.length === limit
      ? rows[rows.length - 1]
      : null;

    await writeTeamConfig(env, {
      vector_reindex_status: next ? 'running' : 'ok',
      vector_reindex_last_table: table,
      vector_reindex_last_run_at: String(epochSeconds()),
      vector_reindex_last_processed: String(rows.length),
      vector_reindex_last_reindexed: String(reindexed),
      vector_reindex_last_deleted: String(deleted),
      vector_reindex_last_error: '',
    });

    return jsonResponse({
      table,
      processed: rows.length,
      reindexed,
      deleted,
      next_cursor: next
        ? encodeReindexCursor({
            created_at: Number(next.data.created_at ?? 0),
            id: next.id,
            machine_id: next.machine_id,
          })
        : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeTeamConfig(env, {
      vector_reindex_status: 'error',
      vector_reindex_last_table: table,
      vector_reindex_last_run_at: String(epochSeconds()),
      vector_reindex_last_error: message,
    });
    throw error;
  }
}

async function deleteVector(env: Env, table: string, id: string, machineId: string): Promise<void> {
  const vid = await vectorId(table, id, machineId);
  const legacyId = legacyVectorId(table, id, machineId);
  try {
    const ids = legacyId === vid ? [vid] : [vid, legacyId];
    await env.MYCO_TEAM_VECTORS.deleteByIds(ids);
  } catch {
    // Vector may not exist — safe to ignore
  }
}

async function handleSearch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const query = url.searchParams.get('q');
  if (!query) {
    return errorResponse('Missing query parameter "q"', 400);
  }

  const requestedLimit = url.searchParams.get('limit') ?? url.searchParams.get('top_k') ?? String(DEFAULT_TOP_K);
  const parsedLimit = parseInt(requestedLimit, 10);
  const topK = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), MAX_TOP_K) : DEFAULT_TOP_K;

  const results = await searchKnowledge(env.MYCO_TEAM_DB, env.MYCO_TEAM_VECTORS, env.AI, {
    query,
    limit: topK,
    types: parseCsvParam(url.searchParams.get('types')) ?? parseCsvParam(url.searchParams.get('tables')),
    status: url.searchParams.get('status') ?? undefined,
    observation_type: url.searchParams.get('observation_type') ?? undefined,
    since: parseNumberParam(url.searchParams.get('since')),
    until: parseNumberParam(url.searchParams.get('until')),
    session_id: url.searchParams.get('session_id') ?? undefined,
    source_path: url.searchParams.get('source_path') ?? undefined,
    name: url.searchParams.get('name') ?? undefined,
  });

  return jsonResponse({ results: results.map(toCloudSearchResult) });
}

async function handleGetRecord(type: string, id: string, request: Request, env: Env): Promise<Response> {
  if (!isAllowedRecordType(type)) {
    return errorResponse(`Unknown record type: ${type}`, 400);
  }
  const machineId = new URL(request.url).searchParams.get('machine_id') ?? undefined;
  const record = await fetchRecord(env, type, id, machineId);
  if (!record) {
    return jsonResponse({ error: 'not_found' }, 404);
  }
  return jsonResponse({ record });
}

async function handleGetConfig(env: Env): Promise<Response> {
  const config = await readTeamConfig(env);

  return jsonResponse({
    config,
    sync_protocol_version: parseInt(env.SYNC_PROTOCOL_VERSION, 10),
  });
}

async function handlePutConfig(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as Record<string, string>;

  const entries = Object.entries(body);
  if (entries.length === 0) {
    return errorResponse('Empty config body', 400);
  }

  const statements = entries.map(([key, value]) =>
    env.MYCO_TEAM_DB.prepare('INSERT OR REPLACE INTO team_config (key, value) VALUES (?, ?)').bind(key, value),
  );

  await env.MYCO_TEAM_DB.batch(statements);

  return jsonResponse({ updated: entries.length });
}

async function handleCollectiveConfigure(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as {
    collective_url?: string;
    collective_api_key?: string;
    project_id?: string;
  };
  if (!body.collective_url || !body.collective_api_key) {
    return errorResponse('collective_url and collective_api_key are required', 400);
  }

  await env.MYCO_SECRETS.put(COLLECTIVE_WORKER_TOKEN_KV, body.collective_api_key);
  await env.MYCO_SECRETS.put(LEGACY_COLLECTIVE_API_KEY_KV, body.collective_api_key);
  const metadata = teamCollectiveMetadata(env);
  await writeTeamConfig(env, {
    collective_enabled: 'true',
    collective_url: body.collective_url,
    collective_project_id: body.project_id ?? '',
    collective_capabilities_cache: JSON.stringify(metadata.capabilities),
  });

  const settings = await syncCollectiveSettings(env, true);
  await sendCollectiveHeartbeat(env, true);

  return jsonResponse({
    connected: true,
    collective_url: body.collective_url,
    project_id: body.project_id ?? null,
    settings,
    capabilities: metadata.capabilities,
    package_version: metadata.package_version,
    schema_version: metadata.schema_version,
  });
}

async function handleCollectiveSettings(env: Env): Promise<Response> {
  const settings = await syncCollectiveSettings(env);
  const config = await readTeamConfig(env);
  return jsonResponse({
    collective_enabled: config.collective_enabled === 'true',
    settings,
    last_sync: Number(config.last_collective_settings_sync ?? '0') || null,
  });
}

async function handleCollectiveStatus(env: Env): Promise<Response> {
  const config = await readTeamConfig(env);
  const lastHeartbeat = Number(config.last_collective_heartbeat ?? '0') || null;
  const now = epochSeconds();
  return jsonResponse({
    connected: config.collective_enabled === 'true'
      && lastHeartbeat !== null
      && now - lastHeartbeat <= COLLECTIVE_STALE_AFTER_SECONDS,
    collective_url: config.collective_url ?? null,
    project_id: config.collective_project_id ?? null,
    last_settings_sync: Number(config.last_collective_settings_sync ?? '0') || null,
    last_heartbeat: lastHeartbeat,
    capabilities: parseCapabilities(config),
    settings: parseCollectiveSettings(config),
  });
}

async function handleCollectiveQuery(request: Request, env: Env): Promise<Response> {
  const config = await readTeamConfig(env);
  if (config.collective_enabled !== 'true' || !config.collective_url) {
    return errorResponse('Collective is not configured for this team worker', 400);
  }

  const collectiveWorkerToken = await getCollectiveWorkerToken(env);
  if (!collectiveWorkerToken) {
    return errorResponse('Collective worker token is not configured', 500);
  }

  const body = await request.json() as { tool?: string; args?: Record<string, unknown> };
  if (!body.tool || !TEAM_COLLECTIVE_QUERY_TOOLS.has(body.tool)) {
    return errorResponse('Unsupported collective tool for team proxy', 400);
  }
  const response = await fetch(`${config.collective_url.replace(/\/+$/, '')}/api/worker/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${collectiveWorkerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  return new Response(responseText, {
    status: response.status,
    headers: JSON_HEADERS,
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Health — no auth required
    if (method === 'GET' && path === '/health') {
      try {
        if (!schemaInitialized) {
          await initD1Schema(env.MYCO_TEAM_DB);
          schemaInitialized = true;
        }
        return await handleHealth(env);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errorResponse(`Health check failed: ${message}`, 500);
      }
    }

    // MCP routes — separate auth from sync routes
    if (path.startsWith('/mcp')) {
      if (!schemaInitialized) {
        await initD1Schema(env.MYCO_TEAM_DB);
        schemaInitialized = true;
      }

      // Token rotation — authenticated with team API key
      if (path === '/mcp/rotate' && method === 'POST') {
        const rotateAuthError = validateAuth(request, env);
        if (rotateAuthError) return rotateAuthError;
        const newToken = await rotateMcpToken(env.MYCO_SECRETS);
        return jsonResponse({ token: newToken });
      }

      // MCP protocol — authenticated with MCP access token
      const mcpAuthError = await authenticateMcpRequest(request, env.MYCO_SECRETS);
      if (mcpAuthError) return mcpAuthError;

      const server = createMcpServerInstance(env);
      const handler = createMcpHandler(server);
      return handler(request, env, ctx);
    }

    // All other routes require auth
    const authError = validateAuth(request, env);
    if (authError) return authError;

    if (!schemaInitialized) {
      await initD1Schema(env.MYCO_TEAM_DB);
      schemaInitialized = true;
    }

    try {
      if (method === 'POST' && path === '/connect') {
        return await handleConnect(request, env);
      }
      if (method === 'POST' && path === '/sync') {
        return await handleSync(request, env);
      }
      if (method === 'GET' && path === '/search') {
        return await handleSearch(request, env);
      }
      // Single-record lookup used by the daemon's entity get fallback (mirrors
      // the fan-out pattern already in place for /search).
      if (method === 'GET' && path.startsWith('/records/')) {
        const segments = path.split('/').filter(Boolean);
        // /records/:type/:id
        if (segments.length === 3) {
          return await handleGetRecord(segments[1], decodeURIComponent(segments[2]), request, env);
        }
        return errorResponse('Not found', 404);
      }
      if (method === 'POST' && path === '/vectors/reindex') {
        return await handleVectorReindex(request, env);
      }
      if (method === 'GET' && path === '/config') {
        return await handleGetConfig(env);
      }
      if (method === 'PUT' && path === '/config') {
        return await handlePutConfig(request, env);
      }
      if (method === 'POST' && path === '/collective/configure') {
        return await handleCollectiveConfigure(request, env);
      }
      if (method === 'GET' && path === '/collective/settings') {
        return await handleCollectiveSettings(env);
      }
      if (method === 'GET' && path === '/collective/status') {
        return await handleCollectiveStatus(env);
      }
      if (method === 'POST' && path === '/collective/query') {
        return await handleCollectiveQuery(request, env);
      }

      return errorResponse('Not found', 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(message, 500);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    if (!schemaInitialized) {
      await initD1Schema(env.MYCO_TEAM_DB);
      schemaInitialized = true;
    }
    await syncCollectiveSettings(env);
    await sendCollectiveHeartbeat(env);
  },
} satisfies ExportedHandler<Env>;
