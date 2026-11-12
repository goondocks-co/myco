import { expect } from 'bun:test';
import { lit, type ParityScenario } from '../harness.ts';
import { deliver, promptContext, publishedTurns, turn, withRecall } from '../clients/capture.ts';
import { saveSpore } from '../clients/knowledge.ts';
import { event, mcp, owner, untilPublished } from '../clients/requests.ts';

/** The real prompt context route snapshots plan metadata until source tombstoning redacts it. */
export const receiptSnapshots: ParityScenario = {
  name: 'receipt snapshots: served plan metadata survives edits and source tombstones redact it',
  dedicated: { cloudflare: { embeddingFixture: true }, sqliteVec: true, timeoutMs: 180_000 },
  async run(target) {
    await withRecall(target, async () => {
      const source = 'snapshot-source', receiver = 'snapshot-receiver', promptId = crypto.randomUUID();
      for (const session of [source, receiver]) await event(target, session, 'session.start', { agent: 'claude-code', startedAt: Date.now() });
      const plans: string[] = [];
      for (const [title, status] of [
        ['Preserve pending transcript batches during member reconnect', 'in_progress'],
        ['Record transcript delivery receipts before removing pending batches', 'active'],
        ['Retry transcript delivery after the member reconnects', 'active'],
        ['Preserve transcript batches during member reconnect', 'completed'],
        ['Replace pending transcript storage on reconnect', 'abandoned'],
      ]) {
        const saved = await mcp(target, 'myco_plans', { op: 'save', session_id: source, plan_key: title, title, content: title, status });
        expect(saved).toMatchObject({ ok: true }); plans.push(String(saved.id));
      }
      await untilPublished(target, () => mcp(target, 'myco_plans', { op: 'get', id: plans[0] }), plan => plan.content === 'Preserve pending transcript batches during member reconnect');
      await saveSpore(target, 'Capture pending transcript batches until delivery');
      await target.primeEmbedding!(target.projectId);
      const text = 'Preserve pending transcript batches during member reconnect';
      const answer = await promptContext(target, receiver, promptId, text);
      expect(answer.receiptId).toEqual(expect.any(String));
      // Receiving-session deletion must physically remove its retained receipt snapshots on both stores.
      const storedSnapshots = () => target.sql(`SELECT item_id FROM injection_served_items WHERE project_id=${lit(target.projectId)} AND receipt_id=${lit(answer.receiptId)}`);
      expect((await storedSnapshots()).length).toBeGreaterThan(0);
      await deliver(target, receiver, { receiptId: answer.receiptId, answerId: answer.answerId }, { renderedIn: promptId });
      await event(target, receiver, 'prompt', { promptId, text, origin: 'user' });
      await publishedTurns(target, receiver, rows => rows.length === 1);
      const read = async () => { const answer = await turn(target, receiver, promptId); expect(answer.status).toBe(200); return answer.body.injection; };
      const before = await read();
      expect(before.planIds).toContain(plans[0]);
      expect(before.plans.find((plan: any) => plan.planKey === plans[0]).title).toBe(text);
      expect((await mcp(target, 'myco_plans', { op: 'save', id: plans[0], session_id: source, title: 'Changed after serving', content: 'Changed after serving' })).ok).toBe(true);
      expect(await read()).toEqual(before);
      expect((await owner(target, `/api/projects/${target.projectId}/sessions/${source}/tombstone`, { method: 'POST', body: '{}' })).status).toBe(202);
      const redacted = await read();
      expect(redacted.planIds).toEqual(before.planIds);
      expect(redacted.plans).toEqual(before.planIds.map((planKey: string) => ({ planKey, title: null })));
      expect((await owner(target, `/api/projects/${target.projectId}/sessions/${receiver}/tombstone`, { method: 'POST', body: '{}' })).status).toBe(202);
      expect((await turn(target, receiver, promptId)).status).toBe(404);
      expect(await untilPublished(target, storedSnapshots, rows => rows.length === 0, 40)).toEqual([]);
    });
  },
};
