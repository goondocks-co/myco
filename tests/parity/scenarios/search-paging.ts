import { expect } from 'bun:test';
import type { SearchAnswer, SearchResult } from '@goondocks/myco-shared/search-types';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

const MATCHES = 105;
const PAGE = 20;

/**
 * A session's turn cards listed by time page by page on both targets: a hundred and more cards of identical text and
 * time, reached through the Project's search route and the MCP tool by cursor, each match once, in one order, never
 * another session's, and past unrelated cards in another Project between pages.
 */
export const searchPaging: ParityScenario = {
  name: 'search by time: a session\'s identical card matches reached by cursor past cards elsewhere, once each, on HTTP and MCP',
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
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/search?${new URLSearchParams({ q: word, type: 'prompt', session_id: session, mode: 'fts', order: 'time', ...extra })}`, { headers: target.ownerHeaders() });
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
    const cards = async (project: string, sessionId: string, keys: readonly string[], text: string, time: number) => target.sql(`INSERT INTO turn_cards
      (project_id, session_id, turn_key, state, card, created_at) SELECT ${lit(project)}, ${lit(sessionId)}, value, 'carded', ${lit(text)}, ${time}
      FROM json_each(${lit(JSON.stringify(keys))})`);

    await post(session, 'session.start', { agent: 'claude-code', startedAt: at });
    await post(elsewhere, 'session.start', { agent: 'claude-code', startedAt: at });
    const everyCard = Array.from({ length: MATCHES }, () => crypto.randomUUID()).sort();
    await cards(target.projectId, session, everyCard, `${word} identical words`, at);
    await cards(target.projectId, elsewhere, [crypto.randomUUID()], `${word} identical words`, at);

    const foreign = `foreign-paging-${stamp}`;
    await target.sql(`INSERT INTO projects(project_id,name,created_at) VALUES (${lit(foreign)},'Foreign',${stamp})`);
    let noise = 0;
    // Unrelated cards in another Project, between a walk's pages, move every match's relevance score and no match's place in the list.
    const capture = async () => {
      const keys = Array.from({ length: 40 }, () => `noise-${stamp}-${++noise}`);
      await cards(foreign, 'noise', keys, `unrelated text ${noise}`, stamp);
    };
    const walk = async (limit: number): Promise<{ results: SearchResult[]; pages: SearchResult[][] }> => {
      const pages: SearchResult[][] = [];
      let cursor: string | null = null;
      do {
        const page = await owner(cursor === null ? { limit: String(limit) } : { limit: String(limit), cursor });
        expect(page.status).toBe(200);
        pages.push(page.body.results);
        cursor = page.body.cursor;
        if (cursor !== null) {
          expect(page.body.results).toHaveLength(limit);
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
    // The 21st and the 101st match come the same at any page size.
    const wide = await walk(100);
    expect(wide.pages).toHaveLength(2);
    expect(wide.results.map((r) => r.id)).toEqual(everyCard);
    expect(wide.pages[1]![0]!.id).toBe(everyCard[100]);
    expect(byPage.pages[1]![0]!.id).toBe(everyCard[PAGE]);
    // A card answers for its turn's replies too: a reply search lists the same cards in the same order.
    expect((await owner({ type: 'response', limit: String(PAGE) })).body.results.map((r) => r.id)).toEqual(everyCard.slice(0, PAGE));
    // Relevance order stays one bounded page with no cursor, and refuses one.
    const relevant = await owner({ order: 'relevance', limit: '5' });
    expect(relevant.body.results).toHaveLength(5);
    expect(relevant.body.cursor).toBeNull();

    // The MCP tool lists the same matches by the same cursor.
    const first = await mcp<SearchAnswer>({ query: word, type: 'prompt', session_id: session, mode: 'fts', order: 'time', limit: PAGE });
    expect(first.results.map((r) => r.id)).toEqual(everyCard.slice(0, PAGE));
    expect(first.cursor).not.toBeNull();
    const second = await mcp<SearchAnswer>({ query: word, type: 'prompt', session_id: session, mode: 'fts', order: 'time', limit: PAGE, cursor: first.cursor });
    expect(second.results.map((r) => r.id)).toEqual(everyCard.slice(PAGE, 2 * PAGE));
    expect((await mcp<SearchAnswer>({ query: word, type: 'prompt', session_id: session, mode: 'fts', limit: PAGE })).cursor).toBeNull();

    // A cursor the search did not issue is refused, as is one on relevance order, and a search of several types lists by no time.
    expect((await owner({ cursor: 'nonsense' })).status).toBe(400);
    expect((await owner({ order: 'relevance', cursor: first.cursor! })).status).toBe(400);
    expect((await owner({ type: 'all', cursor: first.cursor! })).status).toBe(400);
    expect((await owner({ type: 'response', cursor: first.cursor! })).status).toBe(400);
    expect((await owner({ type: 'all', order: 'relevance', limit: '1' })).body.cursor).toBeNull();
  },
};
