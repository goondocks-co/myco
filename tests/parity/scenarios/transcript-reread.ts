import { expect } from 'bun:test';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { AWAITING_BYTES, PARSER_VERSION, PENDING_TRANSCRIPTS } from '@myco-server-worker/ingest/parse.js';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

const cursorLine = (role: string, text: string): string => `${JSON.stringify({ role, message: { content: [{ type: 'text', text }] } })}\n`;

/**
 * A Cursor transcript on both targets (#1461): a segment that ends inside a
 * record waits without staying in the parse queue, the segment that finishes
 * it puts it back, its rows are dated at the time their segment was sent, and
 * an owner's re-read, by session or by agent, reads it again without landing a
 * row twice. The queue is read through the parse's own predicate, so both
 * stores are held to the one SQL.
 */
export const transcriptReread: ParityScenario = {
  name: 'Cursor transcript: a wait keyed on bytes, segment-dated rows, and an owner re-read, identical on both targets',
  async run(target: ParityTarget) {
    const sessionId = `cursor-reread-${crypto.randomUUID()}`;
    const transcriptId = `tx_${crypto.randomUUID().replaceAll('-', '')}`;
    await target.sql(`INSERT OR IGNORE INTO projects(project_id,name,created_at) VALUES (${lit(target.projectId)},'Cursor re-read',${Date.now()})`);
    const text = cursorLine('user', '<timestamp>t</timestamp>\n<user_query>\nparity prompt\n</user_query>') + cursorLine('assistant', 'parity [REDACTED] reply');
    const cut = text.length - 12;
    const sentAt = Date.now() - 60_000;

    const ship = async (bytes: Uint8Array<ArrayBuffer>, baseOffset: number, createdAt: number) => {
      const digest = await sha256HexOf(bytes);
      await expectPersisted(await fetch(`${target.url}/blobs/${digest}`, {
        method: 'POST', headers: target.memberHeaders({ 'content-type': 'text/plain', 'content-length': String(bytes.byteLength) }), body: bytes,
      }), 'segment blob');
      await expectPersisted(await fetch(`${target.url}/events`, {
        method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({
          eventId: crypto.randomUUID(), sessionId, kind: 'transcript.segment', createdAt, channel: 'cli',
          producer: { adapter: 'cursor', version: '2026.09' },
          payload: { transcriptId, baseOffset, length: bytes.byteLength, blob: digest, agent: 'cursor' },
        }),
      }), 'segment');
    };
    const wake = async () => {
      const response = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(response.status).toBe(200);
    };
    const state = async () => (await target.sql(`SELECT parsed_offset, size, parse_error, parse_awaited_size FROM transcripts WHERE project_id=${lit(target.projectId)} AND transcript_id=${lit(transcriptId)}`))[0];
    const pending = async () => (await target.sql(`SELECT COUNT(*) AS n FROM transcripts WHERE project_id=${lit(target.projectId)} AND transcript_id=${lit(transcriptId)}
      AND ${PENDING_TRANSCRIPTS.replace('?', String(PARSER_VERSION))}`))[0].n;
    const rows = () => target.sql(`SELECT p.text AS prompt, p.created_at AS prompt_at, r.text AS response FROM prompt_batches p
      LEFT JOIN responses r ON r.project_id = p.project_id AND r.prompt_id = p.prompt_id
      WHERE p.project_id=${lit(target.projectId)} AND p.session_id=${lit(sessionId)}`);
    const settle = async () => {
      for (let n = 0; n < 8; n += 1) {
        await wake();
        const now = await state();
        if (Number(now.parsed_offset) === Number(now.size) || now.parse_error !== null) return;
      }
    };

    // The first segment ends inside the reply: read what is whole, then wait on the rest without staying queued.
    const bytes = new TextEncoder().encode(text);
    const head = new TextEncoder().encode(text.slice(0, cut));
    await ship(head, 0, sentAt);
    await settle();
    await settle();
    expect(await state()).toMatchObject({ parse_error: AWAITING_BYTES, parse_awaited_size: head.byteLength, size: head.byteLength });
    expect(Number(await pending())).toBe(0);

    // The bytes that finish it put it back, and it is read to its end.
    await ship(bytes.slice(head.byteLength), head.byteLength, sentAt + 1_000);
    expect(Number(await pending())).toBe(1);
    await settle();
    expect(await state()).toMatchObject({ parsed_offset: bytes.byteLength, size: bytes.byteLength, parse_error: null, parse_awaited_size: null });
    expect(await rows()).toEqual([{ prompt: 'parity prompt', prompt_at: sentAt, response: 'parity reply' }]);

    // An owner reads it again: by session in a Project it can see, not in one that does not exist, and by agent.
    const reread = async (body: unknown) => {
      const response = await fetch(`${target.url}/api/transcripts/reread`, {
        method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
    expect(await reread({ projectId: 'proj_absent_parity', sessionId })).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(await reread({ projectId: target.projectId, sessionId })).toEqual({ status: 200, body: { reread: 1 } });
    expect(await state()).toMatchObject({ parsed_offset: 0 });
    await settle();
    const byAgent = await reread({ agent: 'cursor' });
    expect(byAgent.status).toBe(200);
    expect((byAgent.body as { reread: number }).reread).toBeGreaterThanOrEqual(1);
    await settle();
    expect(await state()).toMatchObject({ parsed_offset: bytes.byteLength, parse_error: null });
    expect(await rows()).toEqual([{ prompt: 'parity prompt', prompt_at: sentAt, response: 'parity reply' }]);
  },
};
