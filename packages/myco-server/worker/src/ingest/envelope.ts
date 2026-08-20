import { utf8 } from '../hash.js';
import { MAX_CLOCK_SKEW_MS } from '../constants.js';
import { refusal, type Refusal } from '../telemetry.js';

export const MAX_PAYLOAD_BYTES = 262_144;
export const MAX_ID_CHARS = 128;
export const MAX_PAYLOAD_DEPTH = 32;
export const MAX_PAYLOAD_NODES = 100_000;
/** Member-minted logical ids: 36-character lowercase UUIDs; the server checks the grammar, not the version. */
export const ID_GRAMMAR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Producer identifiers: adapter names and member versions. */
export const PRODUCER_GRAMMAR = /^[A-Za-z0-9._-]{1,64}$/;

/** The one clock rule: a caller-supplied instant is ahead of the clock when it stands more than the skew bound past the server's `now`. The envelope's `createdAt` and every ordering field of the catalogue are held to it. */
export const aheadOfClock = (value: number, now: number): boolean => value > now + MAX_CLOCK_SKEW_MS;
/** The refusal text for a value the clock rule refuses, by field name. */
export const AHEAD_OF_CLOCK = (field: string): string => `${field} is more than ${MAX_CLOCK_SKEW_MS} ms ahead of the server clock`;

/** The refusal a member sees when a payload is over the cap; it names the route that takes large content. */
export const PAYLOAD_CAP_REASON = `payload exceeds ${MAX_PAYLOAD_BYTES} bytes; spill to POST /blobs/{sha256} and reference it`;

export type Channel = 'cli' | 'http';

export interface Producer {
  adapter: string;
  version: string;
}

export interface CaptureEnvelope {
  eventId: string;
  sessionId: string;
  kind: string;
  createdAt: number;
  channel: Channel;
  producer: Producer;
  payload: unknown;
  payloadJson: string;
  payloadBytes: Uint8Array;
}

export type Refused = { ok: false } & Refusal;
export type ParseResult = { ok: true; value: CaptureEnvelope } | Refused;
const refused = (reason: string, classifier?: Refusal['classifier']): Refused => ({ ok: false, ...refusal(reason, classifier) });

const CHANNELS = new Set(['cli', 'http']);
/** The closed envelope: every field it carries, and every field of its producer block. The envelope digest covers all of them but `eventId`, which is the key. */
export const ENVELOPE_FIELDS = ['eventId', 'sessionId', 'kind', 'createdAt', 'channel', 'producer', 'payload'] as const;
export const PRODUCER_FIELDS = ['adapter', 'version'] as const;
const FIELDS = new Set<string>(ENVELOPE_FIELDS);
const PRODUCER_FIELD_SET = new Set<string>(PRODUCER_FIELDS);

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
function checkPayload(payload: unknown): { ok: true; json: string; bytes: Uint8Array } | Refused {
  try {
    const violation = payloadBoundViolation(payload);
    if (violation !== null) return refused(violation);
    const json = JSON.stringify(payload);
    if (json.length > MAX_PAYLOAD_BYTES) return refused(PAYLOAD_CAP_REASON);
    const bytes = utf8(json);
    if (bytes.byteLength > MAX_PAYLOAD_BYTES) return refused(PAYLOAD_CAP_REASON);
    return { ok: true, json, bytes };
  } catch (err) {
    if (err instanceof RangeError) return refused('payload exceeds inspection limits');
    throw err;
  }
}

/** Validates the closed envelope: fields, id grammar, producer, a caller time no further ahead of the server clock than the skew bound, channel, and the payload bounds. */
export function parseEnvelope(input: unknown, now: number): ParseResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return refused('envelope must be an object');
  const raw = input as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!FIELDS.has(key)) return refused(`unknown field ${key}`, 'unknown_field');
  }
  for (const field of ['eventId', 'sessionId', 'kind'] as const) {
    const v = raw[field];
    if (typeof v !== 'string' || v === '') return refused(`${field} must be a non-empty string`);
    if (v.length > MAX_ID_CHARS) return refused(`${field} exceeds ${MAX_ID_CHARS} characters`);
  }
  if (!ID_GRAMMAR.test(raw.eventId as string)) return refused('eventId must match the id grammar', 'id_grammar');
  const producer = parseProducer(raw.producer);
  if (!producer.ok) return producer;
  if (typeof raw.createdAt !== 'number' || !Number.isSafeInteger(raw.createdAt) || raw.createdAt < 0) {
    return refused('createdAt must be a non-negative integer');
  }
  if (aheadOfClock(raw.createdAt, now)) return refused(AHEAD_OF_CLOCK('createdAt'), 'clock_skew');
  if (typeof raw.channel !== 'string' || !CHANNELS.has(raw.channel)) {
    return refused('channel must be "cli" or "http"');
  }

  const payload = raw.payload ?? null;
  const checked = checkPayload(payload);
  if (!checked.ok) return checked;

  return {
    ok: true,
    value: {
      eventId: raw.eventId as string,
      sessionId: raw.sessionId as string,
      kind: raw.kind as string,
      createdAt: raw.createdAt,
      channel: raw.channel as Channel,
      producer: producer.value,
      payload,
      payloadJson: checked.json,
      payloadBytes: checked.bytes,
    },
  };
}

/** The required producer block: adapter name and member version, both identifiers. */
function parseProducer(input: unknown): { ok: true; value: Producer } | Refused {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return refused('producer must be an object');
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!PRODUCER_FIELD_SET.has(key)) return refused(`unknown field producer.${key}`, 'unknown_field');
  }
  for (const field of ['adapter', 'version'] as const) {
    const v = raw[field];
    if (typeof v !== 'string' || !PRODUCER_GRAMMAR.test(v)) return refused(`producer.${field} must be an identifier of at most 64 characters`);
  }
  return { ok: true, value: { adapter: raw.adapter as string, version: raw.version as string } };
}
