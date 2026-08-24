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
import { SYNCED_TABLES, requiresGroveProjectId, stampSyncedAtAtIngestion, type SyncedTable } from './synced-tables';
import { parseManifestParams, queryManifest } from './manifest';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Env {
  MYCO_TEAM_DB: D1Database;
  MYCO_TEAM_VECTORS: VectorizeIndex;
  AI: Ai;
  MYCO_TEAM_API_KEY: string;
  /**
   * Server-side sync protocol version. Read as a string from
   * `wrangler.toml [vars]` and parsed at request time. The worker
   * accepts clients in the inclusive window
   * `[MIN_COMPAT_CLIENT_VERSION, SYNC_PROTOCOL_VERSION]`.
   */
  SYNC_PROTOCOL_VERSION: string;
  /**
   * Oldest sync protocol the worker still accepts. Mirrors the
   * `MIN_COMPAT_CLIENT_VERSION` constant in
   * `packages/myco/src/constants.ts`. Optional in the type so older
   * deploys without the var still boot — `resolveProtocolBounds`
   * falls back to "same as server" (preserving the historical
   * strict-equality gate).
   */
  MIN_COMPAT_CLIENT_VERSION?: string;
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

/**
 * All tables the sync endpoint accepts records for. Authoritative list lives
 * in `./synced-tables` (a dependency-free module) so the daemon-package parity
 * test can import the real value without pulling in the Workers runtime graph.
 */
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

/**
 * Resolve the server-side protocol bounds. The worker accepts clients
 * in the inclusive window `[minClientVersion, serverVersion]`. The
 * min bound is optional in `Env` so older deploys without the var
 * still boot — in that case we fall back to "same as server" (no
 * compat window, equivalent to the historical strict-equality gate).
 */
function resolveProtocolBounds(env: Env): { serverVersion: number; minClientVersion: number } {
  const serverVersion = parseInt(env.SYNC_PROTOCOL_VERSION, 10);
  const parsedMin = env.MIN_COMPAT_CLIENT_VERSION
    ? parseInt(env.MIN_COMPAT_CLIENT_VERSION, 10)
    : NaN;
  const minClientVersion = Number.isFinite(parsedMin) ? parsedMin : serverVersion;
  return { serverVersion, minClientVersion };
}

const QUEUE_SEND_BATCH_SIZE = 100;
const QUEUE_SEND_BATCH_MAX_BYTES = 192 * 1024;

/**
 * Max times a dead-lettered message is replayed main→DLQ→main before it
 * is parked terminally in `team_dlq` for the operator. Without this cap a
 * deterministically-failing ("poison") record loops forever — burning
 * budget and inflating `backlog` (every replay bumps `enqueued` while
 * `processed` only rises on success). Operator `Retry` resets the cycle
 * by DELETEing the row (and thus its `replay_count`).
 */
const MAX_DLQ_REPLAYS = 3;

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

async function sendQueueRecords(env: Env, records: SyncRecord[]): Promise<void> {
  let chunk: SyncRecord[] = [];
  let chunkBytes = 0;

  const flush = async () => {
    if (chunk.length === 0) return;
    await env.SYNC_QUEUE.sendBatch(chunk.map((record) => ({ body: record })));
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

  // `enqueued` counts every message put on the main queue, across ALL
  // producers (the /enqueue endpoint, vector reindex, DLQ replay/retry).
  // Counting here — the single send choke point — instead of only at
  // /enqueue keeps `enqueued` and `processed` measuring the same population,
  // so backlog = enqueued - processed is a real in-flight proxy. Counting
  // only /enqueue let reindex jobs (which enqueue directly) inflate
  // `processed` without `enqueued`, pinning backlog at 0.
  // Best-effort: a stats write failure must never fail the send path.
  if (records.length > 0) {
    try {
      await env.MYCO_TEAM_DB.prepare(
        'UPDATE team_sync_stats SET enqueued = enqueued + ? WHERE id = 1',
      ).bind(records.length).run();
    } catch {
      // Stats write failed — ignore, the queue send already succeeded.
    }
  }
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

/** Mutable counters threaded through coalesced batch helpers for best-effort D1 stats. */
interface SyncBatchCounts {
  applied: number;
  failed: number;
  lastError: string;
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
 */
const lastSeenWritten = new Map<string, number>();
const NODE_LAST_SEEN_UPDATE_INTERVAL_SECONDS = 5 * 60;

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;
const DEFAULT_TOP_K = 10;
const MAX_TOP_K = 50;
const DEFAULT_TEAM_PACKAGE_VERSION = '0.1.0';
const TEAM_CAPABILITIES = ['search', 'digest'] as const;
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

function parseSchemaVersion(env: Env): number | null {
  const rawValue = env.MYCO_SCHEMA_VERSION?.trim();
  if (!rawValue) return null;
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/** What this worker reports about itself on the health surface. */
function teamMetadata(env: Env): { capabilities: string[]; package_version: string; schema_version: number | null } {
  return {
    capabilities: [...TEAM_CAPABILITIES],
    package_version: env.MYCO_TEAM_PACKAGE_VERSION?.trim() || DEFAULT_TEAM_PACKAGE_VERSION,
    schema_version: parseSchemaVersion(env),
  };
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
  const row: Record<string, unknown> = { id, machine_id: machineId, ...data };

  // Machine-scoped rows (team_members) carry a NULL synced_at over the wire —
  // the daemon stamps it locally only after a successful push, so the
  // serialized payload predates that write. Stamp the worker's receive time so
  // the roster's "last received" provenance is server-authoritative. Project-
  // scoped rows keep their wire synced_at untouched.
  if (stampSyncedAtAtIngestion(table)) {
    row.synced_at = epochSeconds();
  }

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
  const metadata = teamMetadata(env);
  const [countResult, storedToken] = await Promise.all([
    env.MYCO_TEAM_DB.prepare('SELECT COUNT(*) as count FROM nodes').first<{ count: number }>(),
    env.MYCO_SECRETS.get(MCP_TOKEN_KEY),
  ]);

  const count = countResult?.count ?? 0;
  const mcpTokenHash = storedToken ? getMcpTokenHash(storedToken) : null;
  const { serverVersion, minClientVersion } = resolveProtocolBounds(env);

  return jsonResponse({
    status: 'ok',
    nodes: count,
    node_count: count,
    sync_protocol_version: serverVersion,
    min_compat_client_version: minClientVersion,
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

  // Reject pre-window clients up-front so they don't quietly register
  // a node row that the worker then refuses every push from. The same
  // window guards `/api/team/enqueue` below; surfacing it here means
  // the daemon's connect step gets a clear typed error to display in
  // the Team page (instead of "connected" followed by silent push
  // failures). A missing `sync_protocol_version` is allowed for
  // backward compatibility — older daemons that don't send the field
  // are treated as v1 and gated below at enqueue time.
  const { serverVersion, minClientVersion } = resolveProtocolBounds(env);
  if (typeof body.sync_protocol_version === 'number'
    && (body.sync_protocol_version < minClientVersion || body.sync_protocol_version > serverVersion)) {
    return jsonResponse({
      error: 'protocol_version_unsupported',
      message: `Client protocol v${body.sync_protocol_version} is outside the worker's supported window [${minClientVersion}, ${serverVersion}]. Run \`myco update\` (or \`myco-team upgrade\`) on this machine.`,
      sync_protocol_version: serverVersion,
      min_compat_client_version: minClientVersion,
    }, 409);
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
    sync_protocol_version: serverVersion,
    min_compat_client_version: minClientVersion,
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

  // Accept clients in the inclusive `[minClientVersion, serverVersion]`
  // window. This replaces the historical strict-equality gate so an
  // upgraded worker doesn't lock out teammates whose daemon hasn't
  // shipped the bump yet. Out-of-window payloads still 409 with an
  // explicit typed error — silent shape changes are not allowed.
  const { serverVersion, minClientVersion } = resolveProtocolBounds(env);
  const clientVersion = body.sync_protocol_version;
  if (clientVersion < minClientVersion || clientVersion > serverVersion) {
    return jsonResponse({
      error: 'protocol_version_unsupported',
      message: `Client protocol v${clientVersion} is outside the worker's supported window [${minClientVersion}, ${serverVersion}]. Run \`myco update\` on this machine.`,
      sync_protocol_version: serverVersion,
      min_compat_client_version: minClientVersion,
    }, 409);
  }

  if (!Array.isArray(body.records) || body.records.length === 0) {
    return jsonResponse({ accepted: 0 });
  }

  // Protocol v1 didn't define the `embed` SyncRecord operation. A v1
  // client should never produce one, but if a payload sneaks through
  // (e.g. a daemon mid-upgrade) reject it explicitly rather than
  // letting the consumer route it through `coalescedEmbedBatch`
  // against an empty data payload. Defense-in-depth — mirrors in
  // spirit the project_id gate further down.
  if (clientVersion < 2) {
    const hasEmbed = body.records.some((record) => record.operation === 'embed');
    if (hasEmbed) {
      return jsonResponse({
        error: 'protocol_too_old_for_embed',
        message: `Client protocol v${clientVersion} cannot use the 'embed' SyncRecord operation (added in v2). Run \`myco update\` on this machine.`,
        sync_protocol_version: serverVersion,
        min_compat_client_version: minClientVersion,
      }, 409);
    }
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
    if (requiresGroveProjectId(record.table) && !isGroveProjectId(projectId)) {
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
    // sendQueueRecords bumps the `enqueued` stat itself (single choke point).
    await sendQueueRecords(env, acceptedRecords);
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
    await initD1Schema(env.MYCO_TEAM_DB, { minClientVersion: resolveProtocolBounds(env).minClientVersion });
    schemaInitialized = true;
  }

  const deleteVectorTasks: Array<() => Promise<void>> = [];
  const embedJobs: EmbedJob[] = [];
  // Mutable counters threaded through coalesced helpers for best-effort stats.
  const batchCounts = { applied: 0, failed: 0, lastError: '' };
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
      await coalescedDeleteBatch(env, table, messages, batchCounts);
    } else if (operation === 'embed') {
      await coalescedEmbedBatch(env, table, messages, deleteVectorTasks, embedJobs, batchCounts);
    } else {
      await coalescedUpsertBatch(env, table, messages, deleteVectorTasks, embedJobs, batchCounts);
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
  let embedSucceeded = 0;
  let embedFailed = 0;
  let embedLastError: string | null = null;
  if (embedJobs.length > 0) {
    const embedResult = await runBatchEmbed(env, embedJobs);
    embedSucceeded = embedResult.succeeded;
    embedFailed = embedResult.failed;
    embedLastError = embedResult.lastError;
  }

  // Best-effort stats update — a write failure must never fail the consume path.
  try {
    const lastError = batchCounts.failed > 0 ? batchCounts.lastError || 'sync failed' : null;
    await env.MYCO_TEAM_DB.prepare(
      'UPDATE team_sync_stats SET processed = processed + ?, failed = failed + ?, last_run_at = ?, last_error = CASE WHEN ? IS NOT NULL THEN ? ELSE last_error END WHERE id = 1',
    ).bind(batchCounts.applied, batchCounts.failed, epochSeconds(), lastError, lastError).run();
  } catch {
    // Stats write failed — ignore, sync path takes priority.
  }

  // Best-effort embed stats — persisted independently so a D1 write failure
  // cannot affect the D1 sync stats or the consume path.
  try {
    const embedErr = embedFailed > 0 ? embedLastError : null;
    await env.MYCO_TEAM_DB.prepare(
      'UPDATE team_sync_stats SET embed_ok = embed_ok + ?, embed_failed = embed_failed + ?, last_embed_at = ?, last_embed_error = CASE WHEN ? IS NOT NULL THEN ? ELSE last_embed_error END WHERE id = 1',
    ).bind(embedSucceeded, embedFailed, epochSeconds(), embedErr, embedErr).run();
  } catch {
    // Embed stats write failed — ignore, sync path takes priority.
  }
}


/** Vectorize rate-limit signal (40041 / "Too Many Requests"). */
function isVectorizeRateLimit(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('40041') || /too many requests/i.test(msg);
}

const VECTOR_UPSERT_MAX_ATTEMPTS = 5;
const VECTOR_UPSERT_BACKOFF_MS = [500, 1000, 2000, 4000];

/**
 * Single source of truth for the Vectorize upsert retry contract: up to
 * 5 attempts, exponential backoff on rate-limit (40041), throws the last
 * error on any non-rate-limit failure or once retries are exhausted. Used
 * for both the batch attempt and each per-row attempt in
 * `upsertVectorsResilient` so the codes/backoff live in one place.
 */
async function upsertWithRateLimitBackoff(
  index: VectorizeIndex,
  vectors: VectorizeVector[],
): Promise<void> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < VECTOR_UPSERT_MAX_ATTEMPTS; attempt++) {
    try {
      await index.upsert(vectors);
      return;
    } catch (err) {
      lastErr = err;
      if (isVectorizeRateLimit(err) && attempt < VECTOR_UPSERT_MAX_ATTEMPTS - 1) {
        await new Promise<void>((r) => setTimeout(r, VECTOR_UPSERT_BACKOFF_MS[attempt] ?? 4000));
        continue;
      }
      // Non-rate-limit error or retries exhausted.
      break;
    }
  }
  throw lastErr;
}

/**
 * Attempt to upsert an array of vectors as a single batch, falling back to
 * per-row upserts on non-rate-limit errors so one poison vector cannot sink
 * its batch-mates. Rate-limit (40041 / "Too Many Requests") is retried with
 * exponential backoff up to 5 attempts before the same per-row fallback path
 * activates. Mirrors the "optimistic batch + per-record fallback" pattern of
 * coalescedUpsertBatch.
 */
async function upsertVectorsResilient(
  env: Env,
  vectors: VectorizeVector[],
): Promise<{ ok: number; failed: number }> {
  // Attempt batched upsert with backoff on rate-limit.
  let batchErr: unknown = null;
  try {
    await upsertWithRateLimitBackoff(env.MYCO_TEAM_VECTORS, vectors);
    return { ok: vectors.length, failed: 0 };
  } catch (err) {
    // Non-rate-limit error or retries exhausted — fall through to per-row.
    batchErr = err;
  }

  // Per-row fallback: isolate the failure to the offending vector(s).
  let ok = 0;
  let failed = 0;
  for (const v of vectors) {
    try {
      await upsertWithRateLimitBackoff(env.MYCO_TEAM_VECTORS, [v]);
      ok++;
    } catch (rowErr) {
      failed++;
      const meta = v.metadata as TeamVectorMetadata | undefined;
      console.error('team-sync.vector-upsert-failed', {
        table: meta?.table,
        id: meta?.id,
        error: rowErr instanceof Error ? rowErr.message : String(rowErr),
      });
    }
  }
  // Log batch failure context for tail inspection — only when the per-row
  // fallback actually produced failures, not when every row recovered.
  if (failed > 0) {
    console.error('team-sync.batch-upsert-fell-back-to-per-row', {
      count: vectors.length,
      error: batchErr instanceof Error ? batchErr.message : String(batchErr),
    });
  }
  return { ok, failed };
}

/**
 * Embed each job sequentially via per-row embedText (one ai.run per row).
 * We tried batching multiple texts per ai.run to amortize the per-call
 * overhead, but bge-m3's 60K-token total context window combined with the
 * wide tokenization-density variance across this dataset (0.84–4 chars/token
 * observed) made batch sizing unreliable: every estimated budget either
 * dropped vectors or killed throughput, and the model surfaces at least two
 * distinct overflow error codes (3030, 5021) requiring increasingly broad
 * detection. Per-row embedding is always correct: each call has one text well
 * under the context window, so token overflow is structurally impossible.
 *
 * Vectorize upsert is batched ONCE per consumer batch via upsertVectorsResilient,
 * which handles the 40041 rate-limit with exponential backoff. Previously each
 * row called MYCO_TEAM_VECTORS.upsert([singleVector]), producing ~1241 concurrent
 * upsert calls on a full reindex and triggering the write-rate-limit (40041).
 */
async function runBatchEmbed(env: Env, jobs: EmbedJob[]): Promise<{ succeeded: number; failed: number; lastError: string | null }> {
  const vectors: VectorizeVector[] = [];
  const legacyDeletes: string[] = [];
  let embedFailed = 0;
  let lastError: string | null = null;

  for (const job of jobs) {
    try {
      const values = await embedText(env.AI, job.text);
      const vid = await vectorId(job.table, job.id, job.machine_id);
      const legacyId = legacyVectorId(job.table, job.id, job.machine_id);
      if (legacyId !== vid) legacyDeletes.push(legacyId);
      vectors.push({
        id: vid,
        values,
        metadata: { table: job.table, id: job.id, machine_id: job.machine_id, ...job.metadata } as Record<string, VectorizeVectorMetadata>,
      });
    } catch (err) {
      embedFailed++;
      const msg = err instanceof Error ? err.message : String(err);
      lastError = msg;
      console.error('team-sync.embed-failed', {
        table: job.table,
        id: job.id,
        error: msg,
      });
    }
  }

  if (legacyDeletes.length > 0) {
    try {
      await env.MYCO_TEAM_VECTORS.deleteByIds(legacyDeletes);
    } catch {
      // Legacy vectors may not exist — best-effort.
    }
  }

  let upsertOk = 0;
  let upsertFailed = 0;
  if (vectors.length > 0) {
    const result = await upsertVectorsResilient(env, vectors);
    upsertOk = result.ok;
    upsertFailed = result.failed;
    if (upsertFailed > 0 && lastError === null) {
      lastError = `${upsertFailed} vector upsert(s) failed`;
    }
  }

  const succeeded = upsertOk;
  const failed = embedFailed + upsertFailed;
  if (failed > 0) {
    console.error(`team-sync.embed-summary ${failed}/${jobs.length} failed (${succeeded} succeeded)`);
  }
  return { succeeded, failed, lastError };
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
  counts: SyncBatchCounts,
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
      counts.applied++;
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
      counts.applied++;
    }
  } catch (err) {
    console.error(`team-sync.queue.batch_upsert_failed table=${table}: ${err instanceof Error ? err.message : err}; falling back to per-record`);
    for (const message of survivors) {
      try {
        const result = await writeRecordToD1(env, message.body);
        if (result.embedTask) deleteVectorTasks.push(result.embedTask);
        if (result.embedJob) embedJobs.push(result.embedJob);
        message.ack();
        counts.applied++;
      } catch (perRecordErr) {
        const reason = perRecordErr instanceof Error ? perRecordErr.message : String(perRecordErr);
        console.error(`team-sync.queue.write_failed ${table}/${message.body.id}: ${reason}`);
        // Transient: message.retry() redelivers and re-counts as `applied`
        // on success. Counting `failed` here would permanently inflate the
        // stat and make `last_error` sticky on a healthy, fully-drained
        // queue, so we only log — never touch counts on a retried path.
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
  counts: SyncBatchCounts,
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
      counts.applied++;
    }
  } catch (err) {
    console.error(`team-sync.queue.batch_delete_failed table=${table}: ${err instanceof Error ? err.message : err}; falling back to per-record`);
    for (const message of messages) {
      try {
        await handleDelete(env, message.body);
        message.ack();
        counts.applied++;
      } catch (perRecordErr) {
        const reason = perRecordErr instanceof Error ? perRecordErr.message : String(perRecordErr);
        console.error(`team-sync.queue.delete_failed ${table}/${message.body.id}: ${reason}`);
        // Transient retry — redelivered and re-counted as `applied` on
        // success. Don't touch counts (see coalescedUpsertBatch).
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
  counts: SyncBatchCounts,
): Promise<void> {
  if (!(table in EMBEDDABLE_TABLES)) {
    for (const message of messages) {
      message.ack();
      counts.applied++;
    }
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
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`team-sync.queue.embed_select_failed table=${table}: ${reason}`);
    // Transient: the whole group is retried and re-counted as `applied`
    // on success, so don't touch counts (see coalescedUpsertBatch).
    for (const message of messages) {
      message.retry();
    }
    return;
  }

  for (const message of messages) {
    const row = rowsByKey.get(`${message.body.id}\t${message.body.machine_id}`);
    if (!row) {
      // Row was deleted between enqueue and consume — drop the embed
      // request to avoid an upsert against missing source data.
      message.ack();
      counts.applied++;
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
    counts.applied++;
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
 * Dead-letter consumer.
 *
 * Two delivery paths land here:
 *   1. First-time failure — the main consumer exhausted its retries and CF
 *      moved the message to this DLQ. We log it so operators can see the
 *      tail-end record id and table without leaving the Worker logs view.
 *   2. Operator-initiated replay — `handleDlqRetry` calls the CF Queues
 *      `messages/ack` endpoint with `retries: [...]`, which re-delivers
 *      those messages. CF redelivers them BACK to this same DLQ consumer,
 *      not the main sync queue. Without an explicit re-publish, the
 *      operator's "Retry all" click silently no-ops: the message lands
 *      here, gets ack()ed, and never reaches `handleSyncBatch` / D1.
 *
 * Re-publishing each message to the main SYNC_QUEUE before acking gives
 * `Retry all` real semantics: the message re-enters the normal sync path,
 * gets validated and written to D1 (or re-DLQs if the underlying problem
 * is unfixed — but at least the retry attempt happens). The ack-then-send
 * order would risk message loss if send() throws, so we send first and
 * ack only on success.
 */
async function handleDlqBatch(batch: MessageBatch<SyncRecord>, env: Env): Promise<void> {
  if (batch.messages.length === 0) return;

  // The lease_id is the stable per-record key `${table}:${id}:${machine_id}`.
  // It's what `team_dlq` keys on (INSERT OR REPLACE), what the operator
  // surfaces in `handleDlqList`, and what `handleDlqRetry`/`handleDlqDiscard`
  // address rows by. Compute it once per message and reuse it for the
  // replay-count lookup, the upsert, and the cap check.
  const leaseIds = batch.messages.map((m) => `${m.body.table}:${m.body.id}:${m.body.machine_id}`);

  // Look up the current replay_count per lease_id in a single batched SELECT
  // so we can increment it monotonically across DLQ deliveries. A message
  // that keeps poisoning the queue climbs replay_count each time it lands here.
  const existingReplayCounts = new Map<string, number>();
  try {
    const placeholders = leaseIds.map(() => '?').join(', ');
    const rows = await env.MYCO_TEAM_DB.prepare(
      `SELECT lease_id, replay_count FROM team_dlq WHERE lease_id IN (${placeholders})`,
    ).bind(...leaseIds).all<{ lease_id: string; replay_count: number | null }>();
    for (const row of rows.results ?? []) {
      existingReplayCounts.set(row.lease_id, Number(row.replay_count ?? 0));
    }
  } catch {
    // SELECT failed — treat every message as never-before-seen (replay_count 0).
    // Worst case a poison record gets a few extra replays before the cap bites.
  }

  // Best-effort: persist each dead-lettered message to team_dlq for operator
  // visibility, carrying the incremented replay_count. INSERT OR REPLACE so
  // repeated DLQ deliveries of the same record update rather than duplicate.
  // This runs BEFORE the replay decision so visibility (and the cap counter)
  // is preserved even if the replay send throws.
  const replayable: SyncRecord[] = [];
  const cappedMessages: Array<Message<SyncRecord>> = [];
  const replayMessages: Array<Message<SyncRecord>> = [];
  for (let i = 0; i < batch.messages.length; i++) {
    const m = batch.messages[i];
    const leaseId = leaseIds[i];
    const nextCount = (existingReplayCounts.get(leaseId) ?? 0) + 1;
    try {
      await env.MYCO_TEAM_DB.prepare(
        `INSERT OR REPLACE INTO team_dlq
           (lease_id, table_name, row_id, machine_id, operation, payload, reason, created_at, replay_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        leaseId,
        m.body.table,
        m.body.id,
        m.body.machine_id,
        m.body.operation,
        JSON.stringify(m.body),
        nextCount > MAX_DLQ_REPLAYS
          ? `replay capped after ${MAX_DLQ_REPLAYS} attempts`
          : 'dead-lettered after max retries',
        epochSeconds(),
        nextCount,
      ).run();
    } catch {
      // DLQ write failed — ignore, replay path takes priority.
    }

    if (nextCount > MAX_DLQ_REPLAYS) {
      // Poison record: stop the main→DLQ→main loop. Leave it terminal in
      // team_dlq for the operator (Retry resets the cycle via DELETE) and
      // ack so CF doesn't redeliver the DLQ message.
      console.error('team-sync.dlq.replay-capped', { lease_id: leaseId, replay_count: nextCount });
      cappedMessages.push(m);
    } else {
      replayable.push(m.body);
      replayMessages.push(m);
    }
  }

  if (cappedMessages.length > 0) {
    for (const message of cappedMessages) message.ack();
  }

  if (replayable.length === 0) return;

  // Single sendBatch instead of N individual sends — Cloudflare Queues
  // atomically enqueues the whole array, dropping N HTTP-shaped calls
  // to 1 per consumer batch (up to 100 msgs). The per-message ack/retry
  // still happens individually so an enqueue failure isn't load-bearing
  // for the unaffected messages.
  try {
    await sendQueueRecords(env, replayable);
    for (const message of replayMessages) {
      console.error(
        `team-sync.dlq replay -> main ${message.body.table}/${message.body.id} machine=${message.body.machine_id}`,
      );
      message.ack();
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`team-sync.dlq replay_failed (batch of ${replayMessages.length}): ${reason}`);
    // Don't ack — let CF redeliver. If the SYNC_QUEUE binding is
    // genuinely broken, the messages stay in DLQ instead of being lost.
    for (const message of replayMessages) message.retry();
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
        await sendQueueRecords(env, records);
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

  // Response shape:
  //   - New (v2) callers read `enqueued` and `by_table`.
  //   - Pre-Grove (v1) callers expected
  //     `{ table, processed, reindexed, deleted, next_cursor }` from
  //     the inline-embedding implementation that this endpoint
  //     replaced. Emit those fields *additively* so an upgraded
  //     worker doesn't silently break a teammate whose daemon hasn't
  //     shipped the bump yet — `processed` and `reindexed` map
  //     1:1 to the enqueue count, `deleted` is always 0 (deletes are
  //     handled by the queue consumer, not the producer), and
  //     `next_cursor` is null because the queue-driven path does the
  //     full table in a single enqueue. New code MUST NOT rely on
  //     the legacy fields — they exist only for cross-version
  //     compatibility during the v1 → v2 rollout.
  const firstTable = tables[0] ?? null;
  return jsonResponse({
    enqueued: totalEnqueued,
    by_table: byTable,
    table: firstTable,
    processed: totalEnqueued,
    reindexed: totalEnqueued,
    deleted: 0,
    next_cursor: null,
    sync_protocol_version: resolveProtocolBounds(env).serverVersion,
  });
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
  const sql = embeddableSelectSql(table, 'id, machine_id');
  const { results } = await env.MYCO_TEAM_DB.prepare(sql).all<{ id: string; machine_id: string }>();
  return (results ?? []).map((row) => ({
    table: table as SyncedTable,
    operation: 'embed' as const,
    id: row.id,
    machine_id: row.machine_id,
    data: {},
  }));
}

/**
 * SQL fragment matching exactly the rows the consumer will actually
 * embed: non-empty text, plus `status='active'` on spores (consumer
 * routes non-active spores to deleteVector, not embed). Keeping the
 * producer's filter aligned with the consumer's routing means
 * `vector_enqueued` reports what'll actually become a vector — no
 * more "1967 enqueued, 818 expected" confusion.
 */
function embeddableSelectSql(
  table: keyof typeof EMBEDDABLE_TABLES,
  columns: string,
): string {
  const textField = EMBEDDABLE_TABLES[table];
  const statusFilter = table === 'spores' ? ` AND status = 'active'` : '';
  return `SELECT ${columns} FROM ${table}
          WHERE ${textField} IS NOT NULL
            AND length(${textField}) > 0${statusFilter}`;
}

/** Count rows in remote D1 that the consumer would embed if reindexed. */
async function countEmbeddableRows(env: Env): Promise<number> {
  let total = 0;
  for (const table of Object.keys(EMBEDDABLE_TABLES) as Array<keyof typeof EMBEDDABLE_TABLES>) {
    const sql = embeddableSelectSql(table, 'COUNT(*) AS cnt');
    const row = await env.MYCO_TEAM_DB.prepare(sql).first<{ cnt: number }>();
    total += Number(row?.cnt ?? 0);
  }
  return total;
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
    release_state: url.searchParams.get('release_state') ?? undefined,
    release_confidence: url.searchParams.get('release_confidence') ?? undefined,
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

async function handleSyncSummary(request: Request, env: Env): Promise<Response> {
  const machineId = new URL(request.url).searchParams.get('machine_id')?.trim() || null;

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

  // Per-machine table counts — only computed when machine_id is supplied so
  // the caller can compare THIS machine's local rows against THIS machine's
  // cloud rows without false-positive drift from other machines' data.
  let machine_tables: Record<string, number> | null = null;
  if (machineId) {
    const machineSelectList = SYNCED_TABLES.map(
      (table) => `(SELECT COUNT(*) FROM ${table} WHERE machine_id = ?) AS ${table}`,
    ).join(', ');
    const machineRow = await env.MYCO_TEAM_DB.prepare(`SELECT ${machineSelectList}`)
      .bind(...SYNCED_TABLES.map(() => machineId))
      .first<Record<string, unknown>>() ?? {};
    machine_tables = {};
    for (const table of SYNCED_TABLES) {
      const value = Number(machineRow[table] ?? 0);
      machine_tables[table] = Number.isFinite(value) ? value : 0;
    }
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

  // Embeddable target: how many vectors the index *should* hold given
  // current D1 contents (active-spore + non-empty text filter,
  // matching the consumer's routing). Surfaced so the Vectors tile
  // can render "X of Y indexed" instead of comparing to misleading
  // counts like total enqueue-eligible (which double-counts retired
  // spores routed to deleteVector).
  let embeddableCount: number | null = null;
  try {
    embeddableCount = await countEmbeddableRows(env);
  } catch (err) {
    console.error('team-sync.embeddable-count-failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const schemaVersion = Number(env.MYCO_SCHEMA_VERSION ?? '');
  const syncProtocolVersion = Number(env.SYNC_PROTOCOL_VERSION ?? '');

  return jsonResponse({
    generated_at: epochSeconds(),
    total_records: totalRecords,
    tables,
    machine_id: machineId ?? undefined,
    machine_tables: machine_tables ?? undefined,
    vector_count: vectorCount,
    vector_index_healthy: vectorIndexHealthy,
    vector_index_error: vectorIndexError,
    embeddable_count: embeddableCount,
    schema_version: Number.isFinite(schemaVersion) ? schemaVersion : null,
    package_version: env.MYCO_TEAM_PACKAGE_VERSION ?? DEFAULT_TEAM_PACKAGE_VERSION,
    sync_protocol_version: Number.isFinite(syncProtocolVersion) ? syncProtocolVersion : 0,
  });
}

/**
 * `GET /manifest` — content-addressed drift summary for symmetric reconcile.
 *
 * Returns a cheap aggregate (summary=1) or cursor-paged item list for a
 * (machine_id, table[, project_id]) partition. Purely read-only — no writes
 * to D1. All reconcile decisions live daemon-side.
 */
async function handleManifest(request: Request, env: Env): Promise<Response> {
  const params = parseManifestParams(new URL(request.url));
  if ('error' in params) {
    return errorResponse(params.error, params.status);
  }
  const result = await queryManifest(env.MYCO_TEAM_DB, params);
  return jsonResponse(result);
}

/**
 * `GET /members` — the team's member roster, synced from every node's
 * local `team_members` rows. Returns the union across all machines so the
 * daemon can render the Members tab for the selected team rather than the
 * local self-only roster.
 */
async function handleListMembers(env: Env): Promise<Response> {
  try {
    const { results } = await env.MYCO_TEAM_DB
      .prepare(`SELECT id, machine_id, "user", role, joined, tags, synced_at FROM team_members ORDER BY "user" ASC, machine_id ASC`)
      .all<{ id: string; machine_id: string; user: string; role: string | null; joined: string | null; tags: string | null; synced_at: number | null }>();
    return jsonResponse({ members: results ?? [] });
  } catch {
    // team_members may not exist on a worker deployed before the schema migration.
    return jsonResponse({ members: [] });
  }
}

/**
 * `DELETE /members/:machine_id` — drop a single machine's roster row. Called
 * when a teammate leaves the team so the departing machine stops lingering as
 * a ghost member in everyone else's view.
 *
 * Trust model: the worker authenticates every request with a SHARED team key
 * and carries no per-machine identity, so it cannot enforce "delete only your
 * own row" — any holder of the key can remove any machine_id. This is the same
 * trust level as `/enqueue` (which already accepts an arbitrary machine_id) and
 * `/rebuild`. The blast radius is bounded because removal is self-healing: an
 * active member re-pushes its self-row on the next reconcile, so an erroneous
 * delete corrects itself rather than permanently dropping a live machine.
 */
async function handleRemoveMember(machineId: string, env: Env): Promise<Response> {
  if (!machineId) return errorResponse('machine_id is required', 400);
  try {
    const res = await env.MYCO_TEAM_DB
      .prepare('DELETE FROM team_members WHERE machine_id = ?')
      .bind(machineId)
      .run();
    return jsonResponse({ removed: res.meta?.changes ?? 0 });
  } catch {
    // team_members may not exist on a worker deployed before the schema migration.
    return jsonResponse({ removed: 0 });
  }
}

/**
 * `POST /rebuild` — destructive one-way repair. Truncates the requesting
 * machine's rows from this Grove's D1 tables and clears their Vectorize
 * entries so the daemon can re-push the full local Grove (`backfillAll`)
 * and land an exact mirror. The D1 is shared across team machines (rows
 * keyed by `(id, machine_id)`) and the daemon only re-pushes the local
 * machine's data, so the wipe is scoped to `body.machine_id` — never the
 * whole Grove — to avoid destroying teammates' cloud data. The local
 * Grove is the source of truth; this never reconciles, it replaces.
 */
async function handleRebuild(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { machine_id?: string };
  const machineId = typeof body.machine_id === 'string' ? body.machine_id.trim() : '';
  if (!machineId) return errorResponse('machine_id is required', 400);

  // Clear Vectorize for embeddable tables first (best-effort, non-fatal):
  // collect this machine's D1 ids and delete their vectors by deterministic id.
  for (const table of Object.keys(EMBEDDABLE_TABLES)) {
    try {
      const rows = await env.MYCO_TEAM_DB.prepare(
        `SELECT id, machine_id FROM ${table} WHERE machine_id = ?`,
      ).bind(machineId).all<{ id: string; machine_id: string }>();
      const ids: string[] = [];
      for (const r of rows.results ?? []) {
        ids.push(await vectorId(table, String(r.id), String(r.machine_id)));
        ids.push(legacyVectorId(table, String(r.id), String(r.machine_id)));
      }
      for (let i = 0; i < ids.length; i += 1000) {
        await env.MYCO_TEAM_VECTORS.deleteByIds(ids.slice(i, i + 1000));
      }
    } catch (err) {
      console.error('team-sync.rebuild.vector-clear-failed', {
        table, error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Truncate this machine's rows from every D1 table in one batch.
  const statements = SYNCED_TABLES.map((t) =>
    env.MYCO_TEAM_DB.prepare(`DELETE FROM ${t} WHERE machine_id = ?`).bind(machineId),
  );
  await env.MYCO_TEAM_DB.batch(statements);

  // Rebuild re-baselines everything, so reset the queue-health counters too
  // — otherwise `backlog = enqueued - processed` stays skewed by pre-rebuild
  // history and requires a manual D1 reset. Best-effort: never fail the
  // rebuild on a stats write. Leave last_run_at/last_embed_at — they're clocks.
  try {
    await env.MYCO_TEAM_DB.prepare(
      `UPDATE team_sync_stats
          SET enqueued = 0, processed = 0, failed = 0,
              embed_ok = 0, embed_failed = 0,
              last_error = NULL, last_embed_error = NULL
        WHERE id = 1`,
    ).run();
  } catch (err) {
    console.error('team-sync.rebuild.stats-reset-failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  console.error('team-sync.rebuild.completed', { machine_id: machineId, truncated_tables: SYNCED_TABLES.length });
  return jsonResponse({ ok: true, machine_id: machineId, truncated_tables: SYNCED_TABLES.length });
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

/**
 * Operator surface for queue diagnostics + DLQ management. All endpoints
 * read from the D1 tables populated by the queue consumer (team_sync_stats,
 * team_dlq). No CF API token required — the worker is the API surface.
 */
async function handleQueueStats(env: Env): Promise<Response> {
  const row = await env.MYCO_TEAM_DB.prepare(
    `SELECT enqueued, processed, failed, last_run_at, last_error, embed_ok, embed_failed, last_embed_error, last_embed_at FROM team_sync_stats WHERE id = 1`,
  ).first<{ enqueued: number; processed: number; failed: number; last_run_at: number | null; last_error: string | null; embed_ok: number; embed_failed: number; last_embed_error: string | null; last_embed_at: number | null }>();
  const enqueued = row?.enqueued ?? 0;
  const processed = row?.processed ?? 0;
  return jsonResponse({
    enqueued,
    processed,
    failed: row?.failed ?? 0,
    backlog: Math.max(0, enqueued - processed),
    last_run_at: row?.last_run_at ?? null,
    last_error: row?.last_error ?? null,
    embed_ok: row?.embed_ok ?? 0,
    embed_failed: row?.embed_failed ?? 0,
    last_embed_error: row?.last_embed_error ?? null,
    last_embed_at: row?.last_embed_at ?? null,
  });
}

async function handleDlqList(request: Request, env: Env): Promise<Response> {
  const limit = Number(new URL(request.url).searchParams.get('limit') ?? '50');
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 500) : 50;
  const rows = await env.MYCO_TEAM_DB.prepare(
    `SELECT lease_id, table_name, row_id, machine_id, operation, reason, created_at FROM team_dlq ORDER BY created_at DESC LIMIT ?`,
  ).bind(safeLimit).all<{ lease_id: string; table_name: string; row_id: string; machine_id: string; operation: string; reason: string; created_at: number }>();
  return jsonResponse({ messages: rows.results ?? [] });
}

async function handleDlqRetry(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { lease_ids?: string[] };
  const leaseIds = Array.isArray(body.lease_ids)
    ? body.lease_ids.filter((id): id is string => typeof id === 'string')
    : [];
  if (leaseIds.length === 0) {
    return errorResponse('lease_ids array is required', 400);
  }
  const placeholders = leaseIds.map(() => '?').join(', ');
  const rows = await env.MYCO_TEAM_DB.prepare(
    `SELECT lease_id, payload FROM team_dlq WHERE lease_id IN (${placeholders})`,
  ).bind(...leaseIds).all<{ lease_id: string; payload: string }>();
  const found = rows.results ?? [];
  if (found.length > 0) {
    await sendQueueRecords(env, found.map((r) => JSON.parse(r.payload) as SyncRecord));
    const retriedIds = found.map((r) => r.lease_id);
    const delPlaceholders = retriedIds.map(() => '?').join(', ');
    await env.MYCO_TEAM_DB.prepare(
      `DELETE FROM team_dlq WHERE lease_id IN (${delPlaceholders})`,
    ).bind(...retriedIds).run();
  }
  return jsonResponse({ retried: found.length });
}

async function handleDlqDiscard(request: Request, env: Env): Promise<Response> {
  const body = await request.json() as { lease_ids?: string[] };
  const leaseIds = Array.isArray(body.lease_ids)
    ? body.lease_ids.filter((id): id is string => typeof id === 'string')
    : [];
  if (leaseIds.length === 0) {
    return errorResponse('lease_ids array is required', 400);
  }
  const placeholders = leaseIds.map(() => '?').join(', ');
  await env.MYCO_TEAM_DB.prepare(
    `DELETE FROM team_dlq WHERE lease_id IN (${placeholders})`,
  ).bind(...leaseIds).run();
  return jsonResponse({ discarded: leaseIds.length });
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
          await initD1Schema(env.MYCO_TEAM_DB, { minClientVersion: resolveProtocolBounds(env).minClientVersion });
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
        await initD1Schema(env.MYCO_TEAM_DB, { minClientVersion: resolveProtocolBounds(env).minClientVersion });
        schemaInitialized = true;
      }

      // Token rotation — authenticated with team API key
      if (path === '/mcp/rotate' && method === 'POST') {
        const rotateAuthError = await validateAuth(request, env);
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
    const authError = await validateAuth(request, env);
    if (authError) return authError;

    if (!schemaInitialized) {
      await initD1Schema(env.MYCO_TEAM_DB, { minClientVersion: resolveProtocolBounds(env).minClientVersion });
      schemaInitialized = true;
    }

    try {
      if (method === 'POST' && path === '/connect') {
        return await handleConnect(request, env);
      }
      if (method === 'POST' && path === '/enqueue') {
        return await handleEnqueue(request, env);
      }
      if (method === 'POST' && path === '/rebuild') {
        return await handleRebuild(request, env);
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
      if (method === 'GET' && path === '/queue-stats') {
        return await handleQueueStats(env);
      }
      if (method === 'GET' && path === '/sync-summary') {
        return await handleSyncSummary(request, env);
      }
      if (method === 'GET' && path === '/manifest') {
        return await handleManifest(request, env);
      }
      if (method === 'GET' && path === '/members') {
        return await handleListMembers(env);
      }
      // A departing machine removes its own roster row so it stops appearing
      // as a ghost member in every teammate's view (mirrors /records/ parse).
      if (method === 'DELETE' && path.startsWith('/members/')) {
        const segments = path.split('/').filter(Boolean); // ['members', ':machine_id']
        if (segments.length === 2) {
          return await handleRemoveMember(decodeURIComponent(segments[1]), env);
        }
        return errorResponse('Not found', 404);
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
      return errorResponse('Not found', 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(message, 500);
    }
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
