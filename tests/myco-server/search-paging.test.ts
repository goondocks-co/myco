import { expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { InvalidSearch, searchAcross, searchProject } from '@myco-server-worker/read/search.js';
import type { SearchOptions } from '@goondocks/myco-shared/search-types';
import { withDocumentStores } from './helpers/document-stores.js';
import { archiveProject, unarchiveProject } from '@myco-server-worker/read/sessions.js';
import { setPlanStatus } from '@myco-server-worker/read/plans.js';

const run = (db: RelationalStore, sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values).run();

async function seed(db: RelationalStore) {
  await run(db, "INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_1', 'a', 'built-in', 1, 0)");
  for (const [session, agent, branch] of [['s_codex', 'codex', 'fix'], ['s_claude', 'claude-code', 'main']] as const) {
    await run(db, `INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, title)
      VALUES ('project', ?, 'machine', 'token', 1, 1, ?, ?, ?)`, session, agent, branch, `cobalt work on ${branch}`);
  }
  // Repeated words vary the rank, and every fifth body repeats another's text, so equal ranks fall across page boundaries.
  for (let i = 0; i < 45; i += 1) {
    const words = i % 5 === 0 ? 'cobalt keys' : `${'cobalt '.repeat(1 + (i % 4))}keys number ${i}`;
    await run(db, `INSERT INTO spores (project_id, id, agent_id, session_id, observation_type, status, content, created_at) VALUES ('project', ?, 'agent_1', ?, ?, ?, ?, ?)`,
      `sp_${String(i).padStart(2, '0')}`, i % 2 === 0 ? 's_codex' : 's_claude', i % 3 === 0 ? 'decision' : 'gotcha', i % 4 === 0 ? 'superseded' : 'active', words, 1_000 + (i % 7));
  }
  for (let i = 0; i < 6; i += 1) {
    await run(db, `INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, title, content, content_hash, status, created_at, updated_at, token_id, received_at)
      VALUES ('project', ?, 's_codex', ?, 'machine', ?, '- [ ] a', 'h', ?, 1, 1, 'token', 1)`, `plan_${i}`, `e_${i}`, `cobalt plan ${i}`, i % 2 === 0 ? 'completed' : 'active');
  }
}

/** Every page of one search, followed by its cursor until no more follow. */
async function walk(read: (cursor?: string) => Promise<{ results: { type: string; id: string }[]; cursor: string | null; hasMore: boolean }>) {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page += 1) {
    const answer = await read(cursor);
    seen.push(...answer.results.map((r) => `${r.type}:${r.id}`));
    expect(answer.hasMore).toBe(answer.cursor !== null);
    if (answer.cursor === null) return seen;
    cursor = answer.cursor;
  }
  throw new Error('the walk never ended');
}

const fresh = async (db: RelationalStore, sql: string, ...values: unknown[]) => (await db.prepare(sql).bind(...values).all<{ id: string }>()).results.map((r) => r.id).sort();

it('pages a ranked search through every match once, in one Project, across Projects and across types, on both stores', async () => {
  await withDocumentStores(async (db, target) => {
    await seed(db);
    const scope = { projectId: 'project' };
    const options = (over: Partial<SearchOptions> = {}): SearchOptions => ({ query: 'cobalt', mode: 'fts', limit: 7, ...over });
    const spores = await walk((cursor) => searchProject(db, scope, options({ type: 'spore', ...(cursor === undefined ? {} : { cursor }) })));
    expect({ target, unique: new Set(spores).size, all: spores.slice().sort() })
      .toEqual({ target, unique: 45, all: (await fresh(db, "SELECT id FROM spores WHERE project_id = 'project'")).map((id) => `spore:${id}`) });
    const across = await walk((cursor) => searchAcross(db, { all: true }, options({ type: 'spore', limit: 10, ...(cursor === undefined ? {} : { cursor }) })));
    expect({ target, unique: new Set(across).size }).toEqual({ target, unique: 45 });
    const mixed = await walk((cursor) => searchProject(db, scope, options({ type: 'all', limit: 5, ...(cursor === undefined ? {} : { cursor }) })));
    expect({ target, unique: new Set(mixed).size, kinds: [...new Set(mixed.map((key) => key.split(':')[0]))].sort() })
      .toEqual({ target, unique: mixed.length, kinds: ['plan', 'session', 'spore'] });
    expect(mixed.filter((key) => key.startsWith('spore:'))).toHaveLength(45);
  });
});

it('continues past writes to other indexes, refuses a next page once the searched index changes, and refuses a cursor carried to another search', async () => {
  await withDocumentStores(async (db, target) => {
    await seed(db);
    const scope = { projectId: 'project' };
    const options = (cursor?: string): SearchOptions => ({ query: 'cobalt', type: 'spore', mode: 'fts', limit: 10, ...(cursor === undefined ? {} : { cursor }) });
    const first = await searchProject(db, scope, options());
    expect({ target, hasMore: first.hasMore, n: first.results.length }).toEqual({ target, hasMore: true, n: 10 });
    // A plan written meanwhile does not move the spores' ranking: the walk goes on and lists every spore once.
    await run(db, `INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, title, content, content_hash, status, created_at, updated_at, token_id, received_at)
      VALUES ('project', 'plan_late', 's_codex', 'e_late', 'machine', 'cobalt late', 'x', 'h', 'active', 1, 1, 'token', 1)`);
    const second = await searchProject(db, scope, options(first.cursor!));
    expect({ target, n: second.results.length, overlap: second.results.some((r) => first.results.some((f) => f.id === r.id)) }).toEqual({ target, n: 10, overlap: false });
    await expect(searchProject(db, scope, { ...options(first.cursor!), query: 'keys' })).rejects.toThrow('cursor is not one this search returned');
    await expect(searchProject(db, scope, { ...options(first.cursor!), status: 'active' })).rejects.toThrow(InvalidSearch);
    // A spore written meanwhile moves every spore's rank: the next page is refused, naming the first page to read again.
    await run(db, `INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, created_at) VALUES ('project', 'sp_late', 'agent_1', 'gotcha', 'active', 'cobalt cobalt cobalt cobalt late', 5)`);
    await expect(searchProject(db, scope, options(second.cursor!))).rejects.toThrow('request the first page again without a cursor');
    const again = await walk((cursor) => searchProject(db, scope, options(cursor)));
    expect({ target, unique: new Set(again).size, late: again.includes('spore:sp_late') }).toEqual({ target, unique: 46, late: true });
  });
});

it('narrows every type by the agent and branch of the session a match belongs to, and spores and plans by status', async () => {
  await withDocumentStores(async (db, target) => {
    await seed(db);
    const scope = { projectId: 'project' };
    const ids = async (over: Partial<SearchOptions>) => (await walk((cursor) => searchProject(db, scope, { query: 'cobalt', mode: 'fts', limit: 20, ...over, ...(cursor === undefined ? {} : { cursor }) }))).sort();
    expect({ target, sessions: await ids({ type: 'session', agent: 'codex', branch: 'fix' }) }).toEqual({ target, sessions: ['session:s_codex'] });
    expect({ target, none: await ids({ type: 'session', agent: 'codex', branch: 'main' }) }).toEqual({ target, none: [] });
    expect({ target, spores: await ids({ type: 'spore', agent: 'claude-code' }) })
      .toEqual({ target, spores: (await fresh(db, "SELECT id FROM spores WHERE session_id = 's_claude'")).map((id) => `spore:${id}`) });
    expect({ target, spores: await ids({ type: 'spore', branch: 'fix', status: 'superseded', observation_type: 'decision' }) })
      .toEqual({ target, spores: (await fresh(db, "SELECT id FROM spores WHERE session_id = 's_codex' AND status = 'superseded' AND observation_type = 'decision'")).map((id) => `spore:${id}`) });
    expect({ target, plans: await ids({ type: 'plan', status: 'completed' }) }).toEqual({ target, plans: ['plan:plan_0', 'plan:plan_2', 'plan:plan_4'] });
  });
});

it('refuses a next page once an edit moves the ranking, even with the same token count, or an instant ties are ordered by', async () => {
  await withDocumentStores(async (db, target) => {
    await seed(db);
    const scope = { projectId: 'project' };
    for (let i = 0; i < 45; i += 1) {
      await run(db, `INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, title, content, content_hash, status, created_at, updated_at, token_id, received_at)
        VALUES ('project', ?, 's_codex', ?, 'machine', 'cobalt plan', ?, 'h', 'active', 1, 1, 'token', 1)`, `pl${String(i).padStart(2, '0')}`, `ep_${i}`, 'one two three four five six seven eight nine ten');
    }
    const options = (cursor?: string): SearchOptions => ({ query: 'cobalt', type: 'plan', mode: 'fts', limit: 3, ...(cursor === undefined ? {} : { cursor }) });
    const first = await searchProject(db, scope, options());
    const seen = first.results.map((r) => r.id);
    const unseen = (await fresh(db, "SELECT plan_key AS id FROM plans WHERE project_id = 'project'")).find((id) => !seen.includes(id))!;
    // The same number of words each: one plan unseen so far now says cobalt ten times, one already listed says none.
    await run(db, "UPDATE plans SET content = 'cobalt cobalt cobalt cobalt cobalt cobalt cobalt cobalt cobalt cobalt', content_hash = 'h2' WHERE plan_key = ?", unseen);
    await run(db, "UPDATE plans SET content = 'eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty', content_hash = 'h3' WHERE plan_key = ?", seen[0]);
    await expect(searchProject(db, scope, options(first.cursor!))).rejects.toThrow('request the first page again without a cursor');
    const again = await walk((cursor) => searchProject(db, scope, options(cursor)));
    expect({ target, n: again.length, unique: new Set(again).size }).toEqual({ target, n: new Set(again).size, unique: 51 });
    // Moving the instant a tie is ordered by moves the record within the ranking without touching the index.
    const page = await searchProject(db, scope, { query: 'cobalt', type: 'spore', mode: 'fts', limit: 5 });
    await run(db, "UPDATE spores SET created_at = created_at + 100 WHERE id = 'sp_44'");
    await expect(searchProject(db, scope, { query: 'cobalt', type: 'spore', mode: 'fts', limit: 5, cursor: page.cursor! })).rejects.toThrow('request the first page again');
    // A change outside what a spore search ranks, filters or reaches by (a session's end, a plan's status) leaves the walk
    // going, every spore once.
    const spores = await searchProject(db, scope, { query: 'cobalt', type: 'spore', mode: 'fts', limit: 5 });
    await run(db, "UPDATE sessions SET ended_at = 9 WHERE session_id = 's_codex'");
    await run(db, "UPDATE plans SET status = 'abandoned' WHERE plan_key = 'plan_0'");
    const rest = await walk((cursor) => searchProject(db, scope, { query: 'cobalt', type: 'spore', mode: 'fts', limit: 5, cursor: cursor ?? spores.cursor! }));
    expect({ target, unique: new Set([...spores.results.map((r) => `spore:${r.id}`), ...rest]).size, n: spores.results.length + rest.length }).toEqual({ target, unique: 45, n: 45 });
  });
});

it('refuses a next page once a filter or reach the search reads changes, for every type and the session a match belongs to', async () => {
  await withDocumentStores(async (db, target) => {
    await seed(db);
    await run(db, `INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, title)
      VALUES ('other', 's_other', 'machine', 'token', 1, 1, 'codex', 'fix', 'unrelated')`);
    const scope = { projectId: 'project' };
    const cases: Array<{ name: string; options: Partial<SearchOptions>; change: string; undo: string }> = [
      { name: 'spore status', options: { type: 'spore', status: 'active' }, change: "UPDATE spores SET status = 'active' WHERE id = 'sp_00'", undo: "UPDATE spores SET status = 'superseded' WHERE id = 'sp_00'" },
      { name: 'spore type', options: { type: 'spore', observation_type: 'decision' }, change: "UPDATE spores SET observation_type = 'decision' WHERE id = 'sp_01'", undo: "UPDATE spores SET observation_type = 'gotcha' WHERE id = 'sp_01'" },
      { name: 'spore session', options: { type: 'spore', session_id: 's_codex' }, change: "UPDATE spores SET session_id = 's_codex' WHERE id = 'sp_01'", undo: "UPDATE spores SET session_id = 's_claude' WHERE id = 'sp_01'" },
      { name: 'spore project', options: { type: 'spore' }, change: "UPDATE spores SET project_id = 'other', session_id = NULL WHERE id = 'sp_03'", undo: "UPDATE spores SET project_id = 'project', session_id = 's_claude' WHERE id = 'sp_03'" },
      { name: 'plan status', options: { type: 'plan', status: 'completed' }, change: "UPDATE plans SET status = 'completed' WHERE plan_key = 'plan_1'", undo: "UPDATE plans SET status = 'active' WHERE plan_key = 'plan_1'" },
      { name: 'plan session', options: { type: 'plan', session_id: 's_codex' }, change: "UPDATE plans SET session_id = 's_claude' WHERE plan_key = 'plan_3'", undo: "UPDATE plans SET session_id = 's_codex' WHERE plan_key = 'plan_3'" },
      { name: 'session agent of a spore', options: { type: 'spore', agent: 'codex' }, change: "UPDATE sessions SET agent = 'codex' WHERE session_id = 's_claude'", undo: "UPDATE sessions SET agent = 'claude-code' WHERE session_id = 's_claude'" },
      { name: 'session branch of a spore', options: { type: 'spore', branch: 'main' }, change: "UPDATE sessions SET branch = 'main' WHERE session_id = 's_codex'", undo: "UPDATE sessions SET branch = 'fix' WHERE session_id = 's_codex'" },
      { name: 'session status', options: { type: 'session', status: 'active' }, change: "UPDATE sessions SET ended_at = 2 WHERE session_id = 's_claude'", undo: "UPDATE sessions SET ended_at = NULL WHERE session_id = 's_claude'" },
    ];
    for (const { name, options, change, undo } of cases) {
      const ask = (cursor?: string): SearchOptions => ({ query: 'cobalt', mode: 'fts', limit: 1, ...options, ...(cursor === undefined ? {} : { cursor }) });
      const first = await searchProject(db, scope, ask());
      expect({ target, name, hasMore: first.hasMore }).toEqual({ target, name, hasMore: true });
      await run(db, change);
      await expect(searchProject(db, scope, ask(first.cursor!)), `${target} ${name}`).rejects.toThrow('request the first page again without a cursor');
      await run(db, undo);
    }
  });
});

it('refuses a next page once a release classification it filters by or a Project\'s visibility it reads changes, and a fresh walk lists the new members', async () => {
  await withDocumentStores(async (db, target) => {
    await seed(db);
    const scope = { projectId: 'project' };
    const release = (id: string, state: string, confidence: string) => run(db, `INSERT INTO knowledge_release_state
      (project_id, id, identity_key, namespace, record_id, state, confidence, checked_at, created_at) VALUES ('project', ?, ?, 'spores', ?, ?, ?, 1, 1)`, `rel_${id}`, `key_${id}`, id, state, confidence);
    for (let i = 0; i < 10; i += 1) await release(`sp_${String(i).padStart(2, '0')}`, i % 2 === 0 ? 'released' : 'unknown', i % 2 === 0 ? 'high' : 'low');
    const walkAll = (options: Partial<SearchOptions>) => walk((cursor) => searchProject(db, scope, { query: 'cobalt', type: 'spore', mode: 'fts', limit: 2, ...options, ...(cursor === undefined ? {} : { cursor }) }));
    for (const [filter, change, column] of [
      [{ release_state: 'released' }, "UPDATE knowledge_release_state SET state = 'released' WHERE record_id = 'sp_09'", 'state'],
      [{ release_confidence: 'high' }, "UPDATE knowledge_release_state SET confidence = 'high' WHERE record_id = 'sp_07'", 'confidence'],
    ] as const) {
      const before = await walkAll(filter);
      const first = await searchProject(db, scope, { query: 'cobalt', type: 'spore', mode: 'fts', limit: 2, ...filter });
      await run(db, change);
      await expect(searchProject(db, scope, { query: 'cobalt', type: 'spore', mode: 'fts', limit: 2, ...filter, cursor: first.cursor! }), `${target} ${column}`)
        .rejects.toThrow('request the first page again without a cursor');
      expect({ target, column, grew: (await walkAll(filter)).length - before.length }).toEqual({ target, column, grew: 1 });
    }
    // Every Project's search reads which Projects are visible: unarchiving one adds its matches, archiving one removes them.
    await run(db, "INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, created_at) VALUES ('other', 'sp_other_1', 'agent_1', 'gotcha', 'active', 'cobalt elsewhere', 9), ('other', 'sp_other_2', 'agent_1', 'gotcha', 'active', 'cobalt elsewhere too', 9)");
    expect(await archiveProject(db, 'other', 'mem', 1)).toBe('archived');
    const across = (cursor?: string) => searchAcross(db, { all: true }, { query: 'cobalt', type: 'spore', mode: 'fts', limit: 5, ...(cursor === undefined ? {} : { cursor }) });
    const hidden = await walk(across);
    const page = await across();
    expect(await unarchiveProject(db, 'other')).toBe('restored');
    await expect(across(page.cursor!), `${target} unarchive`).rejects.toThrow('request the first page again without a cursor');
    expect({ target, grew: (await walk(across)).length - hidden.length }).toEqual({ target, grew: 2 });
    const visible = await across();
    expect(await archiveProject(db, 'other', 'mem', 2)).toBe('archived');
    await expect(across(visible.cursor!), `${target} archive`).rejects.toThrow('request the first page again without a cursor');
  });
});

it('keeps fencing a type the walk has exhausted, or that had no matches at all, for the whole of an all-types walk', async () => {
  await withDocumentStores(async (db, target) => {
    await seed(db);
    const scope = { projectId: 'project' };
    const options = (cursor?: string): SearchOptions => ({ query: 'cobalt', type: 'all', mode: 'fts', status: 'active', limit: 3, ...(cursor === undefined ? {} : { cursor }) });
    const planIds = await fresh(db, "SELECT plan_key AS id FROM plans WHERE status = 'active'");
    // Walk until the plans are exhausted while spores remain: every active plan listed, more pages to come.
    let page = await searchProject(db, scope, options());
    const listed = new Set(page.results.map((r) => `${r.type}:${r.id}`));
    while (page.cursor !== null && !planIds.every((id) => listed.has(`plan:${id}`))) {
      page = await searchProject(db, scope, options(page.cursor));
      for (const r of page.results) listed.add(`${r.type}:${r.id}`);
    }
    expect({ target, exhausted: planIds.every((id) => listed.has(`plan:${id}`)), more: page.hasMore }).toEqual({ target, exhausted: true, more: true });
    // An existing plan becomes a match under the status filter; the plans are done in the cursor, and the walk still stops.
    await setPlanStatus(db, scope, 'plan_0', 'active', 'mem', 5);
    await expect(searchProject(db, scope, options(page.cursor!)), `${target} exhausted plans`).rejects.toThrow('request the first page again without a cursor');
    expect({ target, found: (await walk((cursor) => searchProject(db, scope, options(cursor)))).includes('plan:plan_0') }).toEqual({ target, found: true });
    await setPlanStatus(db, scope, 'plan_0', 'completed', 'mem', 6);

    // A type with no match at all on the first page is fenced the same way.
    const onlySpores = (cursor?: string): SearchOptions => ({ query: 'cobalt', type: 'all', mode: 'fts', status: 'obsolete', limit: 1, ...(cursor === undefined ? {} : { cursor }) });
    await run(db, "UPDATE spores SET status = 'obsolete' WHERE id IN ('sp_01', 'sp_02')");
    const first = await searchProject(db, scope, onlySpores());
    expect({ target, kinds: first.results.map((r) => r.type), more: first.hasMore }).toEqual({ target, kinds: ['spore'], more: true });
    await setPlanStatus(db, scope, 'plan_1', 'obsolete', 'mem', 7);
    await expect(searchProject(db, scope, onlySpores(first.cursor!)), `${target} zero-match plans`).rejects.toThrow('request the first page again without a cursor');
  });
});
