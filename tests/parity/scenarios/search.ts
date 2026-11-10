import { expect } from 'bun:test';
import type { SearchAcrossAnswer, SearchAnswer } from '@goondocks/myco-shared/search-types';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { expectPersisted, lit, waitFor, type ParityScenario, type ParityTarget } from '../harness.ts';

export const search: ParityScenario = {
  name: 'search: scoped HTTP and MCP, every kind, spilled bodies, updates and explicit semantic availability',
  async run(target: ParityTarget) {
    const stamp = Date.now();
    const word = `cobalt${stamp}`;
    const session = `search-${stamp}`;
    const prompt = crypto.randomUUID();
    const response = crypto.randomUUID();
    const plan = crypto.randomUUID();
    const post = async (kind: string, payload: Record<string, unknown>) => {
      await expectPersisted(await fetch(`${target.url}/events`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: session, kind, createdAt: Date.now(), channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
      }), kind);
    };
    const owner = async (query: string, extra: Record<string, string> = {}) => {
      const res = await fetch(`${target.url}/api/projects/${target.projectId}/search?${new URLSearchParams({ q: query, limit: '20', ...extra })}`, { headers: target.ownerHeaders() });
      expect(res.status).toBe(200);
      return await res.json() as SearchAnswer;
    };
    const mcp = async <T,>(name: string, args: Record<string, unknown>): Promise<T> => {
      const res = await fetch(`${target.url}/mcp`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      const body = await res.json() as { error?: unknown; result: { structuredContent: { result: T } } };
      expect(body.error).toBeUndefined();
      return body.result.structuredContent.result;
    };
    await post('session.start', { agent: 'claude-code', startedAt: stamp });
    const text = `${word} ${'filler '.repeat(160_000)} distantneedle`;
    const bytes = new TextEncoder().encode(text);
    const key = await sha256HexOf(bytes);
    await expectPersisted(await fetch(`${target.url}/blobs/${key}`, {
      method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'text/plain; charset=utf-8', 'content-length': String(bytes.length) }, body: bytes,
    }), 'large text blob');
    await post('prompt', { promptId: prompt, blob: key, origin: 'user' });
    await post('response', { responseId: response, promptId: prompt, blob: key });
    await post('plan', { planKey: plan, promptId: prompt, title: `${word} titleword`, blob: key, status: 'active' });
    const spore = await mcp<{ id: string }>('myco_spores', { op: 'save', agent_line: 'When using this fixture, retain its evidence.', type: 'decision', content: `${word} advice`, project: target.projectId });
    await target.sql(`UPDATE sessions SET title = ${lit(word)} WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(session)}`);
    // A prompt and its replies are found through their turn's card.
    await target.sql(`INSERT INTO turn_cards (project_id, session_id, turn_key, state, card, created_at)
      VALUES (${lit(target.projectId)}, ${lit(session)}, ${lit(prompt)}, 'carded', ${lit(`${word} card for the turn that reached distantneedle`)}, ${stamp})`);
    // A wake runs the index in the background on a Deployment that defers its work: wake, then read until the body is indexed.
    const wake = async () => {
      const res = await fetch(`${target.url}/api/wake`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(200);
      return await owner(word);
    };
    let indexed = await waitFor(wake, (answer) => answer.coverage.pendingBlobs === 0);
    expect(indexed.coverage.pendingBlobs).toBe(0);
    expect(indexed.hits.map((r) => r.type).sort()).toEqual(['card', 'plan', 'session', 'spore']);
    expect({ ...await mcp<SearchAnswer>('myco_search', { query: word, limit: 20 }), asOf: 0 }).toEqual({ ...indexed, asOf: 0 });
    expect((await owner(`${word} distantneedle`)).hits.map((r) => r.id).sort()).toEqual([prompt, plan].sort());
    expect((await owner(word, { type: 'card' })).hits.map((r) => [r.type, r.id])).toEqual([['card', prompt]]);
    expect((await owner('titleword distantneedle')).hits.map((r) => r.id)).toEqual([plan]);
    expect((await owner(word, { observation_type: 'decision' })).hits.map((r) => r.id)).toEqual([spore.id]);
    expect(await owner(word, { mode: 'semantic' })).toMatchObject({ hits: [], mode: 'semantic', provider_unavailable: true });
    // Ranked matches page by cursor through every match once, on every store.
    const paged = `pagedword${stamp}`;
    for (let i = 0; i < 7; i += 1) {
      await target.sql(`INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, created_at) VALUES (${lit(target.projectId)}, ${lit(`sp-paged-${i}-${stamp}`)}, 'user', 'gotcha', 'active', ${lit(`${`${paged} `.repeat(1 + (i % 3))}body ${i}`)}, ${stamp + (i % 2)})`);
    }
    const walked: string[] = [];
    for (let cursor: string | null = null, page = 0; page < 10; page += 1) {
      const answer = await owner(paged, { type: 'spore', mode: 'fts', limit: '3', ...(cursor === null ? {} : { cursor }) });
      walked.push(...answer.hits.map((r) => r.id));
      cursor = answer.nextCursor;
      if (cursor === null) break;
    }
    expect({ n: walked.length, unique: new Set(walked).size }).toEqual({ n: 7, unique: 7 });
    const base = `${target.url}/api/projects/${target.projectId}/search`;
    expect((await fetch(`${base}?q=${word}`, { headers: target.memberHeaders() })).status).toBe(401);
    expect((await fetch(`${base}?q=${word}&type=canopy`, { headers: target.ownerHeaders() })).status).toBe(400);
    const foreign = `foreign-${stamp}`;
    await target.sql(`INSERT INTO projects(project_id,name,created_at) VALUES (${lit(foreign)},'Foreign',${stamp})`);
    const foreignRes = await fetch(`${target.url}/api/projects/${foreign}/search?q=${word}`, { headers: target.ownerHeaders() });
    expect((await foreignRes.json() as SearchAnswer).hits).toEqual([]);

    // Across Projects: the same ranking over the whole set, words only.
    const across = async (query: string, projects: string[] = [], extra: Record<string, string> = {}) => {
      const params = new URLSearchParams({ q: query, limit: '20', ...extra });
      for (const project of projects) params.append('project', project);
      const res = await fetch(`${target.url}/api/search?${params}`, { headers: target.ownerHeaders() });
      return { status: res.status, body: await res.json() as SearchAcrossAnswer };
    };
    const found = (answer: SearchAcrossAnswer) => answer.hits.map((r) => `${r.projectId}/${r.type}/${r.id}`).sort();
    await target.sql(`INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, created_at) VALUES (${lit(foreign)}, ${lit(`sp-${foreign}`)}, 'user', 'gotcha', 'active', ${lit(`${word} archived`)}, ${stamp})`);
    await target.sql(`UPDATE projects SET archived_at = ${stamp}, archived_by = 'parity' WHERE project_id = ${lit(foreign)}`);
    const everywhere = await across(word);
    expect(everywhere.status).toBe(200);
    expect(everywhere.body).toMatchObject({ mode: 'fts', provider_unavailable: false, coverage: { pendingBlobs: 0 } });
    expect(found(everywhere.body)).toEqual(indexed.hits.map((r) => `${target.projectId}/${r.type}/${r.id}`).sort());
    expect(found((await across(word, [foreign])).body)).toEqual([`${foreign}/spore/sp-${foreign}`]);
    expect(found((await across(`${word} distantneedle`, [target.projectId, foreign])).body))
      .toEqual([`${target.projectId}/card/${prompt}`, `${target.projectId}/plan/${plan}`].sort());
    expect((await across(word, [], { mode: 'semantic' })).status).toBe(400);
    expect((await across(word, [`absent-${stamp}`])).status).toBe(404);
    expect((await fetch(`${target.url}/api/search?q=${word}`, { headers: target.memberHeaders() })).status).toBe(401);
    await target.sql(`UPDATE sessions SET title = 'changed title' WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(session)}`);
    expect((await owner(word)).hits.map((r) => r.type).sort()).toEqual(['card', 'plan', 'spore']);
  },
};
