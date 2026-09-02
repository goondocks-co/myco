import { expect } from 'bun:test';
import { expectPersisted, lit, MEMBER_ID, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * The proof scenario for #1042: capture through /events, the after-response
 * titling dispatch, the dashboard label, the MCP read, and an owner's ask —
 * identical on both targets. Neither parity target binds a harness runtime,
 * so a title is never written here: both answer `harness_unavailable`, stamp
 * nothing, and label the session from its first prompt. The dispatch itself
 * is proven by the unit tests against a bound runtime and by the live smoke.
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

    // capture, then the end's deferred attempt: with no runtime bound it stamps nothing
    const s1 = `parity-${Date.now()}-1`;
    await runSession(s1, 'Add a retry to the runner please');
    // The owner's ask lands after the deferred attempt has been answered; it is answered the same way.
    expect(await askTitle(s1)).toEqual({ outcome: 'harness_unavailable' });
    expect(await sessionRow(s1)).toEqual({ title: null, summary: null, titled_at: null });

    // the owner list labels the session from its first prompt
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

    // a second end of the session changes nothing
    await post(s1, 'session.end', { endedAt: Date.now() });
    expect(await askTitle(s1)).toEqual({ outcome: 'harness_unavailable' });
    expect(await sessionRow(s1)).toEqual({ title: null, summary: null, titled_at: null });

    // an open session is answered the same way on an owner's ask
    const s2 = `parity-${Date.now()}-2`;
    await post(s2, 'session.start', { agent: 'claude-code', startedAt: Date.now() });
    await post(s2, 'prompt', { promptId: crypto.randomUUID(), text: 'Rename the project from the card', origin: 'user' });
    expect(await askTitle(s2)).toEqual({ outcome: 'harness_unavailable' });
    expect(await sessionRow(s2)).toEqual({ title: null, summary: null, titled_at: null });
    expect((await ownerRows()).find((row) => row.sessionId === s2)?.label).toBe('Rename the project from the card');
  },
};
