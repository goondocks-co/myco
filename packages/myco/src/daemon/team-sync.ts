/**
 * Team sync HTTP client.
 *
 * Communicates with the Cloudflare Worker to push outbox records,
 * search team knowledge, and check connection health.
 */

import type { OutboxRow } from '@myco/db/queries/team-outbox.js';
import type {
  ReleaseConfidence,
  ReleaseStateValue,
} from '@myco/db/queries/release-provenance.js';
import {
  TEAM_SEARCH_TIMEOUT_MS,
  TEAM_HEALTH_TIMEOUT_MS,
  TEAM_REQUEST_TIMEOUT_MS,
  TEAM_SYNC_TIMEOUT_MS,
} from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeamSyncClientOptions {
  workerUrl: string;
  apiKey: string;
  machineId: string;
  syncProtocolVersion: number;
  /** Inject custom fetch for testing. */
  fetch?: typeof globalThis.fetch;
}

export interface TeamSearchOptions {
  limit?: number;
  tables?: string[];
  status?: string;
  release_state?: ReleaseStateValue;
  release_confidence?: ReleaseConfidence;
  observation_type?: string;
  since?: number;
  until?: number;
  session_id?: string;
  source_path?: string;
  name?: string;
  project_id?: string;
  timeoutMs?: number;
}

export interface TeamSearchResult {
  id: string;
  type?: string;
  table?: string;
  table_name?: string;
  title?: string;
  preview?: string;
  content?: string;
  score: number;
  machine_id: string;
  metadata?: Record<string, unknown>;
  data?: Record<string, unknown>;
  retrieve?: { tool: string; input: Record<string, unknown> };
}

export interface TeamSearchResponse {
  results: TeamSearchResult[];
  machine_ids: string[];
}

/**
 * SyncRecord operations supported on the wire. The `embed` value
 * was added in protocol v2 (queue-driven vector reindex). DlqEntry
 * payloads echo this enum, so any consumer that types DLQ rows
 * needs to handle all three values.
 */
export type SyncRecordOperation = 'upsert' | 'delete' | 'embed';

/**
 * Shape of a SyncRecord payload as it appears in the worker DLQ
 * (after JSON deserialization). Mirrors the `SyncRecord` interface
 * in `packages/myco-team/worker/src/index.ts` — kept here as the
 * daemon-side public type so `DlqMessage.body` can be narrowed.
 */
export interface DlqSyncRecordPayload {
  table: string;
  operation: SyncRecordOperation;
  id: string;
  machine_id: string;
  content_hash?: string | null;
  data?: Record<string, unknown>;
}

export interface TeamHealthResponse {
  status: string;
  node_count: number;
  sync_protocol_version: number;
  /**
   * Oldest sync protocol the worker still accepts. Optional for
   * back-compat with workers deployed before the field was added —
   * absence means the worker enforces strict-equality on the
   * server's protocol version.
   */
  min_compat_client_version?: number;
  package_version?: string;
  schema_version?: number | null;
  mcp_token_hash?: string;
}

export interface TeamConnectInfo {
  machine_id: string;
  vault_name?: string;
  agent?: string;
  version?: string;
}

export interface TeamConfigResponse {
  config: Record<string, unknown>;
  sync_protocol_version: number;
  /**
   * Oldest sync protocol the worker still accepts. Optional for
   * back-compat with workers deployed before the field was added.
   */
  min_compat_client_version?: number;
  mcp_token?: string;
  mcp_endpoint?: string;
}

export interface TeamCollectiveStatusResponse {
  connected: boolean;
  collective_url: string | null;
  project_id: string | null;
  last_settings_sync: number | null;
  last_heartbeat: number | null;
  capabilities: string[];
  settings: Record<string, unknown>;
}

export interface TeamCollectiveSettingsResponse {
  collective_enabled: boolean;
  settings: Record<string, unknown>;
  last_sync: number | null;
}

/** Per-record validation failure returned by the worker's /enqueue. */
export interface RecordRejection {
  id: string;
  table: string;
  error: string;
}

/** Worker /enqueue response shape. */
export interface EnqueueBatchResponse {
  accepted: number;
  rejected: RecordRejection[];
}

export interface QueueStatsResponse {
  enqueued: number;
  processed: number;
  failed: number;
  backlog: number;
  last_run_at: number | null;
  last_error: string | null;
}

export interface TeamRemoteSyncSummaryResponse {
  generated_at: number;
  total_records: number;
  tables: Record<string, number>;
  /** Per-table cloud row counts scoped to the requested machine_id. Absent or null when no machine_id was passed (or when talking to a pre-machine_tables worker). */
  machine_tables?: Record<string, number> | null;
  /** The machine_id used to scope machine_tables, echoed from the request. */
  machine_id?: string;
  vector_count: number | null;
  vector_index_healthy: boolean;
  vector_index_error: string | null;
  /** Rows in remote D1 the consumer would embed (active-spore + non-empty text filter). */
  embeddable_count: number | null;
  schema_version: number | null;
  package_version: string;
  sync_protocol_version: number;
}

/**
 * Single DLQ message returned by the worker's D1-backed `/dlq` endpoint.
 *
 * `DlqEntry` is exported as an alias so consumers that prefer the
 * shorter name don't have to deconflict with the @myco-team/worker
 * type name. Both alias to the same shape.
 */
export interface DlqMessage {
  lease_id: string;
  table_name: string;
  row_id: string;
  machine_id: string;
  operation: string;
  reason: string | null;
  created_at: number;
}

export type DlqEntry = DlqMessage;

export interface DlqListResponse {
  messages: DlqMessage[];
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class TeamSyncClient {
  private readonly workerUrl: string;
  private readonly apiKey: string;
  private readonly machineId: string;
  private readonly syncProtocolVersion: number;
  private readonly fetchFn: typeof globalThis.fetch;
  private mcpToken: string | null = null;
  private mcpTokenHash: string | null = null;

  constructor(options: TeamSyncClientOptions) {
    this.workerUrl = options.workerUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.machineId = options.machineId;
    this.syncProtocolVersion = options.syncProtocolVersion;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  // Must match getMcpTokenHash() in src/worker/src/mcp/auth.ts
  private static hashToken(token: string): string {
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(16).padStart(8, '0').slice(0, 8);
  }

  /**
   * Register this machine with the team worker.
   */
  async connect(info: TeamConnectInfo): Promise<TeamConfigResponse> {
    const res = await this.request('POST', '/connect', {
      ...info,
      machine_id: this.machineId,
      sync_protocol_version: this.syncProtocolVersion,
    });
    const response = res as TeamConfigResponse;
    if (response.mcp_token) {
      this.mcpToken = response.mcp_token;
      this.mcpTokenHash = TeamSyncClient.hashToken(response.mcp_token);
    }
    return response;
  }

  /**
   * Hand a batch of outbox records off to the team worker's sync queue.
   *
   * The worker validates table names up-front and fans the rest into
   * Cloudflare Queues; the queue consumer (also part of the worker) does
   * the actual D1 + Vectorize writes. Daemon-side retry semantics shrink
   * to "did the handoff succeed?" — once the worker accepts the payload,
   * Cloudflare's queue runtime owns delivery, retries, and DLQ.
   *
   * @returns counts and per-record rejections (validation failures only —
   *   downstream queue failures land in the DLQ, not in this response).
   */
  async enqueueBatch(records: OutboxRow[]): Promise<EnqueueBatchResponse> {
    const res = await this.request('POST', '/enqueue', {
      machine_id: this.machineId,
      sync_protocol_version: this.syncProtocolVersion,
      records: records.map((r) => ({
        table: r.table_name,
        id: String(r.row_id),
        machine_id: r.machine_id,
        operation: r.operation,
        data: r.payload,
        content_hash: r.payload.content_hash ?? null,
      })),
    }, { timeoutMs: TEAM_SYNC_TIMEOUT_MS });
    const body = res as Partial<EnqueueBatchResponse>;
    return {
      accepted: body.accepted ?? 0,
      rejected: body.rejected ?? [],
    };
  }

  /**
   * Search team knowledge across all connected machines.
   *
   * Uses AbortController for timeout enforcement.
   */
  async search(query: string, options: TeamSearchOptions = {}): Promise<TeamSearchResponse> {
    const timeoutMs = options.timeoutMs ?? TEAM_SEARCH_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const params = new URLSearchParams({ q: query });
      if (options.limit) params.set('limit', String(options.limit));
      if (options.tables) params.set('tables', options.tables.join(','));
      if (options.status) params.set('status', options.status);
      if (options.release_state) params.set('release_state', options.release_state);
      if (options.release_confidence) params.set('release_confidence', options.release_confidence);
      if (options.observation_type) params.set('observation_type', options.observation_type);
      if (options.since !== undefined) params.set('since', String(options.since));
      if (options.until !== undefined) params.set('until', String(options.until));
      if (options.session_id) params.set('session_id', options.session_id);
      if (options.source_path) params.set('source_path', options.source_path);
      if (options.name) params.set('name', options.name);
      if (options.project_id) params.set('project_id', options.project_id);

      const res = await this.fetchFn(`${this.workerUrl}/search?${params}`, {
        method: 'GET',
        headers: this.headers(),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Team search failed: ${res.status} ${res.statusText}`);
      }

      return (await res.json()) as TeamSearchResponse;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Check worker health.
   */
  async health(): Promise<TeamHealthResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEAM_HEALTH_TIMEOUT_MS);

    try {
      const res = await this.fetchFn(`${this.workerUrl}/health`, {
        method: 'GET',
        headers: this.headers(),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Health check failed: ${res.status} ${res.statusText}`);
      }

      const data = (await res.json()) as TeamHealthResponse;

      // If the worker reports a different token hash than we have cached,
      // reconnect to fetch the token. This handles three cases:
      //   1. Initial hydration — worker has a token but we haven't fetched it yet
      //      (e.g. daemon started before worker upgrade)
      //   2. Token rotation — worker has a new token
      //   3. Worker switched — hash differs from any previously known value
      if (data.mcp_token_hash && data.mcp_token_hash !== this.mcpTokenHash) {
        try {
          await this.connect({ machine_id: this.machineId });
        } catch {
          // Non-fatal: token will be picked up on next connect
        }
      }

      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Get team configuration from the worker.
   */
  async getConfig(): Promise<TeamConfigResponse> {
    const res = await this.request('GET', '/config');
    return res as TeamConfigResponse;
  }

  async getCollectiveStatus(): Promise<TeamCollectiveStatusResponse> {
    const res = await this.request('GET', '/collective/status');
    return res as TeamCollectiveStatusResponse;
  }

  async getCollectiveSettings(): Promise<TeamCollectiveSettingsResponse> {
    const res = await this.request('GET', '/collective/settings');
    return res as TeamCollectiveSettingsResponse;
  }

  async collectiveQuery<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const res = await this.request('POST', '/collective/query', { tool, args });
    return res as T;
  }

  /**
   * Fetch queue processing stats from the worker's D1-backed endpoint.
   */
  async getQueueStats(): Promise<QueueStatsResponse> {
    return await this.request('GET', '/queue-stats') as QueueStatsResponse;
  }

  async getSyncSummary(machineId?: string): Promise<TeamRemoteSyncSummaryResponse> {
    const path = machineId
      ? `/sync-summary?machine_id=${encodeURIComponent(machineId)}`
      : '/sync-summary';
    return await this.request('GET', path) as TeamRemoteSyncSummaryResponse;
  }

  /**
   * Ask the worker to enqueue per-row `embed` jobs for every embeddable
   * row in D1. The worker returns immediately with the queued count;
   * the queue consumer drains in the background and the Vectorize
   * count climbs as rows are embedded.
   */
  async enqueueVectorReindex(): Promise<{ enqueued: number; by_table: Record<string, number> }> {
    return await this.request('POST', '/vectors/reindex', {}) as {
      enqueued: number;
      by_table: Record<string, number>;
    };
  }

  /** List a page of DLQ messages from the worker's D1-backed endpoint. */
  async listDlq(limit = 50): Promise<DlqListResponse> {
    return await this.request('GET', `/dlq?limit=${limit}`) as DlqListResponse;
  }

  /** Re-publish DLQ messages back onto the main queue. */
  async retryDlq(leaseIds: string[]): Promise<{ retried: number }> {
    return await this.request('POST', '/dlq/retry', { lease_ids: leaseIds }) as { retried: number };
  }

  /**
   * Truncate THIS machine's rows in the Grove's cloud mirror (D1 + Vectorize)
   * so the daemon can re-push this machine's full local Grove. One-way repair;
   * never reconciles. Worker scopes all deletes to the supplied machine_id.
   */
  async rebuild(): Promise<void> {
    await this.request('POST', '/rebuild', { machine_id: this.machineId });
  }

  /** Permanently discard DLQ messages. */
  async discardDlq(leaseIds: string[]): Promise<{ discarded: number }> {
    return await this.request('POST', '/dlq/discard', { lease_ids: leaseIds }) as { discarded: number };
  }

  /**
   * Fetch a single record by id from the team worker.
   *
   * Used by entity get fallbacks: when `handleGetSession` /
   * `handleGetSpore` returns a local miss we try the team's D1 copy before
   * surfacing a 404. Fallback semantics — never throws; any failure (404,
   * network, auth, malformed response) returns `null` so the caller can
   * decide what to do with the miss.
   */
  async getRecord(
    type: string,
    id: string,
  ): Promise<Record<string, unknown> | null> {
    try {
      const res = (await this.request('GET', `/records/${type}/${encodeURIComponent(id)}`)) as
        | { record?: Record<string, unknown> }
        | undefined;
      return res?.record ?? null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // MCP token accessors
  // ---------------------------------------------------------------------------

  getMcpToken(): string | null {
    return this.mcpToken;
  }

  getMcpEndpoint(): string | null {
    if (!this.mcpToken) return null;
    return `${this.workerUrl}/mcp`;
  }

  async rotateMcpToken(): Promise<string> {
    const result = await this.request('POST', '/mcp/rotate') as { token: string };
    this.mcpToken = result.token;
    this.mcpTokenHash = TeamSyncClient.hashToken(result.token);
    return result.token;
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    options: { timeoutMs?: number; passthroughStatuses?: number[] } = {},
  ): Promise<unknown> {
    const timeoutMs = options.timeoutMs ?? TEAM_REQUEST_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await this.fetchFn(`${this.workerUrl}${path}`, {
        method,
        headers: this.headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      // passthroughStatuses allow the caller to inspect the body of specific
      // non-2xx responses rather than having them throw.
      if (!res.ok && !options.passthroughStatuses?.includes(res.status)) {
        const text = await res.text().catch(() => '');
        throw new Error(`Team sync request ${method} ${path} failed: ${res.status} ${text}`);
      }

      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
