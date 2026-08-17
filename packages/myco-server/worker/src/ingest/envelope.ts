import { utf8 } from '../hash.js';

export const MAX_PAYLOAD_BYTES = 262_144;
/** Fits a `<machine_id>:<uuid>` event id: 128-character machine ids plus a 36-character UUID and the separator, with headroom. */
export const MAX_ID_CHARS = 192;
export const MAX_PAYLOAD_DEPTH = 32;
export const MAX_PAYLOAD_NODES = 100_000;

export type Channel = 'cli' | 'http';

export interface CaptureEnvelope {
  eventId: string;
  sessionId: string;
  kind: string;
  createdAt: number;
  channel: Channel;
  payloadJson: string;
  payloadBytes: Uint8Array;
}

export type ParseResult = { ok: true; value: CaptureEnvelope } | { ok: false; reason: string };

const CHANNELS = new Set(['cli', 'http']);
const FIELDS = new Set(['eventId', 'sessionId', 'kind', 'createdAt', 'channel', 'payload']);

/** Walks the payload with one interleaved stack of value/depth pairs; returns the first bound violated or null. */
function payloadBoundViolation(value: unknown): string | null {
  const stack: unknown[] = [value, 0];
  let nodes = 0;
  while (stack.length > 0) {
    const d = stack.pop() as number;
    const v = stack.pop();
    nodes += 1;
    if (nodes > MAX_PAYLOAD_NODES) return `payload exceeds ${MAX_PAYLOAD_NODES} nodes`;
    if (typeof v !== 'object' || v === null) continue;
    if (d >= MAX_PAYLOAD_DEPTH) return `payload exceeds nesting depth ${MAX_PAYLOAD_DEPTH}`;
    const record = v as Record<string, unknown>;
    for (const key in record) {
      stack.push(record[key], d + 1);
    }
  }
  return null;
}

/** Applies the payload bounds and serializes once; the encoded bytes are returned for the byte bound and the envelope digest. A RangeError raised while inspecting is itself a bound violation. */
function checkPayload(payload: unknown): { ok: true; json: string; bytes: Uint8Array } | { ok: false; reason: string } {
  try {
    const violation = payloadBoundViolation(payload);
    if (violation !== null) return { ok: false, reason: violation };
    const json = JSON.stringify(payload);
    if (json.length > MAX_PAYLOAD_BYTES) return { ok: false, reason: `payload exceeds ${MAX_PAYLOAD_BYTES} bytes` };
    const bytes = utf8(json);
    if (bytes.byteLength > MAX_PAYLOAD_BYTES) return { ok: false, reason: `payload exceeds ${MAX_PAYLOAD_BYTES} bytes` };
    return { ok: true, json, bytes };
  } catch (err) {
    if (err instanceof RangeError) return { ok: false, reason: 'payload exceeds inspection limits' };
    throw err;
  }
}

export function parseEnvelope(input: unknown): ParseResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return { ok: false, reason: 'envelope must be an object' };
  const raw = input as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!FIELDS.has(key)) return { ok: false, reason: `unknown field ${key}` };
  }
  for (const field of ['eventId', 'sessionId', 'kind'] as const) {
    const v = raw[field];
    if (typeof v !== 'string' || v === '') return { ok: false, reason: `${field} must be a non-empty string` };
    if (v.length > MAX_ID_CHARS) return { ok: false, reason: `${field} exceeds ${MAX_ID_CHARS} characters` };
  }
  if (typeof raw.createdAt !== 'number' || !Number.isSafeInteger(raw.createdAt) || raw.createdAt < 0) {
    return { ok: false, reason: 'createdAt must be a non-negative integer' };
  }
  if (typeof raw.channel !== 'string' || !CHANNELS.has(raw.channel)) {
    return { ok: false, reason: 'channel must be "cli" or "http"' };
  }

  const checked = checkPayload(raw.payload ?? null);
  if (!checked.ok) return checked;

  return {
    ok: true,
    value: {
      eventId: raw.eventId as string,
      sessionId: raw.sessionId as string,
      kind: raw.kind as string,
      createdAt: raw.createdAt,
      channel: raw.channel as Channel,
      payloadJson: checked.json,
      payloadBytes: checked.bytes,
    },
  };
}
