import { expect } from 'bun:test';
import { lit, type ParityScenario } from '../harness.ts';

/** Atomic receipt snapshots and their retained turn metadata on both stores. */
export const receiptSnapshots: ParityScenario = {
  name: 'receipt snapshots: atomic plan metadata survives source deletion',
  dedicated: { receiptSnapshots: true, cloudflare: { main: '../../tests/parity/receipt-snapshots/worker-entry.ts' }, timeoutMs: 180_000 },
  async run(target) {
    const project = lit(target.projectId);
    const promptId = '00000000-0000-7000-8000-000000000001';
    const tokenId = `(SELECT id FROM member_credentials WHERE member_id = 'mem_parity' AND machine_id = 'machine_parity' LIMIT 1)`;
    const now = Date.now();
    const planIds = ['capture', 'receipts'];
    await target.sql(`INSERT INTO agents(id,name,source,enabled,created_at) VALUES ('snapshot-agent','snapshot','built-in',1,${now})`);
    await target.sql(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES (${project},'snapshot-source','machine_parity',${tokenId},${now},${now}),
        (${project},'snapshot-receiver','machine_parity',${tokenId},${now},${now}),
        (${project},'snapshot-failed','machine_parity',${tokenId},${now},${now})`);
    for (const [key, status, title] of [
      ['capture', 'in_progress', 'Preserve pending transcript batches during member reconnect'],
      ['retry', 'active', 'Retry transcript delivery after the member reconnects'],
      ['receipts', 'active', 'Record transcript delivery receipts before removing pending batches'],
      ['done', 'completed', 'Preserve transcript batches during member reconnect'],
      ['abandoned', 'abandoned', 'Replace pending transcript storage on reconnect'],
    ]) {
      await target.sql(`INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,title,content,content_hash,status,created_at,updated_at,token_id,received_at)
        VALUES (${project},${lit(key!)},'snapshot-source',${lit(key!)},'machine_parity',${lit(title!)},${lit(title!)},${lit(key!)},${lit(status!)},${now},${now},'fixture',${now})`);
    }
    const select = async (sessionId: string) => fetch(`${target.url}/__receipt-snapshots`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: target.projectId, sessionId, promptId: sessionId }),
    });
    await target.sql("CREATE TRIGGER reject_snapshot BEFORE INSERT ON injection_served_items WHEN NEW.item_id='receipts' BEGIN SELECT RAISE(ABORT,'snapshot failed'); END");
    try {
      const refused = await select('snapshot-failed');
      const refusal = await refused.json();
      expect({ status: refused.status, body: refusal }).toEqual({ status: 503, body: { error: 'prompt injection failed: record' } });
      expect(await target.sql(`SELECT id FROM spore_injections WHERE project_id=${project}`)).toEqual([]);
      expect(await target.sql(`SELECT * FROM injection_served_items WHERE project_id=${project}`)).toEqual([]);
    } finally { await target.sql('DROP TRIGGER reject_snapshot'); }
    const response = await select('snapshot-receiver');
    expect(response.status).toBe(200);
    const answer = await response.json() as { receiptId: string; items: { id: string; kind: string }[] };
    expect(answer.items.filter(item => item.kind === 'plan').map(item => item.id)).toEqual(planIds);
    const snapshots = await target.sql(`SELECT item_id,title,session_id,content_hash,unavailable FROM injection_served_items WHERE project_id=${project} ORDER BY item_id`);
    expect(snapshots.map(row => [row.item_id, row.session_id, row.content_hash, row.unavailable]))
      .toEqual(planIds.map(id => [id, 'snapshot-source', id, 0]));
    await target.sql(`UPDATE spore_injections SET delivered_prompt_id=${lit(promptId)},delivered_at=${now} WHERE project_id=${project} AND id=${lit(answer.receiptId)}`);
    await target.sql(`INSERT INTO prompt_batches(project_id,session_id,prompt_id,event_id,text,origin,content_hash,created_at,updated_at,token_id,received_at)
      VALUES (${project},'snapshot-receiver',${lit(promptId)},'snapshot-prompt-event','request','user','hash',${now},${now},${tokenId},${now})`);
    const read = async () => {
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/snapshot-receiver/turns/${promptId}`, { headers: target.ownerHeaders() });
      const body = await res.json() as { injection: { planIds: string[]; plans: { planKey: string; title: string | null }[] } };
      expect({ status: res.status, body: res.status === 200 ? null : body }).toEqual({ status: 200, body: null });
      return body;
    };
    const before = await read();
    expect(before.injection.plans.map(plan => plan.planKey)).toEqual(planIds);
    await target.sql(`UPDATE plans SET title='Changed after serving',content_hash='changed' WHERE project_id=${project}; DELETE FROM plans WHERE project_id=${project}`);
    expect((await read()).injection).toEqual(before.injection);
    expect(await target.sql(`SELECT item_id,title,session_id,content_hash,unavailable FROM injection_served_items WHERE project_id=${project} ORDER BY item_id`)).toEqual(snapshots);
    const sourceRemoved = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/snapshot-source/tombstone`, {
      method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: '{}',
    });
    expect(sourceRemoved.status).toBe(200);
    expect(await target.sql(`SELECT item_id,title,session_id,content_hash,unavailable FROM injection_served_items WHERE project_id=${project} ORDER BY item_id`))
      .toEqual(planIds.map(id => ({ item_id: id, title: null, session_id: null, content_hash: null, unavailable: 1 })));
    const redacted = (await read()).injection;
    expect(redacted.planIds).toEqual(planIds);
    expect(redacted.plans).toEqual(planIds.map(planKey => ({ planKey, title: null })));
    const removed = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/snapshot-receiver/tombstone`, {
      method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: '{}',
    });
    expect(removed.status).toBe(200);
    expect(await target.sql(`SELECT * FROM injection_served_items WHERE project_id=${project}`)).toEqual([]);
  },
};
