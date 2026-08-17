export const MAX_PAYLOAD_BYTES = 262_144;
export const MAX_ID_CHARS = 128;
export const MAX_PAYLOAD_DEPTH = 32;
export const MAX_PAYLOAD_NODES = 100_000;

export interface CaptureEnvelope {
  eventId: string;
  sessionId: string;
  kind: string;
  createdAt: number;
  transport: 'cli' | 'http';
  payloadJson: string;
}

export type ParseResult = { ok: true; value: CaptureEnvelope } | { ok: false; reason: string };

const TRANSPORTS = new Set(['cli', 'http']);
const encoder = new TextEncoder();

/** Walks the payload with two parallel stacks, one entry at a time; returns the first bound violated or null. */
function payloadBoundViolation(value: unknown): string | null {
  const values: unknown[] = [value];
  const depths: number[] = [0];
  let nodes = 0;
  while (values.length > 0) {
    const v = values.pop();
    const d = depths.pop()!;
    nodes += 1;
    if (nodes > MAX_PAYLOAD_NODES) return `payload exceeds ${MAX_PAYLOAD_NODES} nodes`;
    if (typeof v !== 'object' || v === null) continue;
    if (d >= MAX_PAYLOAD_DEPTH) return `payload exceeds nesting depth ${MAX_PAYLOAD_DEPTH}`;
    const record = v as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      values.push(record[key]);
      depths.push(d + 1);
    }
  }
  return null;
}

/** UTF-8 byte length of a JSON string, encoding only when the character count leaves the answer in doubt. */
function utf8Bytes(json: string): number {
  if (json.length > MAX_PAYLOAD_BYTES) return json.length;
  if (json.length * 3 <= MAX_PAYLOAD_BYTES) return json.length;
  return encoder.encode(json).byteLength;
}

/** Applies the payload bounds and serializes once; a RangeError raised while inspecting is itself a bound violation. */
function checkPayload(payload: unknown): { ok: true; json: string } | { ok: false; reason: string } {
  try {
    const violation = payloadBoundViolation(payload);
    if (violation !== null) return { ok: false, reason: violation };
    const json = JSON.stringify(payload);
    if (utf8Bytes(json) > MAX_PAYLOAD_BYTES) return { ok: false, reason: `payload exceeds ${MAX_PAYLOAD_BYTES} bytes` };
    return { ok: true, json };
  } catch (err) {
    if (err instanceof RangeError) return { ok: false, reason: 'payload exceeds inspection limits' };
    throw err;
  }
}

export function parseEnvelope(input: unknown): ParseResult {
  if (typeof input !== 'object' || input === null) return { ok: false, reason: 'envelope must be an object' };
  const raw = input as Record<string, unknown>;

  for (const field of ['eventId', 'sessionId', 'kind'] as const) {
    const v = raw[field];
    if (typeof v !== 'string' || v === '') return { ok: false, reason: `${field} must be a non-empty string` };
    if (v.length > MAX_ID_CHARS) return { ok: false, reason: `${field} exceeds ${MAX_ID_CHARS} characters` };
  }
  if (typeof raw.createdAt !== 'number' || !Number.isSafeInteger(raw.createdAt) || raw.createdAt < 0) {
    return { ok: false, reason: 'createdAt must be a non-negative integer' };
  }
  if (typeof raw.transport !== 'string' || !TRANSPORTS.has(raw.transport)) {
    return { ok: false, reason: 'transport must be "cli" or "http"' };
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
      transport: raw.transport as 'cli' | 'http',
      payloadJson: checked.json,
    },
  };
}
