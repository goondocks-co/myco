import { expect } from 'bun:test';
import type { SearchAnswer, SearchResult } from '@goondocks/myco-shared/search-types';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

const MATCHES = 105;
const PAGE = 20;

/**
 * A session's conversation searched page by page on both targets: a hundred and more prompts of identical text and
 * time, a steering prompt, a prompt whose body is stored apart, and a reply, reached through the Project's search route
 * and the MCP tool by continuation, each match once, in one order, never another session's.
 */
export const searchPaging: ParityScenario = {
  name: 'search paging: a session\'s identical-text matches, a steering prompt and a stored body reached by continuation, once each, on HTTP and MCP',
  async run(target: ParityTarget) {
    const stamp = Date.now();
    const word = `zirconium${stamp}`;
    const session = `paging-${stamp}`;
    const elsewhere = `paging-elsewhere-${stamp}`;
    const at = stamp - 60_000;
    const post = async (sessionId: string, kind: string, payload: Record<string, unknown>) => {
      await expectPersisted(await fetch(`${target.url}/events`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind, createdAt: at, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
      }), kind);
    };
    const owner = async (extra: Record<string, string>) => {
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/search?${new URLSearchParams({ q: word, type: 'prompt', session_id: session, mode: 'fts', ...extra })}`, { headers: target.ownerHeaders() });
      return { status: res.status, body: await res.json() as SearchAnswer };
    };
    const mcp = async <T,>(args: Record<string, unknown>): Promise<T> => {
      const res = await fetch(`${target.url}/mcp`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_search', arguments: args } }),
      });
      const body = await res.json() as { error?: unknown; result: { structuredContent: { result: T } } };
      expect(body.error).toBeUndefined();
      return body.result.structuredContent.result;
    };

    await post(session, 'session.start', { agent: 'claude-code', startedAt: at });
    await post(elsewhere, 'session.start', { agent: 'claude-code', startedAt: at });
    const same: string[] = Array.from({ length: MATCHES }, () => crypto.randomUUID());
    for (let from = 0; from < same.length; from += 15) {
      await Promise.all(same.slice(from, from + 15).map((promptId) => post(session, 'prompt', { promptId, text: `${word} identical words`, origin: 'user' })));
    }
    const steer = crypto.randomUUID();
    await post(session, 'prompt', { promptId: steer, text: `${word} steering words`, origin: 'user', parentPromptId: same[0], threadLabel: 'reviewer' });
    const response = crypto.randomUUID();
    await post(session, 'response', { responseId: response, promptId: same[0], text: `${word} an answer` });
    await post(elsewhere, 'prompt', { promptId: crypto.randomUUID(), text: `${word} identical words`, origin: 'user' });
    const bytes = new TextEncoder().encode(`opening ${'filler '.repeat(160_000)} ${word}`);
    const key = await sha256HexOf(bytes);
    await expectPersisted(await fetch(`${target.url}/blobs/${key}`, {
      method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'text/plain; charset=utf-8', 'content-length': String(bytes.length) }, body: bytes,
    }), 'large text blob');
    const stored = crypto.randomUUID();
    await post(session, 'prompt', { promptId: stored, blob: key, origin: 'user' });

    let indexed = await owner({});
    for (let attempt = 0; indexed.body.coverage.pending_blobs > 0 && attempt < 4; attempt++) {
      const wake = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: '{}' });
      expect(wake.status).toBe(200);
      indexed = await owner({});
    }
    expect(indexed.body.coverage.pending_blobs).toBe(0);
    const times = await target.sql(`SELECT COUNT(DISTINCT created_at) AS n FROM prompt_batches WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(session)} AND text = ${lit(`${word} identical words`)}`);
    expect(Number(times[0]!.n)).toBe(1);

    const everyPrompt = [...same, steer, stored].sort();
    const walk = async (limit: number): Promise<{ results: SearchResult[]; pages: SearchResult[][] }> => {
      const pages: SearchResult[][] = [];
      let cursor: string | null = null;
      do {
        const page = await owner(cursor === null ? { limit: String(limit) } : { limit: String(limit), continuation: cursor });
        expect(page.status).toBe(200);
        pages.push(page.body.results);
        cursor = page.body.continuation;
        if (cursor !== null) expect(page.body.results).toHaveLength(limit);
      } while (cursor !== null);
      return { results: pages.flat(), pages };
    };
    const byPage = await walk(PAGE);
    expect(byPage.pages).toHaveLength(Math.ceil(everyPrompt.length / PAGE));
    // Every prompt of the session once, none of the other session's, in the one order every page shares.
    expect(byPage.results.map((r) => r.id).sort()).toEqual(everyPrompt);
    expect(byPage.results.every((r) => r.session_id === session)).toBe(true);
    const order = (a: SearchResult, b: SearchResult) => b.score - a.score || b.created_at - a.created_at || a.id.localeCompare(b.id);
    expect(byPage.results.map((r) => r.id)).toEqual([...byPage.results].sort(order).map((r) => r.id));
    const identical = byPage.results.filter((r) => same.includes(r.id));
    expect(identical.map((r) => r.id)).toEqual([...same].sort());
    expect(new Set(identical.map((r) => `${r.score}/${r.created_at}`)).size).toBe(1);
    // The 21st and the 101st match come the same at any page size.
    const wide = await walk(100);
    expect(wide.pages).toHaveLength(2);
    expect(wide.results.map((r) => r.id)).toEqual(byPage.results.map((r) => r.id));
    expect(wide.pages[1]![0]!.id).toBe(byPage.results[100]!.id);
    expect(byPage.pages[1]![0]!.id).toBe(byPage.results[PAGE]!.id);
    // Each hit names its turn: a steering prompt opens the turn it steers, and a stored body opens its own.
    expect(byPage.results.find((r) => r.id === steer)).toMatchObject({ created_at: at, turn: { prompt_id: same[0], preview: `${word} identical words` } });
    expect(byPage.results.find((r) => r.id === stored)).toMatchObject({ turn: { prompt_id: stored, preview: null, text_chars: null, stored: true } });
    expect(byPage.results.find((r) => r.id === same[1])).toMatchObject({ created_at: at, turn: { prompt_id: same[1], stored: false } });
    const [reply] = (await owner({ type: 'response' })).body.results;
    expect(reply).toMatchObject({ id: response, created_at: at, prompt_id: same[0], turn: { prompt_id: same[0] } });

    // The MCP tool pages the same matches by the same continuation.
    const first = await mcp<SearchAnswer>({ query: word, type: 'prompt', session_id: session, mode: 'fts', limit: PAGE });
    expect(first.results.map((r) => r.id)).toEqual(byPage.results.slice(0, PAGE).map((r) => r.id));
    expect(first.continuation).not.toBeNull();
    const second = await mcp<SearchAnswer>({ query: word, type: 'prompt', session_id: session, mode: 'fts', limit: PAGE, continuation: first.continuation });
    expect(second.results.map((r) => r.id)).toEqual(byPage.results.slice(PAGE, 2 * PAGE).map((r) => r.id));

    // A continuation the search did not issue is refused, and a search of several types offers none.
    expect((await owner({ continuation: 'nonsense' })).status).toBe(400);
    expect((await owner({ type: 'all', continuation: first.continuation! })).status).toBe(400);
    expect((await owner({ type: 'response', continuation: first.continuation! })).status).toBe(400);
    expect((await owner({ type: 'all', limit: '1' })).body.continuation).toBeNull();
  },
};
