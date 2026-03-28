/**
 * Myco Team Sync — Cloudflare Worker
 *
 * Provides team-wide storage and vector search backed by D1 + Vectorize + Workers AI.
 * Each node (machine) pushes its outbox records here; the worker deduplicates by
 * content_hash and maintains a shared Vectorize index for semantic search.
 */

import { initD1Schema } from './schema';
import { validateAuth } from './auth';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Env {
  MYCO_TEAM_DB: D1Database;
  MYCO_TEAM_VECTORS: VectorizeIndex;
  AI: Ai;
  MYCO_TEAM_API_KEY: string;
  SYNC_PROTOCOL_VERSION: string;
}

/** Tables that support embedding in Vectorize. */
const EMBEDDABLE_TABLES: Record<string, string> = {
  spores: 'content',
  sessions: 'summary',
  plans: 'content',
  artifacts: 'content',
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Whether initD1Schema has already run for this Worker instance. */
let schemaInitialized = false;

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 50;

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
function vectorId(table: string, id: string, machineId: string): string {
  return `${table}:${id}:${machineId}`;
}

/**
 * Embed text via Workers AI (bge-m3) and return the vector.
 */
async function embedText(ai: Ai, text: string): Promise<number[]> {
  const result = await ai.run('@cf/baai/bge-m3', { text: [text] });
  return result.data[0];
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

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleHealth(env: Env): Promise<Response> {
  const result = await env.MYCO_TEAM_DB.prepare('SELECT COUNT(*) as count FROM nodes').first<{
    count: number;
  }>();
  return jsonResponse({ status: 'ok', nodes: result?.count ?? 0 });
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
  const configRows = await env.MYCO_TEAM_DB.prepare('SELECT key, value FROM team_config').all<{
    key: string;
    value: string;
  }>();
  const config: Record<string, string> = {};
  for (const row of configRows.results) {
    config[row.key] = row.value;
  }

  return jsonResponse({
    status: 'connected',
    sync_protocol_version: parseInt(env.SYNC_PROTOCOL_VERSION, 10),
    config,
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
          if (table === 'spores' && record.data.status === 'superseded') {
            embeddingTasks.push(() => deleteVector(env, table, id, machine_id));
          } else {
            embeddingTasks.push(() => embedAndUpsert(env, table, id, machine_id, textContent));
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
): Promise<void> {
  const vector = await embedText(env.AI, text);
  const vid = vectorId(table, id, machineId);
  await env.MYCO_TEAM_VECTORS.upsert([
    {
      id: vid,
      values: vector,
      metadata: { table, id, machine_id: machineId },
    },
  ]);
}

async function deleteVector(env: Env, table: string, id: string, machineId: string): Promise<void> {
  const vid = vectorId(table, id, machineId);
  try {
    await env.MYCO_TEAM_VECTORS.deleteByIds([vid]);
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

  const topK = Math.min(parseInt(url.searchParams.get('top_k') ?? String(DEFAULT_TOP_K), 10), MAX_TOP_K);

  // Embed query
  const queryVector = await embedText(env.AI, query);

  // Search Vectorize
  const matches = await env.MYCO_TEAM_VECTORS.query(queryVector, {
    topK,
    returnMetadata: 'all',
  });

  // Group matches by table for batch hydration
  const byTable = new Map<string, { id: string; machine_id: string; score: number }[]>();
  for (const match of matches.matches) {
    const meta = match.metadata as { table: string; id: string; machine_id: string } | undefined;
    if (!meta) continue;
    let group = byTable.get(meta.table);
    if (!group) {
      group = [];
      byTable.set(meta.table, group);
    }
    group.push({ id: meta.id, machine_id: meta.machine_id, score: match.score });
  }

  // Batch-query each table and build results
  const results: SearchResult[] = [];
  for (const [table, items] of byTable) {
    const placeholders = items.map(() => '(?, ?)').join(', ');
    const binds = items.flatMap((i) => [i.id, i.machine_id]);
    const { results: rows } = await env.MYCO_TEAM_DB.prepare(
      `SELECT * FROM ${table} WHERE (id, machine_id) IN (VALUES ${placeholders})`,
    ).bind(...binds).all();

    const rowMap = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      rowMap.set(`${r.id}:${r.machine_id}`, r);
    }

    for (const item of items) {
      const row = rowMap.get(`${item.id}:${item.machine_id}`);
      if (row) {
        results.push({
          table,
          id: item.id,
          machine_id: item.machine_id,
          score: item.score,
          data: row,
        });
      }
    }
  }

  // Sort by score to preserve ranking after batch hydration
  results.sort((a, b) => b.score - a.score);

  return jsonResponse({ results });
}

async function handleGetConfig(env: Env): Promise<Response> {
  const rows = await env.MYCO_TEAM_DB.prepare('SELECT key, value FROM team_config').all<{
    key: string;
    value: string;
  }>();

  const config: Record<string, string> = {};
  for (const row of rows.results) {
    config[row.key] = row.value;
  }

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

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
      if (method === 'GET' && path === '/config') {
        return await handleGetConfig(env);
      }
      if (method === 'PUT' && path === '/config') {
        return await handlePutConfig(request, env);
      }

      return errorResponse('Not found', 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(message, 500);
    }
  },
} satisfies ExportedHandler<Env>;
