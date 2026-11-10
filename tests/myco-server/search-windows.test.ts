import { expect, it } from 'bun:test';
import type { RelationalStore, ServerEnv } from '@myco-server-worker/core/adapters.js';
import { searchAcross, searchDeployment } from '@myco-server-worker/core/search.js';
import { SearchRefused } from '@myco-server-worker/core/search-query.js';
import { SEARCH_WINDOW, SEARCH_WINDOW_TTL_MS, type SearchOptions } from '@goondocks/myco-shared/search-types';
import { SEARCH_WINDOWS_PER_READER } from '@myco-server-worker/db/search/result-windows.js';
import { withDocumentStores } from './helpers/document-stores.js';
import { memoryBlobStore } from './helpers/fixtures.js';

const run = (db: RelationalStore, sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values).run();
const envOf = (db: RelationalStore) => ({ db, blobs: memoryBlobStore() }) as unknown as ServerEnv;
const NOW = 1_800_000_000_000;

/** `count` spores matching "cobalt" in `project`, one second apart, every third with the word in its line. */
async function spores(db: RelationalStore, project: string, count: number, prefix = 'sp') {
  const rows = Array.from({ length: count }, (_, i) => [`${prefix}${String(i).padStart(4, '0')}`, i % 3 === 0 ? 'cobalt keys' : null, 1_000_000 + i * 1_000]);
  for (let start = 0; start < rows.length; start += 200) {
    await run(db, `INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, agent_line, created_at)
      SELECT ?1, json_extract(value, '$[0]'), 'agent_1', 'gotcha', 'active', 'cobalt body', json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?2)`,
    project, JSON.stringify(rows.slice(start, start + 200)));
  }
}

async function seed(db: RelationalStore) {
  await run(db, "INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1', 'a', 'built-in', 1, 0)");
  for (const project of ['project', 'other']) await run(db, 'INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES (?, ?, 0)', project, project);
  await run(db, `INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, title)
    VALUES ('project', 's1', 'machine', 'token', 1, 1, 'cobalt session')`);
}

/** Every page of one search, followed by its cursor until none follows. */
async function walk(read: (cursor?: string) => Promise<{ hits: { type: string; id: string }[]; nextCursor: string | null }>) {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const answer = await read(cursor);
    seen.push(...answer.hits.map((r) => `${r.type}:${r.id}`));
    if (answer.nextCursor === null) return seen;
    cursor = answer.nextCursor;
  }
  throw new Error('the walk never ended');
}

const options = (over: Partial<SearchOptions> = {}): SearchOptions => ({ query: 'cobalt', mode: 'fts', limit: 100, ...over });
const refusal = async (promise: Promise<unknown>) => { try { await promise; } catch (error) { if (error instanceof SearchRefused) return error.code; throw error; } return null; };

it(`walks a relevance search past ${SEARCH_WINDOW} matches to every match once, in a Project, across Projects and across kinds, on both stores`, async () => {
  await withDocumentStores(async (db, target) => {
    await seed(db);
    await spores(db, 'project', SEARCH_WINDOW + 150);
    await spores(db, 'other', 40, 'ot');
    const env = envOf(db);
    const scope = { projectId: 'project' };
    const one = await walk((cursor) => searchDeployment(env, scope, options({ type: 'spore', ...(cursor === undefined ? {} : { cursor }) }), 'member:a', NOW));
    expect({ target, listed: one.length, unique: new Set(one).size }).toEqual({ target, listed: SEARCH_WINDOW + 150, unique: SEARCH_WINDOW + 150 });
    const across = await walk((cursor) => searchAcross(env, { all: true }, options({ type: 'spore', ...(cursor === undefined ? {} : { cursor }) }), 'member:a', NOW));
    expect({ target, unique: new Set(across).size }).toEqual({ target, unique: SEARCH_WINDOW + 190 });
    const mixed = await walk((cursor) => searchDeployment(env, scope, options({ limit: 37, ...(cursor === undefined ? {} : { cursor }) }), 'member:a', NOW));
    expect({ target, unique: new Set(mixed).size, kinds: [...new Set(mixed.map((key) => key.split(':')[0]))].sort() })
      .toEqual({ target, unique: SEARCH_WINDOW + 151, kinds: ['session', 'spore'] });
  });
});

it('reaches the older matches of a filter that rejects the whole newest window, page by page, on both stores', async () => {
  await withDocumentStores(async (db, target) => {
    await seed(db);
    for (const [session, agent] of [['sc', 'claude'], ['sx', 'codex']]) {
      await run(db, "INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent) VALUES ('project', ?, 'machine', 'token', 1, 1, ?)", session, agent);
    }
    await spores(db, 'project', SEARCH_WINDOW + 200);
    // The oldest 40 belong to a Codex session; every newer one to a Claude session.
    await run(db, "UPDATE spores SET session_id = CASE WHEN id < 'sp0040' THEN 'sx' ELSE 'sc' END WHERE project_id = 'project'");
    const env = envOf(db);
    for (const limit of [20, 1]) {
      const first = await searchDeployment(env, { projectId: 'project' }, options({ type: 'spore', agent: 'codex', limit }), 'member:a', NOW);
      const listed = await walk((cursor) => searchDeployment(env, { projectId: 'project' }, options({ type: 'spore', agent: 'codex', limit, ...(cursor === undefined ? {} : { cursor }) }), 'member:a', NOW));
      expect({ target, limit, first: first.hits.length, partial: first.partial, more: first.nextCursor !== null, listed: listed.length, unique: new Set(listed).size })
        .toEqual({ target, limit, first: 0, partial: true, more: true, listed: 40, unique: 40 });
    }
  });
});

it('still lists every remaining match of a filtered search once when records change between its first and second page, on both stores', async () => {
  await withDocumentStores(async (db, target) => {
    await seed(db);
    for (const [session, agent] of [['sc', 'claude'], ['sx', 'codex']]) {
      await run(db, "INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent) VALUES ('project', ?, 'machine', 'token', 1, 1, ?)", session, agent);
    }
    await spores(db, 'project', 40);
    // Codex owns every even spore, so page one examines and rejects the Claude spores between the ones it lists.
    await run(db, "UPDATE spores SET agent_line = NULL, session_id = CASE WHEN CAST(substr(id, 3) AS INTEGER) % 2 = 0 THEN 'sx' ELSE 'sc' END WHERE project_id = 'project'");
    const env = envOf(db);
    const scope = { projectId: 'project' };
    const page = (cursor: string) => searchDeployment(env, scope, options({ type: 'spore', agent: 'codex', limit: 3, cursor }), 'member:a', NOW);
    const first = await searchDeployment(env, scope, options({ type: 'spore', agent: 'codex', limit: 3 }), 'member:a', NOW);
    // Between the pages: delete the Claude spores page one rejected, and give the oldest Codex spore a headline that ranks it first.
    const listedFirst = first.hits.map((hit) => hit.id).sort();
    await run(db, "DELETE FROM spores WHERE project_id = 'project' AND session_id = 'sc' AND id > ?", listedFirst[0]);
    await run(db, "UPDATE spores SET agent_line = 'cobalt' WHERE project_id = 'project' AND id = 'sp0000'");
    const rest = await walk((cursor) => page(cursor ?? first.nextCursor!));
    const all = [...first.hits.map((hit) => `spore:${hit.id}`), ...rest];
    expect({ target, listed: all.length, unique: new Set(all).size, retitled: all.includes('spore:sp0000') }).toEqual({ target, listed: 20, unique: 20, retitled: true });
  });
});

it('lists what the first page ranked after writes land between pages: no refusal, no repeat, and a removed record is gone from the next page', async () => {
  await withDocumentStores(async (db, target) => {
    await seed(db);
    await spores(db, 'project', 30);
    const env = envOf(db);
    const scope = { projectId: 'project' };
    const first = await searchDeployment(env, scope, options({ type: 'spore', limit: 10 }), 'member:a', NOW);
    const second = await searchDeployment(env, scope, options({ type: 'spore', limit: 10, cursor: first.nextCursor! }), 'member:a', NOW);
    await spores(db, 'project', 5, 'new');
    await run(db, "UPDATE spores SET content = 'cobalt edited body' WHERE project_id = 'project' AND id = ?", second.hits[0]!.id);
    const removed = (await searchDeployment(env, scope, options({ type: 'spore', limit: 1, cursor: second.nextCursor! }), 'member:a', NOW)).hits[0]!.id;
    await run(db, "DELETE FROM spores WHERE project_id = 'project' AND id = ?", removed);
    const rest = await walk((cursor) => searchDeployment(env, scope, options({ type: 'spore', limit: 10, cursor: cursor ?? second.nextCursor! }), 'member:a', NOW));
    const listed = [...first.hits, ...second.hits].map((hit) => `spore:${hit.id}`);
    expect({ target, repeats: rest.filter((key) => listed.includes(key)), removed: rest.includes(`spore:${removed}`), total: new Set([...listed, ...rest]).size })
      .toEqual({ target, repeats: [], removed: false, total: 29 });
  });
});

it('continues only for the reader that stored the ranking, until it expires, and evicts a reader\'s oldest ranking instead of refusing a search', async () => {
  await withDocumentStores(async (db, target) => {
    await seed(db);
    await spores(db, 'project', 30);
    const env = envOf(db);
    const scope = { projectId: 'project' };
    const first = await searchDeployment(env, scope, options({ type: 'spore', limit: 5 }), 'member:a', NOW);
    const second = await searchDeployment(env, scope, options({ type: 'spore', limit: 5, cursor: first.nextCursor! }), 'member:a', NOW);
    expect(await refusal(searchDeployment(env, scope, options({ type: 'spore', limit: 5, cursor: second.nextCursor! }), 'member:b', NOW))).toBe('cursor_foreign');
    expect(await refusal(searchDeployment(env, scope, options({ type: 'spore', limit: 5, query: 'keys', cursor: second.nextCursor! }), 'member:a', NOW))).toBe('cursor_foreign');
    expect(await refusal(searchDeployment(env, scope, options({ type: 'spore', limit: 5, cursor: second.nextCursor! }), 'member:a', NOW + SEARCH_WINDOW_TTL_MS + 1))).toBe('cursor_expired');
    const kept = await searchDeployment(env, scope, options({ type: 'spore', limit: 5, cursor: first.nextCursor! }), 'member:a', NOW + 1);
    for (let i = 0; i < SEARCH_WINDOWS_PER_READER; i += 1) {
      const page = await searchDeployment(env, scope, options({ type: 'spore', limit: 5, cursor: first.nextCursor! }), 'member:a', NOW + 2 + i);
      expect(page.hits).toHaveLength(5);
    }
    expect({ target, evicted: await refusal(searchDeployment(env, scope, options({ type: 'spore', limit: 5, cursor: kept.nextCursor! }), 'member:a', NOW + 100)) })
      .toEqual({ target, evicted: 'cursor_expired' });
  });
});
