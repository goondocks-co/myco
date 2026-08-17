import { describe, it, expect } from 'bun:test';
import { parseEnvelope, MAX_PAYLOAD_BYTES, MAX_ID_CHARS, MAX_PAYLOAD_DEPTH, MAX_PAYLOAD_NODES } from '../../packages/myco-server/worker/src/ingest/envelope.js';

const good = { eventId: 'evt_1', sessionId: 'sess_1', kind: 'prompt', createdAt: 1_000, transport: 'cli', payload: { text: 'hi' } };

describe('envelope', () => {
  it('refuses the pre-2.0 hook body shape', () => {
    const legacy = { type: 'user_prompt_submit', prompt: 'hi', session_id: 'sess_1', agent: 'claude-code', transcript_path: '/tmp/t.jsonl' };
    const p = parseEnvelope(legacy);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toBe('eventId must be a non-empty string');
  });

  it('accepts a well-formed envelope', () => {
    const p = parseEnvelope(good);
    expect(p.ok).toBe(true);
  });

  it('names the offending field', () => {
    for (const [field, value] of [['eventId', undefined], ['kind', ''], ['transport', 'pigeon']] as const) {
      const p = parseEnvelope({ ...good, [field]: value });
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.reason).toContain(field);
    }
  });

  it('bounds identifier length', () => {
    for (const field of ['eventId', 'sessionId', 'kind'] as const) {
      const p = parseEnvelope({ ...good, [field]: 'x'.repeat(MAX_ID_CHARS + 1) });
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.reason).toContain(field);
    }
    expect(parseEnvelope({ ...good, eventId: 'x'.repeat(MAX_ID_CHARS) }).ok).toBe(true);
  });

  it('refuses an oversized payload', () => {
    const p = parseEnvelope({ ...good, payload: { b: 'x'.repeat(MAX_PAYLOAD_BYTES + 1) } });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.reason).toContain('payload');
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

  it('drops a caller-supplied machineId', () => {
    const p = parseEnvelope({ ...good, machineId: 'spoofed' });
    expect(p.ok).toBe(true);
    if (p.ok) expect('machineId' in p.value).toBe(false);
  });

  it('carries the payload serialized once', () => {
    const p = parseEnvelope(good);
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.value.payloadJson).toBe(JSON.stringify(good.payload));
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
