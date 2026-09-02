import { expect } from 'bun:test';
import { MEMBER_ID, expectPersisted, lit, titlingStub, waitFor, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * The proof scenario for #1042: capture through /events, the after-response
 * titling call against a deterministic provider stub, the dashboard label, the
 * MCP read, claim idempotence, and the provider-down fallback — identical on
 * both targets.
 */
export const sessionsTitling: ParityScenario = {
  name: 'sessions and titling: capture, title, label, MCP, idempotence, provider-down fallback',
  async run(target: ParityTarget) {
    const stub = titlingStub();
    try {
      for (const [leaf, value] of [
        ['agent.provider.type', 'openai-compatible'],
        ['agent.provider.model', 'parity-model'],
        ['agent.provider.base_url', stub.url],
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

      // capture then title
      const s1 = `parity-${Date.now()}-1`;
      await runSession(s1, 'Add a retry to the runner please');
      const titled = await waitFor(() => sessionRow(s1), (row) => row !== undefined && row.title !== null);
      expect(titled?.title).toBe('Retry added to the runner');
      expect(String(titled?.summary)).toContain('runner.ts');

      // the owner list serves the title as the row label
      expect((await ownerRows()).find((row) => row.sessionId === s1)?.label).toBe('Retry added to the runner');

      // MCP serves the stored title and summary
      const mcp = await fetch(`${target.url}/mcp`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_sessions', arguments: { session: s1 } } }),
      });
      expect(mcp.status).toBe(200);
      const mcpRows = ((await mcp.json()) as { result: { structuredContent: { result: Array<{ id: string; title: string | null; summary: string }> } } }).result.structuredContent.result;
      expect(mcpRows.find((row) => row.id === s1)?.title).toBe('Retry added to the runner');

      // a second end of an already-titled session sends no second provider call;
      // the assertion waits below until s2's claim proves the deferred queue has
      // advanced past this end, so a late duplicate cannot hide in a sleep
      await post(s1, 'session.end', { endedAt: Date.now() });

      // provider down: the attempt is claimed, the title stays null, the label falls back to the first prompt
      stub.up = false;
      const s2 = `parity-${Date.now()}-2`;
      await runSession(s2, 'Rename the project from the card');
      const claimed = await waitFor(() => sessionRow(s2), (row) => row !== undefined && row.titled_at !== null);
      expect(claimed?.title).toBeNull();
      expect((await ownerRows()).find((row) => row.sessionId === s2)?.label).toBe('Rename the project from the card');
      expect(stub.requests.filter((r) => r.material.includes('retry')).length).toBe(1);

      // On an owner's ask the provider is asked again, for an ended session with a title and for one still open. The end-of-session attempt was moments ago, so its stamp is aged past the in-flight window first.
      stub.up = true;
      await target.sql(`UPDATE sessions SET titled_at = titled_at - 60000 WHERE session_id=${lit(s1)}`);
      const askTitle = async (id: string) => {
        const res = await fetch(`${target.url}/api/projects/${target.projectId}/sessions/${id}/title`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url } });
        expect(res.status).toBe(200);
        return ((await res.json()) as { outcome: string }).outcome;
      };
      expect(await askTitle(s1)).toBe('titled');
      expect(stub.requests.filter((r) => r.material.includes('retry')).length).toBe(2);
      const s3 = `parity-${Date.now()}-3`;
      await post(s3, 'session.start', { agent: 'claude-code', startedAt: Date.now() });
      await post(s3, 'prompt', { promptId: crypto.randomUUID(), text: 'Add a retry to the open session too', origin: 'user' });
      expect(await askTitle(s3)).toBe('titled');
      expect((await sessionRow(s3))?.title).toBe('Retry added to the runner');
      expect((await ownerRows()).find((row) => row.sessionId === s3)?.label).toBe('Retry added to the runner');
    } finally {
      stub.stop();
    }
  },
};
