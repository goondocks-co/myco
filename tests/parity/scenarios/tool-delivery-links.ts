import { expect } from 'bun:test';
import type { ParityScenario } from '../harness.ts';
import { blob, context, publishedTurns, turn, withRecall } from '../clients/capture.ts';
import { event, owner } from '../clients/requests.ts';

/** Tool anchors place rendered memory when the native transcript supplies its prompt. */
export const toolDeliveryLinks: ParityScenario = {
  name: 'tool delivery links: delayed transcript places receipts once by native identity',
  dedicated: { cloudflare: { embeddingFixture: true }, sqliteVec: true, timeoutMs: 120_000 },
  async run(target) {
    await withRecall(target, async () => {
      await target.primeEmbedding!(target.projectId);
      const session = `tool-delivery-${crypto.randomUUID()}`, transcriptId = `tx_${crypto.randomUUID().replaceAll('-', '')}`;
      await event(target, session, 'session.start', { agent: 'copilot', startedAt: Date.now() });
      const path = `/api/projects/${target.projectId}/sessions/${session}`;
      const kpis = async () => (await owner(target, '/api/kpis?window=all')).body;
      const before = await kpis();
      const answers: any[] = [], deliveries: Record<string, unknown>[] = [];
      for (const text of ['astronomy telescope galaxy', 'sourdough fermentation flour', 'gardening soil seedlings', 'sailing tide compass', 'knitting wool pattern']) {
        const answer = await context(target, 'prompt', { sessionId: session, text, identity: 1, scopeReason: 'transcript_only', at: Date.now() });
        expect(answer.receiptId).toEqual(expect.any(String));
        answers.push(answer);
        const renderedToolCallKey = ['first-call', 'second-call', 'missing-call', 'named-call', 'unrendered-call'][answers.length - 1];
        deliveries.push({ receiptId: answer.receiptId, answerId: answer.answerId, renderedToolCallKey, renderedScopeReason: 'transcript_only' });
      }
      const sent = new Map<Record<string, unknown>, Record<string, unknown>>();
      const send = async (payload: Record<string, unknown>) => {
        const envelope = sent.get(payload) ?? { eventId: crypto.randomUUID(), sessionId: session, kind: 'context.delivered',
          createdAt: Date.now(), channel: 'cli', producer: { adapter: 'copilot', version: '1' }, payload };
        sent.set(payload, envelope);
        const response = await fetch(`${target.url}/events`, { method: 'POST', headers: target.memberHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(envelope) });
        expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ persisted: true });
      };
      await send(deliveries[0]!); await send(deliveries[2]!);
      const unplaced = await owner(target, path + '/unplaced');
      expect(unplaced.body.rows.map((row: any) => row.id)).toContain(answers[0].receiptId);
      expect((await kpis()).deliveries).toEqual({ placed: before.deliveries.placed, unplaced: before.deliveries.unplaced + 2 });
      // Native ids are supplied by the harness independently of prompt text and delivery arrival.
      const prompts = Array.from({ length: 3 }, () => crypto.randomUUID());
      const nativeCalls = ['first-call', 'second-call', 'named-call'];
      const records = prompts.flatMap((messageId, index) => [
        { type: 'user.message', data: { messageId, content: 'same prompt text' } },
        { type: 'assistant.message', data: { originatingMessageId: messageId, toolRequests: [{ toolCallId: nativeCalls[index], name: 'view', arguments: {} }] } },
      ]);
      const bytes = new TextEncoder().encode(records.map(row => JSON.stringify(row)).join('\n') + '\n');
      await event(target, session, 'transcript.segment', { transcriptId, baseOffset: 0, length: bytes.byteLength, blob: await blob(target, bytes), agent: 'copilot' }, Date.now(), target.projectId, { producer: { adapter: 'copilot', version: '1' } });
      const turns = await publishedTurns(target, session, rows => rows.length === 3);
      const ids = turns.body.rows.map((row: any) => row.promptId);
      const named = { receiptId: answers[3].receiptId, answerId: answers[3].answerId, renderedIn: ids[2] };
      await send(named);
      await send(deliveries[1]!);
      await send(deliveries[0]!);
      expect((await turn(target, session, ids[2])).body.injection?.sporeIds).toEqual(answers[3].parts.flatMap((part: any) => part.sporeIds ?? []));
      expect((await turn(target, session, ids[0])).body.injection?.sporeIds).toEqual(answers[0].parts.flatMap((part: any) => part.sporeIds ?? []));
      expect((await turn(target, session, ids[1])).body.injection?.sporeIds).toEqual(answers[1].parts.flatMap((part: any) => part.sporeIds ?? []));
      expect((await owner(target, path + '/unplaced')).body.rows.map((row: any) => row.id)).toContain(answers[2].receiptId);
      expect((await kpis()).deliveries).toEqual({ placed: before.deliveries.placed + 3, unplaced: before.deliveries.unplaced + 1 });
    });
  },
};
