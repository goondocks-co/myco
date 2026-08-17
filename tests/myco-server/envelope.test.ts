import { describe, it, expect } from 'bun:test';
import { parseEnvelope, MAX_PAYLOAD_BYTES, MAX_ID_CHARS, MAX_PAYLOAD_DEPTH, MAX_PAYLOAD_NODES } from '@myco-server-worker/ingest/envelope.js';

const good = { eventId: 'evt_1', sessionId: 'sess_1', kind: 'prompt', createdAt: 1_000, channel: 'cli', payload: { text: 'hi' } };

describe('envelope', () => {
  it('refuses the pre-2.0 hook body shape', () => {
    const legacy = { type: 'user_prompt_submit', prompt: 'hi', session_id: 'sess_1', agent: 'claude-code', transcript_path: '/tmp/t.jsonl' };
    const p = parseEnvelope(legacy);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe('unknown field type');
  });

  it('accepts a well-formed envelope', () => {
    const p = parseEnvelope(good);
    expect(p.ok).toBe(true);
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

  it('bounds identifier length to fit a machine id and a uuid', () => {
    expect(MAX_ID_CHARS).toBeGreaterThanOrEqual(128 + 1 + 36);
    for (const field of ['eventId', 'sessionId', 'kind'] as const) {
      const p = parseEnvelope({ ...good, [field]: 'x'.repeat(MAX_ID_CHARS + 1) });
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.reason).toContain(field);
    }
    expect(parseEnvelope({ ...good, eventId: `${'m'.repeat(128)}:${'0'.repeat(36)}` }).ok).toBe(true);
  });

  it('refuses an oversized payload, measured in UTF-8 bytes', () => {
    const p = parseEnvelope({ ...good, payload: { b: 'x'.repeat(MAX_PAYLOAD_BYTES + 1) } });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toContain('payload');
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

  it('carries the payload serialized once, with its bytes', () => {
    const p = parseEnvelope(good);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.value.payloadJson).toBe(JSON.stringify(good.payload));
      expect(new TextDecoder().decode(p.value.payloadBytes)).toBe(p.value.payloadJson);
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
});
