import { describe, expect, test } from 'bun:test';
import { skeletonizeTranscript } from '../../../packages/myco/src/capture/diagnostics/skeletonize.js';

const PROSE = 'SECRET_PROSE_do_not_leak';
const ALLOWED_KEYS = new Set([
  'type', 'timestamp', 'uuid', 'parent_uuid', 'role', 'content_hash', 'text_sha256', 'byte_length',
]);

describe('skeletonizeTranscript', () => {
  test('emits only allowlisted keys and no prose', () => {
    const lines = [
      // Claude Code-ish user event
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-08-12T10:00:00Z', message: { role: 'user', content: PROSE } }),
      // assistant event with structured content blocks
      JSON.stringify({ type: 'assistant', uuid: 'u2', parentUuid: 'u1', timestamp: '2026-08-12T10:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: PROSE }] } }),
      // novel event shape from a future harness — extra fields must not leak
      JSON.stringify({ type: 'wormhole', novelField: PROSE, nested: { deep: PROSE } }),
      // unparseable garbage
      '{not json',
    ];
    const out = skeletonizeTranscript(lines.join('\n'));
    expect(out).not.toContain(PROSE);
    for (const line of out.trim().split('\n')) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      for (const key of Object.keys(obj)) expect(ALLOWED_KEYS.has(key)).toBe(true);
      expect(typeof obj.byte_length).toBe('number');
    }
  });

  test('identical content yields identical content_hash; different content differs', () => {
    const mk = (text: string) =>
      JSON.stringify({ type: 'user', uuid: 'x', timestamp: 't', message: { role: 'user', content: text } });
    const [a] = skeletonizeTranscript(mk('same')).trim().split('\n');
    const [b] = skeletonizeTranscript(mk('same')).trim().split('\n');
    const [c] = skeletonizeTranscript(mk('different')).trim().split('\n');
    expect(JSON.parse(a!).content_hash).toBe(JSON.parse(b!).content_hash);
    expect(JSON.parse(a!).content_hash).not.toBe(JSON.parse(c!).content_hash);
  });

  test('unparseable lines become type "unparseable" with byte_length only metadata', () => {
    const [line] = skeletonizeTranscript('{broken').trim().split('\n');
    const obj = JSON.parse(line!);
    expect(obj.type).toBe('unparseable');
    expect(obj.byte_length).toBe(7);
  });
});
