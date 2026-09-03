import { expect } from 'bun:test';
import { expectPersisted, lit, MEMBER_ID, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * The proof scenario for #1042: capture through /events, the after-response
 * titling dispatch, the dashboard label, the MCP read, and an owner's ask —
 * identical on both targets. Both parity targets bind the recording runtime,
 * which takes a dispatch and starts nothing: the claim is stamped and a run
 * row waits, no title is ever written, and the session is labelled from its
 * first prompt. A title landing is proven by the live smoke.
 */
export const sessionsTitling: ParityScenario = {
  name: 'sessions and titling: capture, the unbound-runtime fallback, label, MCP, an owner\'s ask',
  async run(target: ParityTarget) {
    for (const [leaf, value] of [
      ['agent.provider.type', 'openai-compatible'],
      ['agent.provider.model', 'parity-model'],
      ['agent.provider.base_url', 'http://models.internal/v1'],
    ] as const) {
      await target.sql(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (${lit(leaf)}, ${lit(JSON.stringify(value))}, 1, ${lit(MEMBER_ID)})`);
    }

    const post = async (sessionId: string, kind: string, payload: Record<string, unknown>) => {
      const res = await fetch(`${target.url}/events`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind, createdAt: Date.now(), channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
      });
      await expectPersisted(res, kind);
    };
    const runSession = async (sessionId: string, prompt: string) => {
      await post(sessionId, 'session.start', { agent: 'claude-code', startedAt: Date.now() });
      await post(sessionId, 'prompt', { promptId: crypto.randomUUID(), text: prompt, origin: 'user' });
      await post(sessionId, 'session.end', { endedAt: Date.now() });
    };
    const sessionRow = (id: string) => target.sql(`SELECT title, summary, titled_at FROM sessions WHERE session_id=${lit(id)}`).then((rows) => rows[0]);
    const ownerRows = async () => {
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/sessions`, { headers: target.ownerHeaders() });
      expect(res.status).toBe(200);
      return ((await res.json()) as { rows: Array<{ sessionId: string; label: string }> }).rows;
    };
    const askTitle = async (id: string) => {
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/${id}/title`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(res.status).toBe(200);
      return (await res.json()) as { outcome: string; runId?: string };
    };

    // capture, then the end's deferred attempt: the recording runtime takes the dispatch, so the claim is stamped and a run row waits for a runtime that never writes
    const s1 = `parity-${Date.now()}-1`;
    await runSession(s1, 'Add a retry to the runner please');
    const runFor = (sessionId: string) => target.sql(`SELECT status, harness FROM agent_runs WHERE task = 'title-summary' AND run_context LIKE ${lit(`%${sessionId}%`)} ORDER BY started_at DESC LIMIT 1`);
    expect(await runFor(s1)).toEqual([{ status: 'pending', harness: 'record' }]);
    expect(await sessionRow(s1)).toEqual({ title: null, summary: null, titled_at: expect.any(Number) });
    // The owner's ask lands inside the deferred attempt's window; it is answered as already asked.
    expect(await askTitle(s1)).toEqual({ outcome: 'already' });

    // the owner list labels the session from its first prompt while no title is written
    expect((await ownerRows()).find((row) => row.sessionId === s1)?.label).toBe('Add a retry to the runner please');

    // MCP serves the session with no title
    const mcp = await fetch(`${target.url}/mcp`, {
      method: 'POST',
      headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_sessions', arguments: { session: s1 } } }),
    });
    expect(mcp.status).toBe(200);
    const mcpRows = ((await mcp.json()) as { result: { structuredContent: { result: Array<{ id: string; title: string | null }> } } }).result.structuredContent.result;
    expect(mcpRows.find((row) => row.id === s1)?.title).toBeNull();

    // a second end of the session changes nothing: one attempt per session
    const stamped = (await sessionRow(s1)) as { titled_at: number };
    await post(s1, 'session.end', { endedAt: Date.now() });
    expect(await askTitle(s1)).toEqual({ outcome: 'already' });
    expect(await sessionRow(s1)).toEqual({ title: null, summary: null, titled_at: stamped.titled_at });
    expect(await target.sql(`SELECT COUNT(*) AS c FROM agent_runs WHERE task = 'title-summary' AND run_context LIKE ${lit(`%${s1}%`)}`)).toEqual([{ c: 1 }]);

    // an open session is dispatched on an owner's ask
    const s2 = `parity-${Date.now()}-2`;
    await post(s2, 'session.start', { agent: 'claude-code', startedAt: Date.now() });
    await post(s2, 'prompt', { promptId: crypto.randomUUID(), text: 'Rename the project from the card', origin: 'user' });
    expect(await askTitle(s2)).toMatchObject({ outcome: 'dispatched' });
    expect(await runFor(s2)).toEqual([{ status: 'pending', harness: 'record' }]);
    expect(await sessionRow(s2)).toEqual({ title: null, summary: null, titled_at: expect.any(Number) });
    expect((await ownerRows()).find((row) => row.sessionId === s2)?.label).toBe('Rename the project from the card');
  },
};
