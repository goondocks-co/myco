import { describe, it, expect } from 'bun:test';
import { readBoundedBody, MAX_BODY_BYTES } from '@myco-server-worker/ingest/body.js';

function chunked(totalBytes: number, headers: Record<string, string> = {}): { request: Request; state: { sent: number; cancelled: boolean } } {
  const chunk = new TextEncoder().encode('x'.repeat(1024));
  const state = { sent: 0, cancelled: false };
  const body = new ReadableStream({
    pull(c) {
      if (state.sent >= totalBytes) return c.close();
      state.sent += chunk.byteLength;
      c.enqueue(chunk);
    },
    cancel() { state.cancelled = true; },
  });
  return { request: new Request('https://s/events', { method: 'POST', body, headers, duplex: 'half' } as any), state };
}

describe('bounded body', () => {
  it('reads a small body', async () => {
    const r = new Request('https://s/events', { method: 'POST', body: '{"a":1}' });
    const out = await readBoundedBody(r, MAX_BODY_BYTES);
    expect(out).toEqual({ ok: true, text: '{"a":1}', bytes: 7 });
  });

  it('decodes multi-byte text split across chunks', async () => {
    const bytes = new TextEncoder().encode('{"t":"héllo €"}');
    const body = new ReadableStream({
      start(c) { c.enqueue(bytes.slice(0, 7)); c.enqueue(bytes.slice(7)); c.close(); },
    });
    const out = await readBoundedBody(new Request('https://s/events', { method: 'POST', body, duplex: 'half' } as any), MAX_BODY_BYTES);
    expect(out).toEqual({ ok: true, text: '{"t":"héllo €"}', bytes: bytes.byteLength });
  });

  it('refuses a body whose declared content-length exceeds the bound without reading it', async () => {
    const stream = chunked(64 * 1024, { 'content-length': String(64 * 1024) });
    const out = await readBoundedBody(stream.request, 8 * 1024);
    expect(out.ok).toBe(false);
    expect({ locked: stream.request.body!.locked, used: stream.request.bodyUsed }).toEqual({ locked: false, used: false });
  });

  it('refuses an oversized chunked body with no content-length', async () => {
    const out = await readBoundedBody(chunked(64 * 1024).request, 8 * 1024);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('body');
  });

  it('drains an oversized stream to its end without cancelling it', async () => {
    const stream = chunked(4 * 1024 * 1024);
    const out = await readBoundedBody(stream.request, 8 * 1024);
    expect(out.ok).toBe(false);
    expect(stream.state.sent).toBe(4 * 1024 * 1024);
    expect(stream.state.cancelled).toBe(false);
  });
});
