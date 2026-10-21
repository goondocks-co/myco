import { expect } from 'bun:test';
import type { SearchAnswer, SearchResult } from '@goondocks/myco-shared/search-types';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { expectPersisted, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

const MATCHES = 105;
const PAGE = 20;

/**
 * A session's conversation listed by time page by page on both targets: a hundred and more prompts of identical text and
 * time, a steering prompt, a prompt whose body is stored apart, and a reply, reached through the Project's search route
 * and the MCP tool by cursor, each match once, in one order, never another session's, and past unrelated capture in
 * another Project between pages.
 */
export const searchPaging: ParityScenario = {
  name: 'search by time: a session\'s identical-text matches, a steering prompt and a stored body reached by cursor past capture elsewhere, once each, on HTTP and MCP',
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
    const foreign = `foreign-paging-${stamp}`;
    await target.sql(`INSERT INTO projects(project_id,name,created_at) VALUES (${lit(foreign)},'Foreign',${stamp})`);
    let noise = 0;
    // Unrelated capture in another Project, between a walk's pages, moves every match's relevance score and no match's place in the list.
    const capture = async () => {
      for (let i = 0; i < 40; i++) {
        noise += 1;
        await target.sql(`INSERT INTO prompt_batches (project_id, session_id, prompt_id, event_id, text, origin, content_hash, created_at, updated_at, token_id, received_at)
          VALUES (${lit(foreign)}, 'noise', ${lit(`noise-${stamp}-${noise}`)}, ${lit(`noise-event-${stamp}-${noise}`)}, ${lit(`unrelated text ${noise} ${'words '.repeat(noise)}`)}, 'user', ${lit(`noise-hash-${noise}`)}, ${stamp}, ${stamp}, 'tok', ${stamp})`);
      }
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
    expect(byPage.pages).toHaveLength(Math.ceil(everyPrompt.length / PAGE));
    // Every prompt of the session once, none of the other session's, oldest first and by id among equal times.
    expect(byPage.results.map((r) => r.id)).toEqual(everyPrompt);
    expect(byPage.results.every((r) => r.session_id === session && r.created_at === at)).toBe(true);
    // The 21st and the 101st match come the same at any page size.
    const wide = await walk(100);
    expect(wide.pages).toHaveLength(2);
    expect(wide.results.map((r) => r.id)).toEqual(everyPrompt);
    expect(wide.pages[1]![0]!.id).toBe(everyPrompt[100]);
    expect(byPage.pages[1]![0]!.id).toBe(everyPrompt[PAGE]);
    // Each hit names its turn: a steering prompt opens the turn it steers, and a stored body opens its own.
    expect(byPage.results.find((r) => r.id === steer)).toMatchObject({ created_at: at, turn: { prompt_id: same[0], preview: `${word} identical words` } });
    expect(byPage.results.find((r) => r.id === stored)).toMatchObject({ turn: { prompt_id: stored, preview: null, text_chars: null, stored: true } });
    expect(byPage.results.find((r) => r.id === same[1])).toMatchObject({ created_at: at, turn: { prompt_id: same[1], stored: false } });
    const [reply] = (await owner({ type: 'response' })).body.results;
    // Relevance order stays one bounded page with no cursor, and refuses one.
    const relevant = await owner({ order: 'relevance', limit: '5' });
    expect(relevant.body.results).toHaveLength(5);
    expect(relevant.body.cursor).toBeNull();
    expect(reply).toMatchObject({ id: response, created_at: at, prompt_id: same[0], turn: { prompt_id: same[0] } });

    // The MCP tool lists the same matches by the same cursor.
    const first = await mcp<SearchAnswer>({ query: word, type: 'prompt', session_id: session, mode: 'fts', order: 'time', limit: PAGE });
    expect(first.results.map((r) => r.id)).toEqual(everyPrompt.slice(0, PAGE));
    expect(first.cursor).not.toBeNull();
    const second = await mcp<SearchAnswer>({ query: word, type: 'prompt', session_id: session, mode: 'fts', order: 'time', limit: PAGE, cursor: first.cursor });
    expect(second.results.map((r) => r.id)).toEqual(everyPrompt.slice(PAGE, 2 * PAGE));
    expect((await mcp<SearchAnswer>({ query: word, type: 'prompt', session_id: session, mode: 'fts', limit: PAGE })).cursor).toBeNull();

    // A cursor the search did not issue is refused, as is one on relevance order, and a search of several types lists by no time.
    expect((await owner({ cursor: 'nonsense' })).status).toBe(400);
    expect((await owner({ order: 'relevance', cursor: first.cursor! })).status).toBe(400);
    expect((await owner({ type: 'all', cursor: first.cursor! })).status).toBe(400);
    expect((await owner({ type: 'response', cursor: first.cursor! })).status).toBe(400);
    expect((await owner({ type: 'all', order: 'relevance', limit: '1' })).body.cursor).toBeNull();
  },
};
