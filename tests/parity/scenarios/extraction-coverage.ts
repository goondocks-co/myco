import { expect } from 'bun:test';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { expectPersisted, lit, memberHeadersFor, type ParityScenario, type ParityTarget } from '../harness.ts';

/** Coverage follows the exact items served over each front door. */
export const extractionCoverage: ParityScenario = {
  name: 'extraction coverage: served item acks, late material and counters survive run deletion',
  dedicated: { cloudflare: {}, timeoutMs: 180_000 },
  async run(target: ParityTarget) {
    const now = Date.now();
    const project = target.projectId;
    const session = 'coverage-session';
    const first = crypto.randomUUID();
    const tied = crypto.randomUUID();
    const hole = crypto.randomUUID();
    const capture = async (kind: string, at: number, payload: Record<string, unknown>, source = session) => {
      await expectPersisted(await fetch(`${target.url}/events`, { method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: source, kind, createdAt: at, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }) }), kind);
    };
    const prompt = (promptId: string, at: number) => capture('prompt', at, { promptId, text: 'Material to extract', origin: 'user' });
    const complete = () => capture('session.end', now, { endedAt: now });
    const count = async (n: number) => expect(await target.sql(`SELECT eligible_prompts AS n FROM session_read_facts WHERE project_id=${lit(project)} AND session_id=${lit(session)}`)).toEqual([{ n }]);
    await target.sql(`INSERT OR IGNORE INTO members(id,label,created_at) VALUES('mem_harness','Coverage',${now})`);
    await target.sql(`INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Myco','built-in',1,${now})`);
    const run = async (id: string, startedAt = now) => {
      const tokenId = `mt_${id}`;
      const token = `${id}-synthetic-credential`.padEnd(43, 'x');
      await target.sql(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,bytes_written,lineage_root,lineage_started_at)
        VALUES(${lit(tokenId)},'mem_harness','coverage',${lit(await sha256Hex(token))},${now},${now + 3_600_000},0,${lit(tokenId)},${now})`);
      await target.sql(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at,dispatched_by,run_context)
        VALUES(${lit(project)},${lit(id)},'myco-agent','extract-curate','running',${startedAt},${lit(tokenId)},${lit(JSON.stringify({ timeoutSeconds: 300 }))})`);
      return async (args: Record<string, unknown>) => {
        const response = await fetch(`${target.url}/mcp`, { method: 'POST', headers: memberHeadersFor(token, project, { 'content-type': 'application/json' }),
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_run_prompts', arguments: { project, ...args } } }) });
        const body = await response.json() as { result?: { structuredContent: { result: any } }; error?: unknown };
        expect(body.error).toBeUndefined();
        return body.result!.structuredContent.result;
      };
    };
    await prompt(first, now - 1000);
    await prompt(tied, now - 1000);
    await complete();
    const one = await run('coverage-one');
    expect(await one({ op: 'mark_processed', prompt_id: first })).toMatchObject({ ok: false });
    const page = await one({ op: 'unprocessed', include_text: true });
    expect((await one({ op: 'unprocessed', include_text: true })).prompts).toEqual(page.prompts);
    expect(await target.sql('SELECT COUNT(*) AS n FROM run_served_material')).toEqual([{ n: 2 }]);
    const item = page.prompts.find((row: any) => row.prompt_id === first);
    expect(await one({ op: 'mark_processed', served_id: item.served_id })).toMatchObject({ marked: true });
    expect(await one({ op: 'mark_processed', served_id: item.served_id })).toMatchObject({ marked: false });
    await count(1);
    await prompt(hole, now - 2000);
    await complete();
    await count(2);
    const two = await run('coverage-two');
    expect(await two({ op: 'mark_processed', served_id: item.served_id })).toMatchObject({ ok: false });
    const remaining = await two({ op: 'unprocessed', include_text: true });
    expect(remaining.prompts.map((row: any) => row.prompt_id)).toEqual([hole, tied]);
    expect(await two({ op: 'mark_processed', prompt_id: hole })).toEqual({ prompt_id: hole, marked: true });
    expect(await target.sql(`SELECT served_id FROM extraction_acks WHERE project_id=${lit(project)} AND record_id=${lit(hole)}`)).toEqual([{ served_id: remaining.prompts[0].served_id }]);
    expect(await two({ op: 'mark_processed', served_id: remaining.prompts[1].served_id })).toMatchObject({ marked: true });
    await count(0);
    expect((await two({ op: 'unprocessed' })).prompts).toEqual([]);
    expect(await target.sql('SELECT DISTINCT processed FROM prompt_batches')).toEqual([{ processed: 0 }]);
    await target.sql(`DELETE FROM agent_runs WHERE project_id=${lit(project)} AND id IN ('coverage-one','coverage-two')`);
    expect(await target.sql('SELECT COUNT(*) AS n FROM extraction_acks')).toEqual([{ n: 3 }]);
    expect(await target.sql('SELECT COUNT(*) AS n FROM run_served_material')).toEqual([{ n: 0 }]);
    await count(0);
    const oldPrompt = crypto.randomUUID();
    await prompt(oldPrompt, now - 3000);
    await complete();
    const boundary = Number((await target.sql("SELECT value FROM schema_meta WHERE key='ledger_enabled_at'"))[0]!.value);
    const old = await run('coverage-old', boundary - 1);
    expect(await old({ op: 'mark_processed', prompt_id: oldPrompt })).toEqual({ prompt_id: oldPrompt, marked: true });
    await count(0);
    for (let i = 0; i < 12; i++) {
      const source = 'coverage-page-' + i;
      await capture('prompt', now + i + 1, { promptId: crypto.randomUUID(), text: 'Paged material', origin: 'user' }, source);
      await capture('session.end', now + 100 + i, { endedAt: now + 100 + i }, source);
    }
    const paged = await run('coverage-paged');
    const empty = await paged({ op: 'unprocessed', include_text: true, limit: 2, cursor: '9007199254740991:~' });
    expect(empty.prompts).toEqual([]);
    expect(empty.next_cursor).not.toBeNull();
    const followed = await paged({ op: 'unprocessed', include_text: true, limit: 2, cursor: empty.next_cursor });
    expect(followed.prompts).toEqual([]);
    expect(followed.next_cursor).not.toBe(empty.next_cursor);
    expect(await target.sql('SELECT COUNT(*) AS n FROM run_served_material')).toEqual([{ n: 0 }]);
    const fresh = await paged({ op: 'unprocessed', include_text: true, limit: 2 });
    expect(fresh.prompts).toHaveLength(2);
    expect(await paged({ op: 'mark_processed', served_id: fresh.prompts[0].served_id })).toMatchObject({ marked: true });
    expect(await target.sql(`SELECT SUM(eligible_prompts) AS n FROM session_read_facts WHERE project_id=${lit(project)}`)).toEqual([{ n: 11 }]);
  },
};
