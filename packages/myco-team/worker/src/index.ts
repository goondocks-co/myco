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
import { searchKnowledge, embedText, MAX_EMBEDDING_TEXT_CHARS, type TeamVectorMetadata } from './search-helpers';
import { fetchRecord, isAllowedRecordType } from './records';
import {
  clearCfApiCredentials,
  discardDlqMessages,
  fetchQueueStats,
  pullDlqMessages,
  readCfApiCredentials,
  retryDlqMessages,
  writeCfApiCredentials,
} from './cf-api';

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
  /**
   * Producer binding for the project's sync queue. Bound at deploy time via
   * the wrangler.toml [[queues.producers]] block; queue name is project-scoped
   * (`myco-team-<hash>-sync`) and provisioned by `myco-team init`.
   */
  SYNC_QUEUE: Queue<SyncRecord>;
  /** Name of the project's main sync queue — bound from wrangler.toml [vars]. */
  SYNC_QUEUE_NAME: string;
  /** Name of the project's dead-letter queue — bound from wrangler.toml [vars]. */
  SYNC_DLQ_NAME: string;
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

const SYNCED_TABLES_SET = new Set<string>(SYNCED_TABLES);

const GROVE_PROJECT_ID_PATTERN = /^proj_[0-9a-f]{32}$/;

/**
 * Validate that a value is a Grove-era project id (`proj_<32 hex chars>`).
 * Mirrors the daemon-side `assertGroveProjectId` gate so contamination
 * (NULL, empty, path-string, wrong prefix) can't reach D1 — one of the
 * defenses-in-depth introduced after the path-string regression.
 */
function isGroveProjectId(value: unknown): value is string {
  return typeof value === 'string' && GROVE_PROJECT_ID_PATTERN.test(value);
}
const QUEUE_SEND_BATCH_SIZE = 100;
const QUEUE_SEND_BATCH_MAX_BYTES = 192 * 1024;

type SyncedTable = (typeof SYNCED_TABLES)[number];

interface SyncRecord {
  table: SyncedTable;
  operation: 'upsert' | 'delete' | 'embed';
  id: string;
  machine_id: string;
  content_hash?: string | null;
  /**
   * Row payload. Required for `upsert`. For `delete` and `embed`, only
   * `id`/`machine_id` matter — `embed` re-reads the row from D1 so
   * messages stay tiny and never carry duplicate row state.
   */
  data: Record<string, unknown>;
}

function estimateQueueMessageBytes(record: SyncRecord): number {
  return new TextEncoder().encode(JSON.stringify({ body: record })).byteLength;
}

async function sendQueueRecords(queue: Queue<SyncRecord>, records: SyncRecord[]): Promise<void> {
  let chunk: SyncRecord[] = [];
  let chunkBytes = 0;

  const flush = async () => {
    if (chunk.length === 0) return;
    await queue.sendBatch(chunk.map((record) => ({ body: record })));
    chunk = [];
    chunkBytes = 0;
  };

  for (const record of records) {
    const size = estimateQueueMessageBytes(record);
    if (chunk.length > 0 && (chunk.length >= QUEUE_SEND_BATCH_SIZE || chunkBytes + size > QUEUE_SEND_BATCH_MAX_BYTES)) {
      await flush();
    }
    chunk.push(record);
    chunkBytes += size;
  }

  await flush();
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

/**
 * One row to embed-and-upsert. Collected per queue batch so we can fire
 * a single batched `ai.run` call (bge-m3 accepts an array of texts) and
 * a single `Vectorize.upsert` instead of N parallel calls — Workers AI
 * serializes per-isolate, so 100 parallel `ai.run` calls take ~100s
 * instead of the ~1-2s a single batched call takes.
 */
interface EmbedJob {
  table: string;
  id: string;
  machine_id: string;
  text: string;
  metadata: Partial<TeamVectorMetadata>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Whether initD1Schema has already run for this Worker instance. */
let schemaInitialized = false;

/**
 * Module-scope memo of last `nodes.last_seen` write per machine. Lets warm
 * Worker isolates skip the D1 UPDATE on every flush request; cold starts
 * write once and remember. The interval is intentionally identical to the
 * collective heartbeat cadence so observed last_seen lag is at most one
 * heartbeat window.
 */
const lastSeenWritten = new Map<string, number>();
const NODE_LAST_SEEN_UPDATE_INTERVAL_SECONDS = 5 * 60;

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

/**
 * Producer endpoint — receives a SyncPayload and fans the records out into
 * the project's sync queue. The queue consumer (defined in this Worker's
 * `queue()` handler) is what actually writes to D1 and Vectorize. This
 * decoupling lets Cloudflare handle batching, retries, and dead-lettering;
 * the daemon's local outbox shrinks to a thin offline buffer.
 */
async function handleEnqueue(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as SyncPayload;

  const serverVersion = parseInt(env.SYNC_PROTOCOL_VERSION, 10);
  if (body.sync_protocol_version !== serverVersion) {
    return errorResponse(
      `Protocol version mismatch: client=${body.sync_protocol_version}, server=${serverVersion}`,
      409,
    );
  }

  if (!Array.isArray(body.records) || body.records.length === 0) {
    return jsonResponse({ accepted: 0 });
  }

  // Validate table names up-front so the daemon can't poison the queue with
  // payloads the consumer would always reject. Unknown tables are reported in
  // the response so the daemon surfaces them during its flush.
  //
  // Also reject records whose `data.project_id` is not a Grove-era id
  // (`proj_<32 hex chars>`). Defense-in-depth against pre-Grove writers
  // that quietly enqueued NULL or path-string project ids — those
  // landed in D1 unchallenged before the brand was added locally.
  // Mirroring the local gate here means a future runtime regression on
  // either side can't recontaminate D1.
  const acceptedRecords: SyncRecord[] = [];
  const rejected: Array<{ id: string; table: string; error: string }> = [];
  for (const record of body.records) {
    if (!SYNCED_TABLES_SET.has(record.table)) {
      rejected.push({ id: record.id, table: record.table, error: `Unknown table: ${record.table}` });
      continue;
    }
    const projectId = (record.data as Record<string, unknown> | undefined)?.project_id;
    if (!isGroveProjectId(projectId)) {
      rejected.push({
        id: record.id,
        table: record.table,
        error: `Invalid project_id: expected proj_<32 hex chars>, got ${JSON.stringify(projectId)}`,
      });
      continue;
    }
    acceptedRecords.push(record);
  }

  if (acceptedRecords.length > 0) {
    await sendQueueRecords(env.SYNC_QUEUE, acceptedRecords);
  }

  await touchNodeLastSeen(env, body.machine_id);

  return jsonResponse({ accepted: acceptedRecords.length, rejected });
}

/**
 * Conditionally bump nodes.last_seen for the given machine. Worker-side
 * memo skips the D1 UPDATE when the last write for this machine landed
 * inside the heartbeat window — at PowerManager's 5min cadence this turns
 * 12 D1 writes/hr/machine into ~1.
 */
async function touchNodeLastSeen(env: Env, machineId: string): Promise<void> {
  const now = epochSeconds();
  const last = lastSeenWritten.get(machineId) ?? 0;
  if (now - last < NODE_LAST_SEEN_UPDATE_INTERVAL_SECONDS) return;
  await env.MYCO_TEAM_DB.prepare('UPDATE nodes SET last_seen = ? WHERE machine_id = ?')
    .bind(now, machineId)
    .run();
  lastSeenWritten.set(machineId, now);
}

/**
 * Apply one sync record to D1. Returns whether the write was skipped (no-op
 * because the content_hash matched) and an optional embedding task that the
 * caller should run after committing the D1 batch.
 *
 * Throws on D1 error so the queue runtime treats the message as failed and
 * applies its retry policy. The DLQ catches messages that keep failing past
 * the configured max_retries.
 */
async function writeRecordToD1(
  env: Env,
  record: SyncRecord,
): Promise<{ skipped: boolean; embedTask?: () => Promise<void>; embedJob?: EmbedJob }> {
  if (record.operation === 'delete') {
    await handleDelete(env, record);
    return { skipped: false };
  }

  if (record.content_hash) {
    const existing = await env.MYCO_TEAM_DB.prepare(
      `SELECT content_hash FROM ${record.table} WHERE id = ? AND machine_id = ?`,
    )
      .bind(record.id, record.machine_id)
      .first<{ content_hash: string | null }>();
    if (existing?.content_hash === record.content_hash) {
      return { skipped: true };
    }
  }

  const { sql, values } = buildInsertParts(record.table, record.data, record.id, record.machine_id);
  await env.MYCO_TEAM_DB.prepare(sql).bind(...values).run();

  const embeddableField = EMBEDDABLE_TABLES[record.table];
  if (!embeddableField) return { skipped: false };

  const textContent = record.data[embeddableField] as string | undefined;
  if (!textContent) return { skipped: false };

  const { table, id, machine_id } = record;
  if (table === 'spores' && record.data.status !== 'active') {
    return { skipped: false, embedTask: () => deleteVector(env, table, id, machine_id) };
  }
  return {
    skipped: false,
    embedJob: {
      table,
      id,
      machine_id,
      text: textContent,
      metadata: buildVectorMetadata(table, record.data),
    },
  };
}

/**
 * Sync-queue consumer. Coalesces D1 work per-table:
 *   1. Group messages by (table, operation).
 *   2. For each upsert group, one batched SELECT for content_hash filtering,
 *      then one db.batch() of INSERT OR REPLACE for survivors.
 *   3. For each delete group, one db.batch() of DELETE statements.
 *
 * Optimistic batch + per-record fallback preserves per-message ack/retry:
 * a successful batch acks all messages; a failed batch falls back to
 * sequential `writeRecordToD1` so individual offenders can retry while
 * their batch-mates progress. CF Queues handles backoff + DLQ once
 * `max_retries` is hit.
 *
 * For a typical 100-message batch hitting 2–4 distinct tables, this cuts
 * D1 round-trips from ~200 (1 SELECT + 1 INSERT per message) to ~2N
 * (one SELECT and one INSERT batch per table).
 */
async function handleSyncBatch(batch: MessageBatch<SyncRecord>, env: Env): Promise<void> {
  if (!schemaInitialized) {
    await initD1Schema(env.MYCO_TEAM_DB);
    schemaInitialized = true;
  }

  const deleteVectorTasks: Array<() => Promise<void>> = [];
  const embedJobs: EmbedJob[] = [];
  const groups = new Map<string, Array<Message<SyncRecord>>>();
  for (const message of batch.messages) {
    const key = `${message.body.table}\t${message.body.operation}`;
    const list = groups.get(key);
    if (list) list.push(message);
    else groups.set(key, [message]);
  }

  for (const [key, messages] of groups) {
    const [table, operation] = key.split('\t');
    if (operation === 'delete') {
      await coalescedDeleteBatch(env, table, messages);
    } else if (operation === 'embed') {
      await coalescedEmbedBatch(env, table, messages, deleteVectorTasks, embedJobs);
    } else {
      await coalescedUpsertBatch(env, table, messages, deleteVectorTasks, embedJobs);
    }
  }

  // Vectorize is a best-effort companion index — failures don't fail
  // the batch (rows are recoverable via /vectors/reindex). Vector
  // deletes (retired spores) run as parallel deleteByIds; embed jobs
  // are folded into a single batched `ai.run` + `Vectorize.upsert`
  // call so we don't pay per-isolate AI serialization 100 times per
  // batch. All errors get logged so silent embed-side outages
  // (Workers AI errors, missing AI binding, Vectorize upsert
  // failures) surface in `wrangler tail` instead of vanishing.
  if (deleteVectorTasks.length > 0) {
    const results = await Promise.allSettled(deleteVectorTasks.map((task) => task()));
    let failed = 0;
    for (const r of results) {
      if (r.status === 'rejected') {
        failed++;
        console.error('team-sync.vector-delete-failed', {
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }
    if (failed > 0) console.error(`team-sync.vector-delete-summary ${failed}/${results.length} failed`);
  }
  if (embedJobs.length > 0) {
    await runBatchEmbed(env, embedJobs);
  }
}

/**
 * bge-m3 has a 60,000-token context window per request. Tail-observed
 * tokenization density on this dataset hit 0.84 chars/token in the
 * worst case (a 32-text chunk averaging 1,875 chars/text produced
 * 71,680 tokens). Cap both combined characters AND count per chunk —
 * char cap handles long texts, count cap handles dense short ones.
 *
 * The combined cap targets ~30K tokens worst case (60K-char budget at
 * 0.5 chars/token absolute floor would still fit), which leaves
 * substantial headroom under the 60K hard limit.
 */
const EMBED_BATCH_CHAR_BUDGET = 25_000;
const EMBED_BATCH_MAX_COUNT = 10;

/**
 * Group jobs into chunks whose combined (truncated) text size fits
 * the bge-m3 context window. Each chunk becomes one `ai.run` call.
 */
function chunkEmbedJobs(jobs: EmbedJob[]): EmbedJob[][] {
  const chunks: EmbedJob[][] = [];
  let current: EmbedJob[] = [];
  let chars = 0;
  for (const job of jobs) {
    const len = Math.min(job.text.length, MAX_EMBEDDING_TEXT_CHARS);
    const wouldExceedChars = chars + len > EMBED_BATCH_CHAR_BUDGET;
    const wouldExceedCount = current.length >= EMBED_BATCH_MAX_COUNT;
    if (current.length > 0 && (wouldExceedChars || wouldExceedCount)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(job);
    chars += len;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Embed every job by folding them into the largest bge-m3 batches that
 * fit the model's 60K-token context window, then upserting all
 * resulting vectors in one `Vectorize.upsert` per chunk. Best-effort
 * — failures log but don't propagate, since source rows are still in
 * D1 and recoverable.
 *
 * Workers AI serializes parallel `ai.run` calls per isolate, so this
 * batched form is dramatically faster than the previous N-parallel
 * approach for a full CF queue batch (~10× speedup typical).
 */
async function runBatchEmbed(env: Env, jobs: EmbedJob[]): Promise<void> {
  for (const chunk of chunkEmbedJobs(jobs)) {
    await runOneEmbedChunk(env, chunk);
  }
}

async function runOneEmbedChunk(env: Env, jobs: EmbedJob[]): Promise<void> {
  const texts = jobs.map((j) =>
    j.text.length > MAX_EMBEDDING_TEXT_CHARS
      ? `${j.text.slice(0, MAX_EMBEDDING_TEXT_CHARS)}\n\n[truncated for embedding]`
      : j.text,
  );

  let aiResult: { data: number[][] };
  try {
    aiResult = await env.AI.run('@cf/baai/bge-m3', { text: texts }) as { data: number[][] };
  } catch (err) {
    console.error('team-sync.embed-batch-failed', {
      count: jobs.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (!Array.isArray(aiResult.data) || aiResult.data.length !== jobs.length) {
    console.error('team-sync.embed-batch-shape-mismatch', {
      expected: jobs.length,
      got: Array.isArray(aiResult.data) ? aiResult.data.length : null,
    });
    return;
  }

  const vids = await Promise.all(jobs.map((j) => vectorId(j.table, j.id, j.machine_id)));
  const legacyToDelete: string[] = [];
  for (let i = 0; i < jobs.length; i++) {
    const legacy = legacyVectorId(jobs[i].table, jobs[i].id, jobs[i].machine_id);
    if (legacy !== vids[i]) legacyToDelete.push(legacy);
  }
  if (legacyToDelete.length > 0) {
    try {
      await env.MYCO_TEAM_VECTORS.deleteByIds(legacyToDelete);
    } catch {
      // Legacy vectors may not exist — safe to ignore.
    }
  }

  const entries = jobs.map((job, i) => ({
    id: vids[i],
    values: aiResult.data[i],
    metadata: { table: job.table, id: job.id, machine_id: job.machine_id, ...job.metadata },
  }));
  try {
    await env.MYCO_TEAM_VECTORS.upsert(entries);
  } catch (err) {
    console.error('team-sync.upsert-batch-failed', {
      count: entries.length,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Coalesced upsert path: one SELECT + one db.batch INSERT for the survivors.
 * Falls back to per-record `writeRecordToD1` on batch failure so a single
 * poison message doesn't trap its batch-mates.
 */
async function coalescedUpsertBatch(
  env: Env,
  table: string,
  messages: Array<Message<SyncRecord>>,
  deleteVectorTasks: Array<() => Promise<void>>,
  embedJobs: EmbedJob[],
): Promise<void> {
  // Phase 1: batch SELECT existing content_hash for the (id, machine_id)
  // tuples we're about to write. Records without content_hash skip the
  // filter and write unconditionally. D1 caps a prepared statement at
  // 100 bound parameters, so chunk into 50-message slices (2 binds
  // each) — a full CF queue batch of 100 messages would otherwise
  // blow the limit and silently disable dedup for the whole group.
  const filterCandidates = messages.filter((m) => Boolean(m.body.content_hash));
  const existingHashes = new Map<string, string | null>();
  if (filterCandidates.length > 0) {
    const D1_BIND_LIMIT_PAIRS = 50;
    try {
      for (let offset = 0; offset < filterCandidates.length; offset += D1_BIND_LIMIT_PAIRS) {
        const slice = filterCandidates.slice(offset, offset + D1_BIND_LIMIT_PAIRS);
        const tuples = slice.map(() => '(?, ?)').join(', ');
        const binds = slice.flatMap((m) => [m.body.id, m.body.machine_id]);
        const result = await env.MYCO_TEAM_DB.prepare(
          `SELECT id, machine_id, content_hash FROM ${table} WHERE (id, machine_id) IN (${tuples})`,
        ).bind(...binds).all<{ id: string; machine_id: string; content_hash: string | null }>();
        for (const row of result.results ?? []) {
          existingHashes.set(`${row.id}\t${row.machine_id}`, row.content_hash);
        }
      }
    } catch (err) {
      // SELECT failure is unusual — fall through; the survivors path will
      // attempt the inserts and surface specific errors per-message.
      console.error(`team-sync.queue.select_failed table=${table}: ${err instanceof Error ? err.message : err}`);
    }
  }

  const survivors: Array<Message<SyncRecord>> = [];
  for (const message of messages) {
    const hash = message.body.content_hash;
    if (hash && existingHashes.get(`${message.body.id}\t${message.body.machine_id}`) === hash) {
      message.ack();
      continue;
    }
    survivors.push(message);
  }
  if (survivors.length === 0) return;

  // Phase 2: try a single batched INSERT OR REPLACE. CF D1 batch wraps in
  // an implicit transaction — all succeed or all fail. On failure we fall
  // back to per-record writes so we can ack/retry individually.
  const statements = survivors.map((message) => {
    const { sql, values } = buildInsertParts(table, message.body.data, message.body.id, message.body.machine_id);
    return env.MYCO_TEAM_DB.prepare(sql).bind(...values);
  });

  try {
    await env.MYCO_TEAM_DB.batch(statements);
    for (const message of survivors) {
      routeRecordForEmbedding(env, message.body, deleteVectorTasks, embedJobs);
      message.ack();
    }
  } catch (err) {
    console.error(`team-sync.queue.batch_upsert_failed table=${table}: ${err instanceof Error ? err.message : err}; falling back to per-record`);
    for (const message of survivors) {
      try {
        const result = await writeRecordToD1(env, message.body);
        if (result.embedTask) deleteVectorTasks.push(result.embedTask);
        if (result.embedJob) embedJobs.push(result.embedJob);
        message.ack();
      } catch (perRecordErr) {
        const reason = perRecordErr instanceof Error ? perRecordErr.message : String(perRecordErr);
        console.error(`team-sync.queue.write_failed ${table}/${message.body.id}: ${reason}`);
        message.retry();
      }
    }
  }
}

/** Coalesced delete path: one db.batch of DELETE per (id, machine_id). */
async function coalescedDeleteBatch(
  env: Env,
  table: string,
  messages: Array<Message<SyncRecord>>,
): Promise<void> {
  const deleteSql = `DELETE FROM ${table} WHERE id = ? AND machine_id = ?`;
  const statements = messages.map((message) =>
    env.MYCO_TEAM_DB.prepare(deleteSql).bind(message.body.id, message.body.machine_id),
  );

  try {
    await env.MYCO_TEAM_DB.batch(statements);
    for (const message of messages) {
      // Vectorize cleanup is best-effort and parallel-safe.
      if (message.body.table in EMBEDDABLE_TABLES) {
        void deleteVector(env, message.body.table, message.body.id, message.body.machine_id);
      }
      message.ack();
    }
  } catch (err) {
    console.error(`team-sync.queue.batch_delete_failed table=${table}: ${err instanceof Error ? err.message : err}; falling back to per-record`);
    for (const message of messages) {
      try {
        await handleDelete(env, message.body);
        message.ack();
      } catch (perRecordErr) {
        const reason = perRecordErr instanceof Error ? perRecordErr.message : String(perRecordErr);
        console.error(`team-sync.queue.delete_failed ${table}/${message.body.id}: ${reason}`);
        message.retry();
      }
    }
  }
}

/**
 * Coalesced reindex path. Reads each row from D1 (messages carry only
 * id/machine_id to keep queue payloads small), builds an embed task,
 * and acks. Embedding errors surface through the same allSettled probe
 * that wraps `coalescedUpsertBatch`'s tasks at the end of the batch.
 *
 * Designed for retroactive backfill: re-running against a fully-indexed
 * set is cheap because `embedAndUpsert` overwrites the same vector id.
 */
async function coalescedEmbedBatch(
  env: Env,
  table: string,
  messages: Array<Message<SyncRecord>>,
  deleteVectorTasks: Array<() => Promise<void>>,
  embedJobs: EmbedJob[],
): Promise<void> {
  if (!(table in EMBEDDABLE_TABLES)) {
    for (const message of messages) message.ack();
    return;
  }

  // D1 caps a prepared statement at 100 bound parameters. Two binds
  // per message (id + machine_id) means we can only address 50
  // messages per SELECT — chunk so a max-size CF queue batch (100
  // messages) doesn't blow the limit and route the whole group
  // through retries to DLQ.
  const D1_BIND_LIMIT_PAIRS = 50;
  const rowsByKey = new Map<string, Record<string, unknown>>();
  try {
    for (let offset = 0; offset < messages.length; offset += D1_BIND_LIMIT_PAIRS) {
      const slice = messages.slice(offset, offset + D1_BIND_LIMIT_PAIRS);
      const tuples = slice.map(() => '(?, ?)').join(', ');
      const binds = slice.flatMap((m) => [m.body.id, m.body.machine_id]);
      const result = await env.MYCO_TEAM_DB.prepare(
        `SELECT * FROM ${table} WHERE (id, machine_id) IN (${tuples})`,
      ).bind(...binds).all<Record<string, unknown>>();
      for (const row of result.results ?? []) {
        if (typeof row.id === 'string' && typeof row.machine_id === 'string') {
          rowsByKey.set(`${row.id}\t${row.machine_id}`, row);
        }
      }
    }
  } catch (err) {
    console.error(`team-sync.queue.embed_select_failed table=${table}: ${err instanceof Error ? err.message : err}`);
    for (const message of messages) message.retry();
    return;
  }

  for (const message of messages) {
    const row = rowsByKey.get(`${message.body.id}\t${message.body.machine_id}`);
    if (!row) {
      // Row was deleted between enqueue and consume — drop the embed
      // request to avoid an upsert against missing source data.
      message.ack();
      continue;
    }
    routeRecordForEmbedding(env, {
      table: table as SyncedTable,
      operation: 'embed',
      id: message.body.id,
      machine_id: message.body.machine_id,
      data: row,
    }, deleteVectorTasks, embedJobs);
    message.ack();
  }
}

/**
 * Route a record into either the vector-delete task list (retired
 * spores need their vector removed) or the embed job list (active
 * embeddable rows). No-op for non-embeddable tables or rows whose
 * embedding text is empty.
 */
function routeRecordForEmbedding(
  env: Env,
  record: SyncRecord,
  deleteVectorTasks: Array<() => Promise<void>>,
  embedJobs: EmbedJob[],
): void {
  const embeddableField = EMBEDDABLE_TABLES[record.table];
  if (!embeddableField) return;
  const textContent = record.data[embeddableField] as string | undefined;
  if (!textContent) return;
  const { table, id, machine_id } = record;
  if (table === 'spores' && record.data.status !== 'active') {
    deleteVectorTasks.push(() => deleteVector(env, table, id, machine_id));
    return;
  }
  embedJobs.push({
    table,
    id,
    machine_id,
    text: textContent,
    metadata: buildVectorMetadata(table, record.data),
  });
}

/**
 * Dead-letter consumer. Logs each failed message so operators can see the
 * tail-end record id and table without leaving the Worker logs view; the
 * daemon UI's Sync tab provides the structured replay/discard path.
 */
async function handleDlqBatch(batch: MessageBatch<SyncRecord>, _env: Env): Promise<void> {
  for (const message of batch.messages) {
    console.error(
      `team-sync.dlq received ${message.body.table}/${message.body.id} machine=${message.body.machine_id}`,
    );
    message.ack();
  }
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

  maybeString('project_id', data.project_id);

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


/**
 * Reindex by enqueueing per-row `embed` jobs onto the existing sync
 * queue. Returns immediately with the count rather than embedding
 * inline — callers watch progress via the Vectorize index count
 * surfaced through `/sync-summary`.
 *
 * Body: `{ table?: <one of EMBEDDABLE_TABLES> }`. When `table` is
 * omitted, queues every embeddable table.
 */
async function handleVectorReindex(request: Request, env: Env): Promise<Response> {
  const body = await request.json().catch(() => ({})) as {
    table?: keyof typeof EMBEDDABLE_TABLES;
  };
  const tables: Array<keyof typeof EMBEDDABLE_TABLES> = body.table
    ? [body.table]
    : (Object.keys(EMBEDDABLE_TABLES) as Array<keyof typeof EMBEDDABLE_TABLES>);

  for (const table of tables) {
    if (!(table in EMBEDDABLE_TABLES)) {
      return errorResponse(`Unknown table: ${table}`, 400);
    }
  }

  const startedAt = epochSeconds();
  await writeTeamConfig(env, {
    vector_reindex_status: 'enqueueing',
    vector_reindex_last_run_at: String(startedAt),
    vector_reindex_last_error: '',
  });

  const byTable: Record<string, number> = {};
  let totalEnqueued = 0;
  try {
    for (const table of tables) {
      const records = await listReindexEnqueueRecords(env, table);
      if (records.length > 0) {
        await sendQueueRecords(env.SYNC_QUEUE, records);
      }
      byTable[table] = records.length;
      totalEnqueued += records.length;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeTeamConfig(env, {
      vector_reindex_status: 'error',
      vector_reindex_last_run_at: String(epochSeconds()),
      vector_reindex_last_error: message,
    });
    throw error;
  }

  await writeTeamConfig(env, {
    vector_reindex_status: 'queued',
    vector_reindex_last_run_at: String(epochSeconds()),
    vector_reindex_last_processed: String(totalEnqueued),
    vector_reindex_last_error: '',
  });

  return jsonResponse({ enqueued: totalEnqueued, by_table: byTable });
}

/**
 * List minimal `embed` SyncRecords for a table — id/machine_id only,
 * no row payload (consumer reads the row from D1 at consume time).
 * Skips rows whose embeddable text is empty since `embedAndUpsert`
 * has nothing to embed for them.
 */
async function listReindexEnqueueRecords(
  env: Env,
  table: keyof typeof EMBEDDABLE_TABLES,
): Promise<SyncRecord[]> {
  const textField = EMBEDDABLE_TABLES[table];
  const { results } = await env.MYCO_TEAM_DB.prepare(
    `SELECT id, machine_id, ${textField} AS text FROM ${table}
     WHERE ${textField} IS NOT NULL AND length(${textField}) > 0`,
  ).all<{ id: string; machine_id: string; text: string }>();
  return (results ?? []).map((row) => ({
    table: table as SyncedTable,
    operation: 'embed' as const,
    id: row.id,
    machine_id: row.machine_id,
    data: {},
  }));
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
    project_id: url.searchParams.get('project_id') ?? undefined,
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

async function handleSyncSummary(env: Env): Promise<Response> {
  const selectList = SYNCED_TABLES.map((table) => `(SELECT COUNT(*) FROM ${table}) AS ${table}`).join(', ');
  const row = await env.MYCO_TEAM_DB.prepare(`SELECT ${selectList}`).first<Record<string, unknown>>() ?? {};
  const tables: Record<string, number> = {};
  let totalRecords = 0;

  for (const table of SYNCED_TABLES) {
    const value = Number(row[table] ?? 0);
    const count = Number.isFinite(value) ? value : 0;
    tables[table] = count;
    totalRecords += count;
  }

  // Vectorize index probe — `describe()` JSON has the count field as
  // `vectorCount` at runtime (matches `wrangler vectorize info`), but
  // the @cloudflare/workers-types declaration calls it `vectorsCount`.
  // Read both. Whichever the runtime actually populates wins; the
  // other resolves to undefined and the `??` chain skips it.
  let vectorCount: number | null = null;
  let vectorIndexHealthy = false;
  let vectorIndexError: string | null = null;
  try {
    const desc = (await env.MYCO_TEAM_VECTORS.describe()) as unknown as
      { vectorsCount?: number; vectorCount?: number };
    const raw = desc.vectorCount ?? desc.vectorsCount;
    const c = Number(raw ?? 0);
    vectorCount = Number.isFinite(c) ? c : null;
    vectorIndexHealthy = true;
  } catch (err) {
    vectorIndexError = (err as Error).message ?? 'describe failed';
  }

  const schemaVersion = Number(env.MYCO_SCHEMA_VERSION ?? '');
  const syncProtocolVersion = Number(env.SYNC_PROTOCOL_VERSION ?? '');

  return jsonResponse({
    generated_at: epochSeconds(),
    total_records: totalRecords,
    tables,
    vector_count: vectorCount,
    vector_index_healthy: vectorIndexHealthy,
    vector_index_error: vectorIndexError,
    schema_version: Number.isFinite(schemaVersion) ? schemaVersion : null,
    package_version: env.MYCO_TEAM_PACKAGE_VERSION ?? DEFAULT_TEAM_PACKAGE_VERSION,
    sync_protocol_version: Number.isFinite(syncProtocolVersion) ? syncProtocolVersion : 0,
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

/**
 * Operator surface for queue diagnostics + DLQ management. All endpoints
 * require the project's CF API token (queues:read,write) stashed in KV.
 * Daemon flows the token through `POST /tokens/cf-api`; the UI surfaces
 * the queue/DLQ state as unavailable when missing.
 */
async function handleQueueStats(env: Env): Promise<Response> {
  const creds = await readCfApiCredentials(env.MYCO_SECRETS);
  if (!creds) {
    return jsonResponse({ error: 'cf_api_token_not_configured' }, 412);
  }
  try {
    const stats = await fetchQueueStats(creds, env.SYNC_QUEUE_NAME, env.SYNC_DLQ_NAME);
    return jsonResponse(stats);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : String(err), 502);
  }
}

async function handleDlqList(request: Request, env: Env): Promise<Response> {
  const creds = await readCfApiCredentials(env.MYCO_SECRETS);
  if (!creds) {
    return jsonResponse({ error: 'cf_api_token_not_configured' }, 412);
  }
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') ?? '50');
  try {
    const result = await pullDlqMessages(creds, env.SYNC_DLQ_NAME, limit);
    return jsonResponse(result);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : String(err), 502);
  }
}

async function handleDlqRetry(request: Request, env: Env): Promise<Response> {
  const creds = await readCfApiCredentials(env.MYCO_SECRETS);
  if (!creds) {
    return jsonResponse({ error: 'cf_api_token_not_configured' }, 412);
  }
  const body = await request.json() as { lease_ids?: string[] };
  const leaseIds = Array.isArray(body.lease_ids) ? body.lease_ids.filter((id): id is string => typeof id === 'string') : [];
  if (leaseIds.length === 0) {
    return errorResponse('lease_ids array is required', 400);
  }
  try {
    await retryDlqMessages(creds, env.SYNC_DLQ_NAME, leaseIds);
    return jsonResponse({ retried: leaseIds.length });
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : String(err), 502);
  }
}

async function handleDlqDiscard(request: Request, env: Env): Promise<Response> {
  const creds = await readCfApiCredentials(env.MYCO_SECRETS);
  if (!creds) {
    return jsonResponse({ error: 'cf_api_token_not_configured' }, 412);
  }
  const body = await request.json() as { lease_ids?: string[] };
  const leaseIds = Array.isArray(body.lease_ids) ? body.lease_ids.filter((id): id is string => typeof id === 'string') : [];
  if (leaseIds.length === 0) {
    return errorResponse('lease_ids array is required', 400);
  }
  try {
    await discardDlqMessages(creds, env.SYNC_DLQ_NAME, leaseIds);
    return jsonResponse({ discarded: leaseIds.length });
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : String(err), 502);
  }
}

async function handleSetCfApiToken(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { token?: string; account_id?: string };
  if (!body.token || !body.account_id) {
    return errorResponse('token and account_id are required', 400);
  }
  await writeCfApiCredentials(env.MYCO_SECRETS, body.token, body.account_id);
  return jsonResponse({ configured: true });
}

async function handleClearCfApiToken(env: Env): Promise<Response> {
  await clearCfApiCredentials(env.MYCO_SECRETS);
  return jsonResponse({ cleared: true });
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
      if (method === 'POST' && path === '/enqueue') {
        return await handleEnqueue(request, env);
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
      if (method === 'GET' && path === '/queue-stats') {
        return await handleQueueStats(env);
      }
      if (method === 'GET' && path === '/sync-summary') {
        return await handleSyncSummary(env);
      }
      if (method === 'GET' && path === '/dlq') {
        return await handleDlqList(request, env);
      }
      if (method === 'POST' && path === '/dlq/retry') {
        return await handleDlqRetry(request, env);
      }
      if (method === 'POST' && path === '/dlq/discard') {
        return await handleDlqDiscard(request, env);
      }
      if (method === 'POST' && path === '/tokens/cf-api') {
        return await handleSetCfApiToken(request, env);
      }
      if (method === 'DELETE' && path === '/tokens/cf-api') {
        return await handleClearCfApiToken(env);
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
  /**
   * Queue consumer entry point. Cloudflare invokes this with a MessageBatch
   * for whichever consumer matched in wrangler.toml. Discriminate by exact
   * queue name from the env binding so unrelated future queues on this
   * Worker can't be silently routed to the sync handler.
   */
  async queue(batch: MessageBatch<SyncRecord>, env: Env, _ctx: ExecutionContext): Promise<void> {
    if (batch.queue === env.SYNC_DLQ_NAME) {
      await handleDlqBatch(batch, env);
      return;
    }
    if (batch.queue === env.SYNC_QUEUE_NAME) {
      await handleSyncBatch(batch, env);
      return;
    }
    console.error(`team-sync.queue.unknown queue=${batch.queue}; ack-and-drop`);
    for (const message of batch.messages) message.ack();
  },
} satisfies ExportedHandler<Env, SyncRecord>;
