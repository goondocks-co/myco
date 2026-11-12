import { expect } from 'bun:test';
import type { SearchAnswer, SearchResult } from '@goondocks/myco-shared/search-types';
import { expectPersisted, type ParityScenario, type ParityTarget } from '../harness.ts';

import { cardSession, learningSettings, publishedTurns } from '../clients/capture.ts';
import { event, createProject } from '../clients/requests.ts';

const MATCHES = 5;
const PAGE = 2;

/** Cards written by a claimed run page in the same order over HTTP and MCP, scoped to their session. */
export const searchPaging: ParityScenario = {
  name: 'search by time: a session\'s identical card matches reached by cursor past cards elsewhere, once each, on HTTP and MCP',
  dedicated: { timeoutMs: 180_000 },
  async run(target: ParityTarget) {
    await learningSettings(target);
    const stamp = Date.now();
    const word = `zirconium${stamp}`;
    const session = `paging-${stamp}`;
    const elsewhere = `paging-elsewhere-${stamp}`;
    const at = stamp - 3_600_000;
    const post = async (sessionId: string, kind: string, payload: Record<string, unknown>) => {
      await expectPersisted(await fetch(`${target.url}/events`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind, createdAt: at, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
      }), kind);
    };
    const owner = async (extra: Record<string, string>) => {
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/search?${new URLSearchParams({ q: word, type: 'card', session_id: session, mode: 'fts', order: 'time', ...extra })}`, { headers: target.ownerHeaders() });
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
    const cards = async (sessionId: string, keys: string[], text: string) => {
      await post(sessionId, 'session.start', { agent: 'claude-code', startedAt: at });
      for (const promptId of keys) await post(sessionId, 'prompt', { promptId, text, origin: 'user' });
      await post(sessionId, 'session.end', { endedAt: at });
      await publishedTurns(target, sessionId, rows => rows.length === keys.length);
      await cardSession(target, sessionId, text);
    };
    const everyCard = Array.from({ length: MATCHES }, () => crypto.randomUUID()).sort();
    await cards(session, everyCard, `${word} identical words`);
    await cards(elsewhere, [crypto.randomUUID()], `${word} identical words`);
    const foreign = `proj_${crypto.randomUUID()}`;
    expect((await createProject(target, foreign, 'Foreign paging')).status).toBe(201);
    const capture = async () => {
      await event(target, 'noise', 'prompt', { promptId: crypto.randomUUID(), text: 'unrelated text', origin: 'user' }, at, foreign);
    };
    const walk = async (limit: number): Promise<{ results: SearchResult[]; pages: SearchResult[][] }> => {
      const pages: SearchResult[][] = [];
      let cursor: string | null = null;
      do {
        const page = await owner(cursor === null ? { limit: String(limit) } : { limit: String(limit), cursor });
        expect(page.status).toBe(200);
        pages.push(page.body.hits);
        cursor = page.body.nextCursor;
        if (pages.length > MATCHES) throw new Error('search cursor did not end');
        if (cursor !== null) {
          expect(page.body.hits).toHaveLength(limit);
          if (pages.length === 1) await capture();
        }
      } while (cursor !== null);
      return { results: pages.flat(), pages };
    };
    const byPage = await walk(PAGE);
    expect(byPage.pages).toHaveLength(Math.ceil(everyCard.length / PAGE));
    // Every card of the session once, none of the other session's, oldest first and by id among equal times.
    expect(byPage.results.map((r) => r.id)).toEqual(everyCard);
    expect(byPage.results.every((r) => r.session_id === session && r.created_at === at)).toBe(true);
    // Relevance order pages too: its cursor continues past the page it answered, repeating no match.
    const relevant = await owner({ order: 'relevance', limit: '2' });
    expect(relevant.body.hits).toHaveLength(2);
    expect(relevant.body.nextCursor).not.toBeNull();
    const relevantNext = await owner({ order: 'relevance', limit: '2', cursor: relevant.body.nextCursor! });
    expect(relevantNext.body.hits).toHaveLength(2);
    expect(new Set([...relevant.body.hits, ...relevantNext.body.hits].map((r) => r.id)).size).toBe(4);

    // The MCP tool lists the same matches by the same cursor.
    const first = await mcp<SearchAnswer>({ query: word, type: 'card', session_id: session, mode: 'fts', order: 'time', limit: PAGE });
    expect(first.hits.map((r) => r.id)).toEqual(everyCard.slice(0, PAGE));
    expect(first.nextCursor).not.toBeNull();
    const second = await mcp<SearchAnswer>({ query: word, type: 'card', session_id: session, mode: 'fts', order: 'time', limit: PAGE, cursor: first.nextCursor });
    expect(second.hits.map((r) => r.id)).toEqual(everyCard.slice(PAGE, 2 * PAGE));
    expect((await mcp<SearchAnswer>({ query: word, type: 'card', session_id: session, mode: 'fts', limit: PAGE })).nextCursor).not.toBeNull();

    // A cursor the search did not issue is refused, as is a time cursor on relevance order or on another search; a search of several kinds ranks and continues by its own cursor.
    expect((await owner({ cursor: 'nonsense' })).status).toBe(400);
    expect((await owner({ order: 'relevance', cursor: first.nextCursor! })).status).toBe(400);
    expect((await owner({ type: 'all', cursor: first.nextCursor! })).status).toBe(400);
    expect((await owner({ type: 'spore', cursor: first.nextCursor! })).status).toBe(400);
    expect((await owner({ type: 'all', order: 'relevance', limit: '1' })).body.nextCursor).not.toBeNull();
  },
};
