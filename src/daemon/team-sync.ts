/**
 * Team sync HTTP client.
 *
 * Communicates with the Cloudflare Worker to push outbox records,
 * search team knowledge, and check connection health.
 */

import type { OutboxRow } from '@myco/db/queries/team-outbox.js';
import { TEAM_SEARCH_TIMEOUT_MS, TEAM_HEALTH_TIMEOUT_MS } from '@myco/constants.js';

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
  timeoutMs?: number;
}

export interface TeamSearchResult {
  id: string;
  table_name: string;
  content: string;
  score: number;
  machine_id: string;
  metadata?: Record<string, unknown>;
}

export interface TeamSearchResponse {
  results: TeamSearchResult[];
  machine_ids: string[];
}

export interface TeamHealthResponse {
  status: string;
  node_count: number;
  sync_protocol_version: number;
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
  mcp_token?: string;
  mcp_endpoint?: string;
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
   * Push a batch of outbox records to the team worker.
   *
   * @returns the number of records accepted by the worker.
   */
  async pushBatch(records: OutboxRow[]): Promise<{ synced: number; skipped: number; errors: Array<{ id: string; table: string; error: string }> }> {
    const res = await this.request('POST', '/sync', {
      machine_id: this.machineId,
      sync_protocol_version: this.syncProtocolVersion,
      records: records.map((r) => {
        const data = typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload;
        return {
          table: r.table_name,
          id: String(r.row_id),
          machine_id: r.machine_id,
          operation: r.operation,
          data,
          content_hash: data.content_hash ?? null,
        };
      }),
    });
    return res as { synced: number; skipped: number; errors: Array<{ id: string; table: string; error: string }> };
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

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchFn(`${this.workerUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Team sync request ${method} ${path} failed: ${res.status} ${text}`);
    }

    return res.json();
  }
}
