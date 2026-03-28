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

  constructor(options: TeamSyncClientOptions) {
    this.workerUrl = options.workerUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.machineId = options.machineId;
    this.syncProtocolVersion = options.syncProtocolVersion;
    this.fetchFn = options.fetch ?? globalThis.fetch;
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
    return res as TeamConfigResponse;
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

      return (await res.json()) as TeamHealthResponse;
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
