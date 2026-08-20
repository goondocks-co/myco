import { describe, it, expect } from 'bun:test';
import { parseEnvelope as parse, MAX_PAYLOAD_BYTES, MAX_ID_CHARS, MAX_PAYLOAD_DEPTH, MAX_PAYLOAD_NODES, PAYLOAD_CAP_REASON, ID_GRAMMAR } from '@myco-server-worker/ingest/envelope.js';
import { MAX_CLOCK_SKEW_MS } from '@myco-server-worker/constants.js';
import { envelope, uuid, PRODUCER } from './helpers/fixtures.js';

const NOW = 1_000_000;
const parseEnvelope = (input: unknown, now = NOW) => parse(input, now);
const good = envelope();

describe('envelope', () => {
  it('refuses the pre-2.0 hook body shape', () => {
    const legacy = { type: 'user_prompt_submit', prompt: 'hi', session_id: 'sess_1', agent: 'claude-code', transcript_path: '/tmp/t.jsonl' };
    const p = parseEnvelope(legacy);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe('unknown field type');
  });

  it('accepts a well-formed envelope and carries the producer', () => {
    const p = parseEnvelope(good);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value.producer).toEqual(PRODUCER);
  });

  it('names the offending field', () => {
    for (const [field, value] of [['eventId', undefined], ['kind', ''], ['channel', 'pigeon']] as const) {
      const p = parseEnvelope({ ...good, [field]: value });
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.reason).toContain(field);
    }
  });

  it('refuses any field it does not store, naming it', () => {
    for (const extra of ['machineId', 'projectId', 'tokenId', 'attachments', 'transport']) {
      const p = parseEnvelope({ ...good, [extra]: 'x' });
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.reason).toBe(`unknown field ${extra}`);
    }
    expect(parseEnvelope([good]).ok).toBe(false);
  });

  it('requires a producer block of two bounded identifiers and nothing else', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...good, producer: undefined }, 'producer must be an object'],
      [{ ...good, producer: 'claude-code' }, 'producer must be an object'],
      [{ ...good, producer: { adapter: 'claude-code' } }, 'producer.version must be an identifier of at most 64 characters'],
      [{ ...good, producer: { adapter: 'claude code', version: '1' } }, 'producer.adapter must be an identifier of at most 64 characters'],
      [{ ...good, producer: { adapter: 'a'.repeat(65), version: '1' } }, 'producer.adapter must be an identifier of at most 64 characters'],
      [{ ...good, producer: { ...PRODUCER, extra: 1 } }, 'unknown field producer.extra'],
    ];
    for (const [input, reason] of cases) {
      const p = parseEnvelope(input);
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.reason).toBe(reason);
    }
    expect(parseEnvelope({ ...good, producer: { adapter: 'migration-1.4', version: '2.0.0' } }).ok).toBe(true);
  });

  it('enforces the id grammar on eventId and bounds every identifier to 128 characters', () => {
    expect(MAX_ID_CHARS).toBe(128);
    for (const bad of ['evt_1', '1', 'x'.repeat(36), 'ABCDEF01-0000-7000-8000-000000000001', `${'m'.repeat(20)}:${uuid(1)}`]) {
      const p = parseEnvelope({ ...good, eventId: bad });
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.reason).toBe('eventId must match the id grammar');
    }
    expect(ID_GRAMMAR.test(uuid(7))).toBe(true);
    for (const field of ['sessionId', 'kind'] as const) {
      const p = parseEnvelope({ ...good, [field]: 'x'.repeat(MAX_ID_CHARS + 1) });
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.reason).toContain(field);
    }
    expect(parseEnvelope({ ...good, sessionId: 'x'.repeat(MAX_ID_CHARS) }).ok).toBe(true);
  });

  it('refuses an oversized payload, measured in UTF-8 bytes, naming the blob route', () => {
    const p = parseEnvelope({ ...good, payload: { b: 'x'.repeat(MAX_PAYLOAD_BYTES + 1) } });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe(PAYLOAD_CAP_REASON);
    expect(PAYLOAD_CAP_REASON).toContain('POST /blobs/{sha256}');
    const wide = parseEnvelope({ ...good, payload: '€'.repeat(Math.floor(MAX_PAYLOAD_BYTES / 3) + 10) });
    expect(wide.ok).toBe(false);
  });

  it('refuses a payload nested past the depth ceiling', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i <= MAX_PAYLOAD_DEPTH; i++) deep = [deep];
    const p = parseEnvelope({ ...good, payload: deep });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toContain('nesting');
    let fine: unknown = 'leaf';
    for (let i = 0; i < MAX_PAYLOAD_DEPTH; i++) fine = [fine];
    expect(parseEnvelope({ ...good, payload: fine }).ok).toBe(true);
  });

  it('refuses a wide payload past the node budget without throwing', () => {
    const p = parseEnvelope({ ...good, payload: new Array(MAX_PAYLOAD_NODES + 100_000).fill(0) });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toContain('nodes');
    expect(parseEnvelope({ ...good, payload: new Array(1_000).fill(0) }).ok).toBe(true);
  });

  it('carries the payload serialized once, with its bytes and its parsed value', () => {
    const p = parseEnvelope(good);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.value.payloadJson).toBe(JSON.stringify(good.payload));
      expect(new TextDecoder().decode(p.value.payloadBytes)).toBe(p.value.payloadJson);
      expect(p.value.payload).toEqual(good.payload);
    }
    const empty = parseEnvelope({ ...good, payload: undefined });
    if (empty.ok) expect(empty.value.payloadJson).toBe('null');
  });

  it('bounds createdAt to a non-negative integer', () => {
    for (const bad of [-1, 1.5, 1e308, Number.MAX_VALUE, Number.NaN, '5']) {
      const p = parseEnvelope({ ...good, createdAt: bad });
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.reason).toContain('createdAt');
    }
    expect(parseEnvelope({ ...good, createdAt: 0 }).ok).toBe(true);
  });

  it('refuses a createdAt further ahead of the server clock than the skew bound, and accepts one at the bound', () => {
    expect(parseEnvelope({ ...good, createdAt: NOW + MAX_CLOCK_SKEW_MS }).ok).toBe(true);
    const ahead = parseEnvelope({ ...good, createdAt: NOW + MAX_CLOCK_SKEW_MS + 1 });
    expect(ahead).toEqual({ ok: false, reason: `createdAt is more than ${MAX_CLOCK_SKEW_MS} ms ahead of the server clock`, classifier: 'clock_skew' });
  });
});
