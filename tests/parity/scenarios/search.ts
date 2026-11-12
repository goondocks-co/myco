import { expect } from 'bun:test';
import type { SearchAcrossAnswer, SearchAnswer } from '@goondocks/myco-shared/search-types';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { ageRows, expectPersisted, waitFor, type ParityScenario, type ParityTarget } from '../harness.ts';
import { allowWorkerClaims, createProject, event, mcp, owner, putSetting, untilPublished, wake } from '../clients/requests.ts';
import { saveSpore, writeDueCards, writeSessionTitle } from '../clients/knowledge.ts';

export const search: ParityScenario = {
  name: 'search: scoped HTTP and MCP, every kind, spilled bodies, updates and explicit semantic availability',
  // A claim takes the next queued run on the Deployment. This scenario's title and card runs stay off the shared queue.
  dedicated: { timeoutMs: 180_000 },
  async run(target: ParityTarget) {
    const stamp = Date.now();
    const at = stamp - 3_600_000;
    const word = `cobalt${stamp}`;
    const session = `search-${stamp}`;
    const prompt = crypto.randomUUID();
    const response = crypto.randomUUID();
    const plan = crypto.randomUUID();
    const post = (kind: string, payload: Record<string, unknown>) => event(target, session, kind, payload, at);
    const searchFor = async (query: string, extra: Record<string, string> = {}) => {
      const res = await owner<SearchAnswer>(target, `/api/projects/${target.projectId}/search?${new URLSearchParams({ q: query, limit: '20', ...extra })}`);
      expect(res.status).toBe(200);
      return res.body;
    };
    await allowWorkerClaims(target);
    for (const [leaf, value] of [['agent.scheduled_tasks_enabled', true], ['agent.tasks', { 'title-summary': { schedule: { maxRunsPerDay: 0 } } }]] as const) expect((await putSetting(target, leaf, value)).status).toBe(200); // Due cards are pulled while scheduled work is on.
    await post('session.start', { agent: 'claude-code', startedAt: at });
    const text = `${word} ${'filler '.repeat(160_000)} distantneedle`;
    const bytes = new TextEncoder().encode(text);
    const key = await sha256HexOf(bytes);
    await expectPersisted(await fetch(`${target.url}/blobs/${key}`, {
      method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'text/plain; charset=utf-8', 'content-length': String(bytes.length) }, body: bytes,
    }), 'large text blob');
    await post('prompt', { promptId: prompt, blob: key, origin: 'user' });
    await post('response', { responseId: response, promptId: prompt, blob: key });
    await post('plan', { planKey: plan, promptId: prompt, title: `${word} titleword`, blob: key, status: 'active' });
    // An ended session is quiet at once, so its card deadline is the turn's due instant rather than the idle close.
    await post('session.end', { endedAt: at });
    const spore = await saveSpore(target, `${word} advice`, target.projectId, 'decision');
    const published = await untilPublished(target,
      () => owner<{ rows?: Array<{ promptId: string }> }>(target, `/api/projects/${target.projectId}/sessions/${session}/turns`),
      (page) => page.status === 200 && (page.body.rows ?? []).some((row) => row.promptId === prompt));
    expect(published.status).toBe(200);
    await ageRows(target, { table: 'turn_cards', column: 'due_at', byMs: 3_600_000, match: { project_id: target.projectId, session_id: session } });
    // Settlement marks the turn due, and the deadline pass then lists it for a worker.
    const due = await untilPublished(target, () => owner<{ needsYou: Array<{ key: string }> }>(target, `/api/work/now?project=${target.projectId}`), (read) => read.status === 200 && read.body.needsYou.some((item) => item.key === `pulled:${target.projectId}:turn-cards`));
    expect(due.status).toBe(200);
    await writeDueCards(target, `${word} card for the turn that reached distantneedle`);
    await writeSessionTitle(target, session, word, 'The session search finds by its title.');
    // A wake runs the index in the background on a Deployment that defers its work: wake, then read until the body is indexed.
    const indexed = await waitFor(async () => { await wake(target); return searchFor(word); }, (answer) => answer.coverage.pendingBlobs === 0);
    expect(indexed.coverage.pendingBlobs).toBe(0);
    expect(indexed.hits.map((r) => r.type).sort()).toEqual(['card', 'plan', 'session', 'spore']);
    expect({ ...await mcp(target, 'myco_search', { query: word, limit: 20 }) as unknown as SearchAnswer, asOf: 0 }).toEqual({ ...indexed, asOf: 0 });
    expect((await searchFor(`${word} distantneedle`)).hits.map((r) => r.id).sort()).toEqual([prompt, plan].sort());
    expect((await searchFor(word, { type: 'card' })).hits.map((r) => [r.type, r.id])).toEqual([['card', prompt]]);
    expect((await searchFor('titleword distantneedle')).hits.map((r) => r.id)).toEqual([plan]);
    expect((await searchFor(word, { observation_type: 'decision' })).hits.map((r) => r.id)).toEqual([spore.id]);
    expect(await searchFor(word, { mode: 'semantic' })).toMatchObject({ hits: [], mode: 'semantic', provider_unavailable: true });
    // Ranked matches page by cursor through every match once, on every store. Ids and times are the server's.
    const paged = `pagedword${stamp}`;
    for (let i = 0; i < 7; i += 1) await saveSpore(target, `${`${paged} `.repeat(1 + (i % 3))}body ${i}`);
    const walked: string[] = [];
    for (let cursor: string | null = null, page = 0; page < 10; page += 1) {
      const answer = await searchFor(paged, { type: 'spore', mode: 'fts', limit: '3', ...(cursor === null ? {} : { cursor }) });
      walked.push(...answer.hits.map((r) => r.id));
      cursor = answer.nextCursor;
      if (cursor === null) break;
    }
    expect({ n: walked.length, unique: new Set(walked).size }).toEqual({ n: 7, unique: 7 });
    const base = `${target.url}/api/projects/${target.projectId}/search`;
    expect((await fetch(`${base}?q=${word}`, { headers: target.memberHeaders() })).status).toBe(401);
    expect((await fetch(`${base}?q=${word}&type=canopy`, { headers: target.ownerHeaders() })).status).toBe(400);
    const foreign = `proj_foreign_${stamp}`;
    expect((await createProject(target, foreign, 'Foreign')).status).toBe(201);
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
    const archived = await saveSpore(target, `${word} archived`, foreign);
    expect((await owner(target, `/api/projects/${foreign}/archive`, { method: 'POST' })).status).toBe(200);
    const everywhere = await across(word);
    expect(everywhere.status).toBe(200);
    expect(everywhere.body).toMatchObject({ mode: 'fts', provider_unavailable: false, coverage: { pendingBlobs: 0 } });
    expect(found(everywhere.body)).toEqual(indexed.hits.map((r) => `${target.projectId}/${r.type}/${r.id}`).sort());
    expect(found((await across(word, [foreign])).body)).toEqual([`${foreign}/spore/${archived.id}`]);
    expect(found((await across(`${word} distantneedle`, [target.projectId, foreign])).body))
      .toEqual([`${target.projectId}/card/${prompt}`, `${target.projectId}/plan/${plan}`].sort());
    expect((await across(word, [], { mode: 'semantic' })).status).toBe(400);
    expect((await across(word, [`proj_absent_${stamp}`])).status).toBe(404);
    expect((await fetch(`${target.url}/api/search?q=${word}`, { headers: target.memberHeaders() })).status).toBe(401);
    // The owner holdoff is the titling run bound plus its overrun margin, so the stamp is aged past it before the second ask.
    await ageRows(target, { table: 'sessions', column: 'titled_at', byMs: 600_000, match: { project_id: target.projectId, session_id: session } }); await writeSessionTitle(target, session, 'changed title', 'The session no longer matches the word.');
    const retitled = await untilPublished(target, () => searchFor(word), (answer) => !answer.hits.some((hit) => hit.type === 'session'), 4);
    expect(retitled.hits.map((r) => r.type).sort()).toEqual(['card', 'plan', 'spore']);
  },
};
