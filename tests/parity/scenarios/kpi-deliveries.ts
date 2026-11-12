import { expect } from 'bun:test';
import type { ParityScenario } from '../harness.ts';
import { deliver, promptContext, publishedTurns, withRecall } from '../clients/capture.ts';
import { event, owner } from '../clients/requests.ts';
import { saveSpore } from '../clients/knowledge.ts';

/** Delivery placement changes only when its exact session prompt is published. */
export const kpiDeliveries: ParityScenario = {
  name: 'KPI deliveries: delivery counts, served prompts and retired attention agree on both stores',
  dedicated: { cloudflare: { embeddingFixture: true }, sqliteVec: true, timeoutMs: 120_000 },
  async run(target) {
    await withRecall(target, async () => {
      const text = 'Preserve pending transcript batches during member reconnect';
      await saveSpore(target, text);
      await target.primeEmbedding!(target.projectId);
      const kpis = async () => { const answer = await owner(target, '/api/kpis?window=all'); expect(answer.status).toBe(200); return answer.body; };
      const before = await kpis();
      const sessions = ['placement-main', 'placement-cross', 'placement-unnamed', 'placement-undelivered'];
      const delivery = crypto.randomUUID(), cross = crypto.randomUUID(), selection = crypto.randomUUID();
      for (const session of sessions) {
        await event(target, session, 'session.start', { agent: 'codex', startedAt: Date.now() });
        const answer = await promptContext(target, session, session === sessions[0] ? selection : crypto.randomUUID(), text);
        expect(answer.receiptId).toEqual(expect.any(String));
        if (session !== sessions[3]) await deliver(target, session, { receiptId: answer.receiptId, answerId: answer.answerId }, session === sessions[2] ? { renderedScopeReason: 'absent_key' } : { renderedIn: session === sessions[0] ? delivery : cross });
      }
      const unplaced = await kpis();
      expect(unplaced.deliveries).toEqual({ placed: before.deliveries.placed, unplaced: before.deliveries.unplaced + 3 });
      expect(unplaced.promptsServed).toBe(before.promptsServed);
      const attention = await owner(target, '/api/attention');
      expect(attention.status).toBe(200);
      expect(attention.body.unavailable).not.toContain('prompt_references');
      expect(attention.body.items.map((item: any) => item.kind)).not.toContain('prompt_references');
      await event(target, sessions[0]!, 'prompt', { promptId: selection, text, origin: 'user' });
      await event(target, 'placement-other', 'prompt', { promptId: cross, text, origin: 'user' });
      await publishedTurns(target, sessions[0]!, rows => rows.length === 1);
      await publishedTurns(target, 'placement-other', rows => rows.length === 1);
      expect((await kpis()).deliveries).toEqual(unplaced.deliveries);
      expect((await kpis()).promptsServed).toBe(before.promptsServed);
      await event(target, sessions[0]!, 'prompt', { promptId: delivery, text, origin: 'user' });
      await publishedTurns(target, sessions[0]!, rows => rows.length === 2);
      const placed = await kpis();
      expect(placed.promptsServed).toBe(before.promptsServed + 1);
      expect(placed.deliveries).toEqual({ placed: before.deliveries.placed + 1, unplaced: before.deliveries.unplaced + 2 });
      expect(placed.servedShare).toEqual({ value: placed.promptsServed / (before.servedShare.sampleSize + 3), sampleSize: before.servedShare.sampleSize + 3 });
    });
  },
};
