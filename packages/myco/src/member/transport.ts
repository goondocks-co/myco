/**
 * `ServerClient(record, fetch)`: one authenticated request primitive under
 * `postEvent`, `postBlob`, `refresh`, and `health`, with every outcome
 * classified on the status line first and the server's stable `code` second
 * — never on `reason` text. Timeouts come from the caller's budget: the
 * connect timeout bounds the wait for response headers, the request timeout
 * bounds the whole exchange.
 */
import { MEMBER_CODES, MEMBER_PROTOCOL, PARKED_CODE, PROTOCOL_HEADER, RESLICE_CODES, type MemberCode } from './constants.js';
import type { RequestBudget } from './budget.js';
import type { MemberEnvelope } from './envelope.js';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ClientRecord {
  serverUrl: string;
  token: string;
  projectId: string;
}

/** What the server answered, before classification. */
export type RawAnswer =
  | { kind: 'response'; status: number; protocolHeader: boolean; retryAfterMs?: number; json: Record<string, unknown> | null }
  | { kind: 'transport'; detail: string }
  | { kind: 'timeout'; phase: 'connect' | 'request' };

export type Outcome =
  | { class: 'acked'; duplicate?: boolean; transcript?: { size: number; segmentCount: number }; body: Record<string, unknown> }
  | { class: 'reslice'; code: MemberCode; heldSize: number }
  | { class: 'parked'; code: typeof PARKED_CODE; reason: string }
  | { class: 'refused'; code: MemberCode; reason: string }
  | { class: 'retry'; status?: number; detail: string; retryAfterMs?: number; anonymousLimited?: boolean }
  | { class: 'route_missing'; status: 401 }
  | { class: 'unauthorized'; status: 401 }
  | { class: 'protocol'; serverProtocol?: number; minCompatMemberProtocol?: number };

export type RefreshOutcome =
  | { class: 'refreshed'; token: string; tokenId: string; expiresAt: number; refreshAfter: number }
  | { class: 'refused'; code: MemberCode; reason: string; refreshAfter?: number }
  | Extract<Outcome, { class: 'retry' | 'route_missing' | 'unauthorized' | 'protocol' }>;

const EVENTS_PATH = '/events';
const BLOBS_PATH = '/blobs';
const REFRESH_PATH = '/tokens/refresh';
const HEALTH_PATH = '/health';
const JSON_CONTENT_TYPE = 'application/json';
const RETRY_AFTER_HEADER = 'retry-after';
const CODE_SET = new Set<string>(MEMBER_CODES);

const memberCode = (value: unknown): MemberCode | null => (typeof value === 'string' && CODE_SET.has(value) ? (value as MemberCode) : null);
const reasonOf = (body: Record<string, unknown> | null): string => (typeof body?.reason === 'string' ? body.reason : '');

export class ServerClient {
  private readonly base: string;
  private readonly protocol: number;

  constructor(private readonly record: ClientRecord, private readonly fetchImpl: FetchLike = globalThis.fetch, opts: { protocol?: number } = {}) {
    this.base = record.serverUrl.replace(/\/+$/, '');
    this.protocol = opts.protocol ?? MEMBER_PROTOCOL;
  }

  get projectId(): string {
    return this.record.projectId;
  }

  /** The one authenticated request: bearer + protocol header, bounded by the budget, answered raw. */
  async request(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string>; budget: RequestBudget }): Promise<RawAnswer> {
    const controller = new AbortController();
    let phase: 'connect' | 'request' = 'connect';
    let timedOut = false;
    const connectTimer = setTimeout(() => { timedOut = true; controller.abort(); }, init.budget.connectTimeoutMs);
    const requestTimer = setTimeout(() => { timedOut = true; controller.abort(); }, init.budget.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.record.token}`,
          [PROTOCOL_HEADER]: String(this.protocol),
          ...init.headers,
        },
        body: init.body,
        signal: controller.signal,
      });
      clearTimeout(connectTimer);
      phase = 'request';
      const text = await res.text();
      let json: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(text);
        json = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
      } catch { /* a non-JSON body classifies by its status alone */ }
      const retryAfter = res.headers.get(RETRY_AFTER_HEADER);
      return {
        kind: 'response',
        status: res.status,
        protocolHeader: res.headers.get(PROTOCOL_HEADER) !== null,
        retryAfterMs: retryAfter !== null && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : undefined,
        json,
      };
    } catch (err) {
      if (timedOut) return { kind: 'timeout', phase };
      return { kind: 'transport', detail: err instanceof Error ? err.message : String(err) };
    } finally {
      clearTimeout(connectTimer);
      clearTimeout(requestTimer);
    }
  }

  async postEvent(envelope: MemberEnvelope, budget: RequestBudget): Promise<Outcome> {
    const raw = await this.request('POST', EVENTS_PATH, { body: JSON.stringify(envelope), headers: { 'content-type': JSON_CONTENT_TYPE }, budget });
    return classifyEventAnswer(raw);
  }

  async postBlob(bytes: Uint8Array, sha256: string, mediaType: string, budget: RequestBudget): Promise<Outcome> {
    const raw = await this.request('POST', `${BLOBS_PATH}/${sha256}`, {
      body: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      headers: { 'content-type': mediaType, 'content-length': String(bytes.byteLength) },
      budget,
    });
    return classifyBlobAnswer(raw);
  }

  async refresh(budget: RequestBudget): Promise<RefreshOutcome> {
    const raw = await this.request('POST', REFRESH_PATH, { body: '{}', headers: { 'content-type': JSON_CONTENT_TYPE }, budget });
    return classifyRefreshAnswer(raw);
  }

  /** `GET /health` answers 200 on the public route; no credential is consulted there. */
  async health(budget: RequestBudget): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget.requestTimeoutMs);
    try {
      const res = await this.fetchImpl(`${this.base}${HEALTH_PATH}`, { method: 'GET', signal: controller.signal });
      return res.status === 200;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The classes every route shares, decided on the status line: 401 by the protocol header, 409 as protocol, 429/503/5xx/transport/timeout as retry. Null when the answer is a 200 the route classifies itself. */
function classifyCommon(raw: RawAnswer): Outcome | null {
  if (raw.kind === 'transport') return { class: 'retry', detail: raw.detail };
  if (raw.kind === 'timeout') return { class: 'retry', detail: `timeout (${raw.phase})` };
  const { status } = raw;
  if (status === 200) return null;
  if (status === 401) return raw.protocolHeader ? { class: 'route_missing', status } : { class: 'unauthorized', status };
  if (status === 409) {
    return {
      class: 'protocol',
      serverProtocol: typeof raw.json?.server_protocol === 'number' ? raw.json.server_protocol : undefined,
      minCompatMemberProtocol: typeof raw.json?.min_compat_member_protocol === 'number' ? raw.json.min_compat_member_protocol : undefined,
    };
  }
  if (status === 429) return { class: 'retry', status, detail: 'rate limited', retryAfterMs: raw.retryAfterMs, anonymousLimited: !raw.protocolHeader };
  return { class: 'retry', status, detail: `http ${status}`, retryAfterMs: raw.retryAfterMs };
}

/** A 200 on a persisted/stored route: acked, reslice, parked, or refused by code. */
function classifyShape(raw: Extract<RawAnswer, { kind: 'response' }>, shape: 'persisted' | 'stored'): Outcome {
  const body = raw.json;
  if (body === null) return { class: 'retry', status: 200, detail: 'malformed 200 body' };
  if (body[shape] === true) {
    const transcript = body.transcript as { size?: unknown; segmentCount?: unknown } | undefined;
    return {
      class: 'acked',
      duplicate: body.duplicate === true || undefined,
      transcript: transcript && typeof transcript.size === 'number' && typeof transcript.segmentCount === 'number'
        ? { size: transcript.size, segmentCount: transcript.segmentCount }
        : undefined,
      body,
    };
  }
  const code = memberCode(body.code);
  if (code === null) return { class: 'refused', code: 'refused', reason: reasonOf(body) || 'unclassified refusal' };
  if (RESLICE_CODES.includes(code)) {
    const transcript = body.transcript as { size?: unknown } | undefined;
    return { class: 'reslice', code, heldSize: typeof transcript?.size === 'number' ? transcript.size : 0 };
  }
  if (code === PARKED_CODE) return { class: 'parked', code, reason: reasonOf(body) };
  return { class: 'refused', code, reason: reasonOf(body) };
}

export function classifyEventAnswer(raw: RawAnswer): Outcome {
  return classifyCommon(raw) ?? classifyShape(raw as Extract<RawAnswer, { kind: 'response' }>, 'persisted');
}

export function classifyBlobAnswer(raw: RawAnswer): Outcome {
  return classifyCommon(raw) ?? classifyShape(raw as Extract<RawAnswer, { kind: 'response' }>, 'stored');
}

export function classifyRefreshAnswer(raw: RawAnswer): RefreshOutcome {
  const common = classifyCommon(raw);
  if (common !== null) {
    if (common.class === 'retry' || common.class === 'route_missing' || common.class === 'unauthorized' || common.class === 'protocol') return common;
    return { class: 'retry', detail: 'unexpected answer on the refresh route' };
  }
  const body = (raw as Extract<RawAnswer, { kind: 'response' }>).json;
  if (body === null) return { class: 'retry', status: 200, detail: 'malformed 200 body' };
  if (body.refreshed === true && typeof body.token === 'string' && typeof body.tokenId === 'string' && typeof body.expiresAt === 'number' && typeof body.refreshAfter === 'number') {
    return { class: 'refreshed', token: body.token, tokenId: body.tokenId, expiresAt: body.expiresAt, refreshAfter: body.refreshAfter };
  }
  const code = memberCode(body.code) ?? 'refused';
  return { class: 'refused', code, reason: reasonOf(body), refreshAfter: typeof body.refreshAfter === 'number' ? body.refreshAfter : undefined };
}
