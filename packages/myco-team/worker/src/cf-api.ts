/**
 * Cloudflare Queues HTTP-API helpers.
 *
 * The Workers Queues binding doesn't expose queue-depth, in-flight, or
 * dead-letter inspection from inside a Worker — that's only available
 * via the Cloudflare REST API at api.cloudflare.com. We call it from
 * the Worker (server-side) so the API token never leaves the cloud
 * boundary. The token is stashed in KV at runtime via the
 * `POST /tokens/cf-api` endpoint; UI flows for setting it live in the
 * Team page Outbox tab.
 */

export const CF_API_TOKEN_KV = 'cf_queues_api_token';
export const CF_ACCOUNT_ID_KV = 'cf_account_id';

export interface QueueStats {
  /**
   * Approximate number of messages currently in the queue.
   * `null` means the metric is not available — today every value is null
   * because CF Queues exposes backlog metrics only via GraphQL Analytics
   * (separate API not yet wired). The UI renders "—" rather than "0" so
   * an empty stat doesn't masquerade as a healthy zero.
   */
  depth: number | null;
  /** Age (epoch seconds) of the oldest in-queue message, or null if unknown. */
  oldest_msg_age_s: number | null;
}

export interface QueueStatsResponse {
  main: QueueStats;
  dlq: QueueStats;
}

export interface DlqMessage {
  /** CF-issued message id used for ack/retry/discard. */
  msg_id: string;
  /** Original SyncRecord body. */
  body: Record<string, unknown>;
  /** Number of retry attempts before reaching DLQ. */
  attempts: number;
  /** Last failure reason, if reported by CF. */
  last_failure?: string;
  /** When the message was first enqueued (epoch seconds). */
  enqueued_at?: number;
}

export interface DlqListResponse {
  messages: DlqMessage[];
  next_cursor: string | null;
}

/** Read the configured CF API token + account id from KV. Returns null if unset. */
export async function readCfApiCredentials(
  kv: KVNamespace,
): Promise<{ token: string; accountId: string } | null> {
  const [token, accountId] = await Promise.all([kv.get(CF_API_TOKEN_KV), kv.get(CF_ACCOUNT_ID_KV)]);
  if (!token || !accountId) return null;
  return { token, accountId };
}

/** Persist the CF API token + account id pair so subsequent calls can use them. */
export async function writeCfApiCredentials(
  kv: KVNamespace,
  token: string,
  accountId: string,
): Promise<void> {
  await Promise.all([kv.put(CF_API_TOKEN_KV, token), kv.put(CF_ACCOUNT_ID_KV, accountId)]);
}

/** Remove the CF API token + account id from KV so the operator surface re-prompts. */
export async function clearCfApiCredentials(kv: KVNamespace): Promise<void> {
  await Promise.all([kv.delete(CF_API_TOKEN_KV), kv.delete(CF_ACCOUNT_ID_KV)]);
}

/**
 * Fetch queue depth + oldest-message age for both the sync queue and its DLQ.
 *
 * Throws on transport / auth failure. Callers (the daemon proxy) should
 * surface a structured error so the UI can show "Configure token" or
 * "API call failed" without crashing the Team page.
 */
export async function fetchQueueStats(
  creds: { token: string; accountId: string },
  syncQueueName: string,
  dlqName: string,
): Promise<QueueStatsResponse> {
  const [main, dlq] = await Promise.all([
    fetchQueueStatsForQueue(creds, syncQueueName),
    fetchQueueStatsForQueue(creds, dlqName),
  ]);
  return { main, dlq };
}

async function fetchQueueStatsForQueue(
  creds: { token: string; accountId: string },
  queueName: string,
): Promise<QueueStats> {
  // CF returns queue metadata + GraphQL-ish backlog metrics on the queues
  // GET endpoint. The exact shape varies by CF API version; we read what's
  // documented and tolerate missing fields.
  const url = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/queues?name=${encodeURIComponent(queueName)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`CF queues list failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json() as { result?: Array<{ producers_total_count?: number; consumers_total_count?: number; queue_id?: string }> };
  const queue = body.result?.[0];
  if (!queue) {
    throw new Error(`CF queue not found: ${queueName}`);
  }
  // Backlog stats live behind the CF Queues GraphQL Analytics endpoint
  // which isn't wired yet. Return null/null so the UI clearly distinguishes
  // "stat not yet available" from "queue is empty" — emitting `0` here
  // would silently lie when a queue is actually backed up.
  return { depth: null, oldest_msg_age_s: null };
}

/**
 * Pull a page of DLQ messages. Uses the CF Queues HTTP pull-consumer API.
 *
 * The lease is owned by this fetch — the caller decides which messages to
 * retry (via `retryDlqMessages`) or discard (via `discardDlqMessages`)
 * before the lease expires.
 */
export async function pullDlqMessages(
  creds: { token: string; accountId: string },
  dlqName: string,
  limit: number,
): Promise<DlqListResponse> {
  const queueId = await resolveQueueId(creds, dlqName);
  const url = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/queues/${queueId}/messages/pull`;
  const batchSize = Math.min(Math.max(limit, 1), 100);
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    // Visibility timeout is human-paced: an operator inspects the DLQ row
    // and decides whether to retry/discard, possibly after a coffee break.
    // 5 min is long enough to not surprise the user; CF max is 12h if we
    // ever need to support batch operator review.
    body: JSON.stringify({ batch_size: batchSize, visibility_timeout_ms: 5 * 60 * 1000 }),
  });
  if (!res.ok) {
    throw new Error(`CF queues pull failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json() as {
    result?: { messages?: Array<{ lease_id?: string; body?: unknown; attempts?: number; metadata?: Record<string, unknown> }> };
  };
  const messages: DlqMessage[] = (body.result?.messages ?? []).map((m) => ({
    msg_id: String(m.lease_id ?? ''),
    body: (m.body ?? {}) as Record<string, unknown>,
    attempts: m.attempts ?? 0,
    last_failure: typeof m.metadata?.last_failure === 'string' ? m.metadata.last_failure : undefined,
    enqueued_at: typeof m.metadata?.enqueued_at === 'number' ? m.metadata.enqueued_at : undefined,
  }));
  return { messages, next_cursor: null };
}

/** Re-publish DLQ messages back to the main sync queue. */
export async function retryDlqMessages(
  creds: { token: string; accountId: string },
  dlqName: string,
  leaseIds: string[],
): Promise<void> {
  const queueId = await resolveQueueId(creds, dlqName);
  const url = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/queues/${queueId}/messages/ack`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      acks: [],
      retries: leaseIds.map((id) => ({ lease_id: id, delay_seconds: 0 })),
    }),
  });
  if (!res.ok) {
    throw new Error(`CF queues retry failed: ${res.status} ${await res.text()}`);
  }
}

/** Permanently ack DLQ messages so they're removed from the queue. */
export async function discardDlqMessages(
  creds: { token: string; accountId: string },
  dlqName: string,
  leaseIds: string[],
): Promise<void> {
  const queueId = await resolveQueueId(creds, dlqName);
  const url = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/queues/${queueId}/messages/ack`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      acks: leaseIds.map((id) => ({ lease_id: id })),
      retries: [],
    }),
  });
  if (!res.ok) {
    throw new Error(`CF queues discard failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * TTL'd queue-id cache with single-flight dedup.
 *
 * - 10-minute TTL so a recreated queue (e.g. after destroy + reinstall)
 *   eventually heals without a Worker redeploy.
 * - In-flight Promise dedup so concurrent DLQ requests on a cold isolate
 *   share a single CF API call instead of racing.
 * - Callers can invoke `invalidateQueueIdCache(queueName)` on a 404 from
 *   any downstream API to force a refetch on the next call.
 */
const QUEUE_ID_CACHE_TTL_MS = 10 * 60 * 1000;
const queueIdCache = new Map<string, { id: string; expires_at: number }>();
const queueIdInFlight = new Map<string, Promise<string>>();

export function invalidateQueueIdCache(queueName: string): void {
  queueIdCache.delete(queueName);
  queueIdInFlight.delete(queueName);
}

async function resolveQueueId(
  creds: { token: string; accountId: string },
  queueName: string,
): Promise<string> {
  const cached = queueIdCache.get(queueName);
  if (cached && cached.expires_at > Date.now()) return cached.id;

  const inFlight = queueIdInFlight.get(queueName);
  if (inFlight) return inFlight;

  const fetchPromise = (async () => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${creds.accountId}/queues?name=${encodeURIComponent(queueName)}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`CF queues list failed: ${res.status} ${await res.text()}`);
    }
    const body = await res.json() as { result?: Array<{ queue_id?: string }> };
    const id = body.result?.[0]?.queue_id;
    if (!id) throw new Error(`CF queue not found: ${queueName}`);
    queueIdCache.set(queueName, { id, expires_at: Date.now() + QUEUE_ID_CACHE_TTL_MS });
    return id;
  })().finally(() => queueIdInFlight.delete(queueName));

  queueIdInFlight.set(queueName, fetchPromise);
  return fetchPromise;
}
