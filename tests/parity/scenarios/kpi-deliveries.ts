import { expect } from 'bun:test';
import { lit, type ParityScenario } from '../harness.ts';
import type { AttentionAnswer } from '@myco-server-worker/core/attention.js';
import type { KpiReport } from '@myco-server-worker/read/kpis.js';

/** Delivery hints place receipts independently of selection and transcript progress on both stores. */
export const kpiDeliveries: ParityScenario = {
  name: 'KPI deliveries: delivery counts, served prompts and retired attention agree on both stores',
  dedicated: { timeoutMs: 60_000 },
  async run(target) {
    const project = lit(target.projectId);
    const now = Date.now();
    const kpis = async () => {
      const response = await fetch(`${target.url}/api/kpis?window=all`, { headers: target.ownerHeaders() });
      expect(response.status).toBe(200);
      return response.json() as Promise<KpiReport>;
    };
    const before = await kpis();
    await target.sql(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES (${project},'placement-s','m','t',1,1), (${project},'placement-other','m','t',1,1)`);
    await target.sql(`INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,agent,size,parsed_offset,first_received_at,last_received_at,token_id,role,parsed_through_at)
      VALUES (${project},'placement-tx','placement-s','m','codex',100,100,1,1,'t','primary',${now})`);
    await target.sql(`INSERT INTO spore_injections(project_id,id,session_id,prompt_id,prompt_hash,spore_ids,ask_protocol,asked_at,created_at,delivered_prompt_id,delivered_scope_reason,delivered_at)
      VALUES (${project},'placement-r1','placement-s','placement-selection','h1','[]','v1',${now-100},${now},'placement-delivery',NULL,${now-50}),
        (${project},'placement-r2','placement-s','selection-2','h2','[]','v1',${now-100},${now},'placement-cross',NULL,${now-50}),
        (${project},'placement-r3','placement-s','selection-3','h3','[]','v1',${now-100},${now},NULL,'absent_key',${now-50}),
        (${project},'placement-r4','placement-s','selection-4','h4','[]','v1',${now-100},${now},NULL,NULL,NULL)`);
    const unplaced = await kpis();
    expect(unplaced.deliveries).toEqual({ placed: before.deliveries.placed, unplaced: before.deliveries.unplaced + 3 });
    expect(unplaced.promptsServed).toBe(before.promptsServed);
    const attention = await fetch(`${target.url}/api/attention`, { headers: target.ownerHeaders() });
    expect(attention.status).toBe(200);
    const answer = await attention.json() as AttentionAnswer;
    expect(answer.unavailable as string[]).not.toContain('prompt_references');
    expect(answer.items.map(item => item.kind) as string[]).not.toContain('prompt_references');
    await target.sql(`INSERT INTO prompt_batches(project_id,prompt_id,session_id,event_id,origin,content_hash,created_at,updated_at,token_id,received_at)
      VALUES (${project},'placement-selection','placement-s','placement-e1','user','h',${now},${now},'t',${now}),
        (${project},'placement-cross','placement-other','placement-e2','user','h',${now},${now},'t',${now})`);
    const selectionOnly = await kpis();
    expect(selectionOnly.promptsServed).toBe(before.promptsServed);
    expect(selectionOnly.deliveries).toEqual(unplaced.deliveries);
    await target.sql(`INSERT INTO prompt_batches(project_id,prompt_id,session_id,event_id,origin,content_hash,created_at,updated_at,token_id,received_at)
      VALUES (${project},'placement-delivery','placement-s','placement-e3','user','h',${now},${now},'t',${now})`);
    const placed = await kpis();
    expect(placed.promptsServed).toBe(before.promptsServed + 1);
    expect(placed.deliveries).toEqual({ placed: before.deliveries.placed + 1, unplaced: before.deliveries.unplaced + 2 });
    expect(placed.servedShare).toEqual({ value: placed.promptsServed / (before.servedShare.sampleSize + 3), sampleSize: before.servedShare.sampleSize + 3 });
  },
};
