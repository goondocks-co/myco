import { afterEach, describe, expect, it } from 'bun:test';
import { registeredObject, sqliteEnv } from './helpers/fixtures.js';
import { registerBlob } from './helpers/d1.js';
import { searchProject, sanitizeFtsQuery, SEARCH_TYPES } from '@myco-server-worker/read/search.js';
import { pendingSearchBlobs, reconcileSearchIndex, SEARCH_CHUNK_CHARS, SEARCH_CHUNKS_PER_PASS } from '@myco-server-worker/core/search-index.js';
import { BackupObjectsMissingError, createBackup, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { runTick, POWER_THRESHOLDS } from '@myco-server-worker/core/tick.js';

const opened: ReturnType<typeof sqliteEnv>[] = [];
afterEach(() => { for (const f of opened.splice(0)) f.sqlite.close(); });
function fixture() {
  const f = sqliteEnv(); opened.push(f);
  const insert = (table: string, row: Record<string, unknown>) => f.sqlite.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row) as (string | number | null)[]);
  insert('agents', { id: 'search-agent', name: 'search', source: 'built-in', enabled: 1, created_at: 1 });
  for (const project of ['search-a', 'search-b']) {
    insert('projects', { project_id: project, name: project, created_at: 1 });
    insert('sessions', { project_id: project, session_id: 's', machine_id: 'm', created_by_token_id: 't', first_received_at: 1000, last_received_at: 1000, title: 'cobalt session' });
  }
  const base = { project_id: 'search-a', session_id: 's', event_id: 'e', token_id: 't', received_at: 1000, created_at: 1000, content_hash: 'hash' };
  const prompt = (id: string, text: string | null, blobKey: string | null = null, project = 'search-a') => insert('prompt_batches', { ...base, project_id: project, prompt_id: id, origin: 'user', updated_at: 1000, text, blob_key: blobKey });
  const plan = (id: string, content: string | null, blobKey: string | null = null) => insert('plans', { ...base, plan_key: id, machine_id: 'm', status: 'active', title: 'cobalt plan', updated_at: 1000, content, blob_key: blobKey });
  const blob = async (key: string, text: string) => {
    const bytes = new TextEncoder().encode(text);
    const objectKey = registerBlob(f.sqlite, { projectId: 'search-a', key, size: bytes.length, tokenId: 't', receivedAt: 1000 });
    await f.bucket.put(objectKey, new Response(bytes).body);
  };
  const search = (query: string, options = {}) => searchProject(f.db, { projectId: 'search-a' }, { query, ...options });
  return { ...f, insert, base, prompt, plan, blob, search };
}

describe('full-text search', () => {
  it('uses the shared harness display for prompt search labels', async () => {
    const f = fixture();
    f.sqlite.run("UPDATE sessions SET agent = 'claude-code' WHERE project_id = 'search-a'");
    f.prompt('envelope', '<system-reminder>cobalt guidance</system-reminder>Ship the change');
    expect((await f.search('cobalt', { type: 'prompt' })).results[0]?.preview).toBe('Ship the change');
    f.prompt('envelope-only', '<local-command-stdout>outputneedle</local-command-stdout>');
    expect((await f.search('outputneedle', { type: 'prompt' })).results[0]?.preview).toBe('Command output');
    f.sqlite.run("UPDATE sessions SET agent = 'opencode' WHERE project_id = 'search-a'");
    expect((await f.search('cobalt', { type: 'prompt' })).results[0]?.preview).toBe('<system-reminder>cobalt guidance</system-reminder>Ship the change');
  });
  it('rolls back chunks with their cursor on failure and converges under overlapping index jobs', async () => {
    const f = fixture();
    await f.blob('retry-body', `${'padding '.repeat(10000)} retryneedle`);
    f.prompt('retry', null, 'retry-body');
    const broken = { ...f.db, batch: (statements: Parameters<typeof f.db.batch>[0]) => f.db.batch([...statements, f.db.prepare('INSERT INTO missing_search_table VALUES (1)')]) };
    await expect(reconcileSearchIndex(broken, f.bucket, 1000)).rejects.toThrow();
    expect(f.sqlite.query('SELECT COUNT(*) AS n FROM search_blob_chunks').get()).toEqual({ n: 0 });
    expect(f.sqlite.query('SELECT next_offset, complete FROM search_blob_queue').get()).toEqual({ next_offset: 0, complete: 0 });
    const counts = await Promise.all([reconcileSearchIndex(f.db, f.bucket, 2000), reconcileSearchIndex(f.db, f.bucket, 2000)]);
    expect(counts.sort()).toEqual([0, 2]);
    expect((await f.search('retryneedle')).results.map((r) => r.id)).toEqual(['retry']);
    expect(await pendingSearchBlobs(f.db)).toBe(0);
  });
  it('treats reserved query words as text and enforces the query budget before reading', async () => {
    const f = fixture();
    f.prompt('operators', 'AND OR NOT NEAR literal words');
    expect((await f.search('AND OR NOT NEAR')).results.map((r) => r.id)).toEqual(['operators']);
    await expect(f.search('word '.repeat(17))).rejects.toThrow('16 terms');
    await expect(f.search('a'.repeat(513))).rejects.toThrow('512 characters');
    expect((await f.search('"')).results).toEqual([]);
  });
  it('restores source records, rebuilds inline search immediately and queues every spilled body once', async () => {
    const source = fixture();
    await source.blob('restore-body', 'restoredneedle deepbody');
    source.prompt('restored', null, 'restore-body');
    source.plan('restored-plan', 'restoredneedle inlinebody');
    await reconcileSearchIndex(source.db, source.bucket, 1000);
    const backup = await createBackup(source.db, source.bucket, { producer: 'test', now: 2000 });
    const artifact = new TextDecoder().decode(source.bucket.objects.get(backup.key)!.bytes);
    expect(artifact).not.toContain('"t":"search_blob');
    // A backup carries no blob bytes: a target without the body registered refuses the whole artifact before writing.
    const bare = fixture();
    await expect(restoreArtifact(bare.db, { authorization: { kind: 'recovery' }, text: artifact, allowForeignLineage: true })).rejects.toBeInstanceOf(BackupObjectsMissingError);
    expect(bare.sqlite.query('SELECT COUNT(*) AS n FROM prompt_batches').get()).toEqual({ n: 0 });
    const target = fixture();
    await target.blob('restore-body', 'restoredneedle deepbody');
    const result = await restoreArtifact(target.db, { authorization: { kind: 'recovery' }, text: artifact, allowForeignLineage: true });
    expect(result.tables.blobs).toEqual({ rows: 1, inserted: 0, reused: 1 });
    expect(result.tables.prompt_batches.inserted).toBe(1);
    expect((await target.search('restoredneedle')).results.map((r) => r.id)).toEqual(['restored-plan']);
    expect(await pendingSearchBlobs(target.db)).toBe(1);
    const tick = await runTick(target.serverEnv, POWER_THRESHOLDS.deepSleepMs + 100_000);
    expect(tick.state).toBe('active');
    expect((await target.search('deepbody')).results.map((r) => r.id)).toEqual(['restored']);
    const repeated = await restoreArtifact(target.db, { authorization: { kind: 'recovery' }, text: artifact, allowForeignLineage: true });
    expect(Object.values(repeated.tables).every((table) => table.inserted === 0)).toBe(true);
    expect(await pendingSearchBlobs(target.db)).toBe(0);
  });

  it('keeps Unicode intact at both the chunk end and the overlapping resume offset', async () => {
    const f = fixture();
    const content = `${'a'.repeat(SEARCH_CHUNK_CHARS - 514)}𐐀𐐁 z ${'b'.repeat(SEARCH_CHUNK_CHARS)} tailneedle`;
    await f.blob('unicode', content);
    f.prompt('unicode', null, 'unicode');
    await reconcileSearchIndex(f.db, f.bucket, 1000);
    const rows = f.sqlite.query<{ text: string; offset: number }, []>('SELECT text, offset FROM search_blob_chunks ORDER BY offset').all();
    for (const row of rows) {
      expect(row.text).toBe(content.slice(row.offset, row.offset + row.text.length));
      expect(row.text.isWellFormed()).toBe(true);
    }
    expect((await f.search('tailneedle')).results.map((r) => r.id)).toEqual(['unicode']);
  });
  it('finds every retained type with actionable IDs and keeps another project out', async () => {
    const f = fixture();
    f.prompt('p', 'cobalt prompt'); f.prompt('foreign', 'cobalt secret', null, 'search-b');
    f.insert('responses', { ...f.base, response_id: 'r', prompt_id: 'p', text: 'cobalt response' });
    f.plan('plan', 'cobalt body');
    f.insert('spores', { project_id: 'search-a', id: 'sp', agent_id: 'search-agent', content: 'cobalt spore', observation_type: 'decision', created_at: 1000 });
    const result = await f.search('cobalt');
    expect(result.results.map((r) => r.type).sort()).toEqual([...SEARCH_TYPES].sort());
    expect(result.results.some((r) => r.id === 'foreign')).toBe(false);
    expect(result.results.find((r) => r.type === 'plan')?.retrieve?.input.id).toBe('plan');
    expect(result.results.find((r) => r.type === 'prompt')).toMatchObject({ id: 'p', session_id: 's', prompt_id: 'p' });
    expect(result.results.find((r) => r.type === 'prompt')?.retrieve).toBeUndefined();
    expect((await f.search('cobalt', { mode: 'semantic' }))).toMatchObject({ results: [], mode: 'semantic', provider_unavailable: true });
    expect((await f.search('absent')).results).toEqual([]);
    for (const type of ['skill', 'skills', 'skill_records']) await expect(f.search('cobalt', { type })).rejects.toThrow('unsupported search type');
  });

  it('keeps a spore among hundreds of prompts and applies filters before the limit', async () => {
    const f = fixture();
    for (let i = 0; i < 200; i++) f.prompt(`p${i}`, 'cobalt common');
    f.insert('spores', { project_id: 'search-a', id: 'sp', agent_id: 'search-agent', content: 'cobalt advice', observation_type: 'decision', status: 'active', created_at: 2000 });
    expect((await f.search('cobalt')).results.some((r) => r.id === 'sp')).toBe(true);
    expect((await f.search('cobalt', { observation_type: 'decision', since: 2, until: 2 })).results.map((r) => r.id)).toEqual(['sp']);
    expect((await f.search('cobalt', { status: 'obsolete' })).results).toEqual([]);
    await expect(f.search('cobalt', { limit: 0 })).rejects.toThrow('limit');
  });

  it('updates and deletes the index through source writes and quotes path syntax like 1.4', async () => {
    const f = fixture(); f.plan('p', 'oldword');
    f.sqlite.exec("UPDATE plans SET content='packages/myco/src/search.ts newword' WHERE plan_key='p'");
    expect((await f.search('oldword')).results).toEqual([]);
    expect((await f.search('packages/myco/src/search.ts')).results.map((r) => r.id)).toEqual(['p']);
    f.sqlite.exec("DELETE FROM plans WHERE plan_key='p'");
    expect((await f.search('newword')).results).toEqual([]);
    // The quoting 1.4's sanitizer gives each query, which the server's keeps.
    const AS_1_4: ReadonlyArray<[string, string]> = [
      ['one two', 'one two'],
      ['canopy-map', '"canopy-map"'],
      ['a/b.ts', '"a/b.ts"'],
      ['quote"value', '"quote""value"'],
      ['ümlaut x', '"ümlaut" x'],
    ];
    for (const [q, quoted] of AS_1_4) expect({ q, quoted: sanitizeFtsQuery(q) }).toEqual({ q, quoted });
  });

  it('indexes large blob bodies resumably, matches across chunks and title/body, and removes stale hits', async () => {
    const f = fixture();
    const text = 'firstword ' + 'padding '.repeat(Math.ceil(SEARCH_CHUNK_CHARS * (SEARCH_CHUNKS_PER_PASS + 2) / 8)) + ' lastword';
    await f.blob('blob', text); f.plan('p', null, 'blob'); f.prompt('prompt', null, 'blob');
    expect(await pendingSearchBlobs(f.db)).toBe(1);
    await reconcileSearchIndex(f.db, f.bucket, 1);
    expect(await pendingSearchBlobs(f.db)).toBe(1);
    await reconcileSearchIndex(f.db, f.bucket, 2);
    expect(await pendingSearchBlobs(f.db)).toBe(0);
    expect((await f.search('firstword lastword')).results.map((r) => r.id).sort()).toEqual(['p', 'prompt']);
    expect((await f.search('cobalt lastword')).results.map((r) => r.id)).toEqual(['p']);
    f.sqlite.exec("UPDATE plans SET content='replacement', blob_key=NULL WHERE plan_key='p'");
    expect((await f.search('lastword')).results.map((r) => r.id)).toEqual(['prompt']);
    expect(await reconcileSearchIndex(f.db, f.bucket, 3)).toBe(0);
  });

  it('surfaces missing blobs without falsely completing the index', async () => {
    const f = fixture(); await f.blob('missing', 'secret'); f.prompt('p', null, 'missing');
    f.bucket.objects.delete(registeredObject(f.sqlite, 'search-a', 'missing')!);
    await expect(reconcileSearchIndex(f.db, f.bucket, 1)).rejects.toThrow('missing');
    expect((await f.search('secret')).coverage.pending_blobs).toBe(1);
  });
});

describe('listing a search of one type by time', () => {
  type Row = { id: string; score: number; created_at: number };
  /** Every page of a search by time, following each page's cursor to the one that names none. */
  async function pages(f: ReturnType<typeof fixture>, query: string, options: Record<string, unknown>) {
    const answers = [];
    let cursor: string | undefined;
    do {
      const answer = await f.search(query, { order: 'time', ...(cursor === undefined ? options : { ...options, cursor }) });
      answers.push(answer);
      cursor = answer.cursor ?? undefined;
    } while (cursor !== undefined);
    return answers;
  }
  const ids = (answers: { results: Row[] }[]) => answers.flatMap((answer) => answer.results.map((r) => r.id));

  it('reaches every match of identical text and time, once each, in one stable order, whatever the page size', async () => {
    const f = fixture();
    const all = Array.from({ length: 105 }, (_, i) => `p${String(i).padStart(3, '0')}`);
    for (const id of all) f.prompt(id, 'cobalt common words');
    for (const limit of [20, 100, 7]) {
      const answers = await pages(f, 'cobalt', { type: 'prompt', limit });
      expect(answers.map((a) => a.results.length).slice(0, -1).every((n) => n === limit)).toBe(true);
      expect(answers.slice(0, -1).every((a) => a.cursor !== null)).toBe(true);
      // Equal time orders by id, so the 21st and the 101st match are the same ones at any page size.
      expect(ids(answers)).toEqual(all);
    }
    const first = await f.search('cobalt', { type: 'prompt', order: 'time', limit: 20 });
    const second = await f.search('cobalt', { type: 'prompt', order: 'time', limit: 20, cursor: first.cursor! });
    expect(second.results[0]!.id).toBe('p020');
    const wide = await f.search('cobalt', { type: 'prompt', order: 'time', limit: 100 });
    expect((await f.search('cobalt', { type: 'prompt', order: 'time', limit: 100, cursor: wide.cursor! })).results.map((r) => r.id)).toEqual(all.slice(100));
    await expect(f.search('cobalt', { type: 'prompt', order: 'time', limit: 105 })).rejects.toThrow('limit');
  });

  it('lists matches oldest first, then by id, whatever their relevance', async () => {
    const f = fixture();
    const at = (id: string, createdAt: number, text: string) => f.insert('prompt_batches', { ...f.base, prompt_id: id, origin: 'user', updated_at: createdAt, created_at: createdAt, text });
    for (const [id, createdAt] of [['a', 3000], ['b', 1000], ['c', 1000], ['d', 2000], ['e', 1000]] as const) at(id, createdAt, 'cobalt common');
    at('rare', 500, 'cobalt rare rare rare');
    for (let i = 0; i < 40; i++) at(`filler${String(i).padStart(2, '0')}`, 400, `cobalt ${'unrelated words '.repeat(i + 1)}`);
    const paged = await pages(f, 'cobalt', { type: 'prompt', limit: 6 });
    const listed = paged.flatMap((a) => a.results);
    expect(listed.map((r) => r.created_at)).toEqual([...listed.map((r) => r.created_at)].sort((x, y) => x - y));
    expect(ids(paged).filter((id) => ['a', 'b', 'c', 'd', 'e'].includes(id))).toEqual(['b', 'c', 'e', 'd', 'a']);
    expect(ids(paged)).toHaveLength(46);
    expect(new Set(ids(paged)).size).toBe(46);
  });

  it('pages on past capture that changes every rank: another Project\'s records and new matches between pages lose and repeat nothing', async () => {
    const f = fixture();
    const all = Array.from({ length: 105 }, (_, i) => `p${String(i).padStart(3, '0')}`);
    for (const id of all) f.prompt(id, 'cobalt common words');
    const rankOf = () => f.sqlite.query<{ rank: number }, []>("SELECT rank FROM prompt_batches_fts WHERE prompt_batches_fts MATCH 'cobalt' LIMIT 1").get()!.rank;
    const rankBefore = rankOf();
    const first = await f.search('cobalt', { type: 'prompt', order: 'time', limit: 20 });
    // Unrelated capture, in another Project, moves every match's relevance score.
    for (let i = 0; i < 200; i++) f.prompt(`noise${i}`, `unrelated text ${i}`, null, 'search-b');
    const rest = [];
    let cursor: string | null = first.cursor;
    while (cursor !== null) {
      const page = await f.search('cobalt', { type: 'prompt', order: 'time', limit: 20, cursor });
      rest.push(...page.results.map((r) => r.id));
      cursor = page.cursor;
    }
    expect(rankOf()).not.toBe(rankBefore);
    expect([...first.results.map((r) => r.id), ...rest]).toEqual(all);
  });

  it('lists a record whose large body matches in several chunks once across pages', async () => {
    const f = fixture();
    const body = `cobalt ${'padding '.repeat(SEARCH_CHUNK_CHARS / 4)} cobalt ${'padding '.repeat(SEARCH_CHUNK_CHARS / 4)} cobalt`;
    await f.blob('long', body);
    f.prompt('long', null, 'long');
    for (let i = 0; i < 5; i++) f.prompt(`p${i}`, 'cobalt short');
    await reconcileSearchIndex(f.db, f.bucket, 1000);
    expect((f.sqlite.query('SELECT COUNT(*) AS n FROM search_blob_chunks').get() as { n: number }).n).toBeGreaterThan(1);
    for (const limit of [1, 2, 100]) {
      const found = ids(await pages(f, 'cobalt', { type: 'prompt', limit }));
      expect([...found].sort()).toEqual(['long', 'p0', 'p1', 'p2', 'p3', 'p4']);
    }
  });

  it('keeps the Project and the session on every page', async () => {
    const f = fixture();
    f.insert('sessions', { project_id: 'search-a', session_id: 'other', machine_id: 'm', created_by_token_id: 't', first_received_at: 1000, last_received_at: 1000 });
    for (let i = 0; i < 12; i++) {
      f.prompt(`own${String(i).padStart(2, '0')}`, 'cobalt words');
      f.insert('prompt_batches', { ...f.base, session_id: 'other', prompt_id: `zother${i}`, origin: 'user', updated_at: 1000, text: 'cobalt words' });
      f.prompt(`zforeign${i}`, 'cobalt words', null, 'search-b');
    }
    const found = ids(await pages(f, 'cobalt', { type: 'prompt', limit: 5, session_id: 's' }));
    expect(found).toEqual(Array.from({ length: 12 }, (_, i) => `own${String(i).padStart(2, '0')}`));
  });

  it('keeps relevance order to one bounded page with no cursor, and refuses a cursor on it', async () => {
    const f = fixture();
    for (let i = 0; i < 30; i++) f.prompt(`p${i}`, 'cobalt common words');
    const answer = await f.search('cobalt', { type: 'prompt', limit: 10 });
    expect(answer.results).toHaveLength(10);
    expect(answer.cursor).toBeNull();
    expect((await f.search('cobalt', { limit: 10, order: 'relevance' })).cursor).toBeNull();
    const { cursor } = await f.search('cobalt', { type: 'prompt', order: 'time', limit: 10 });
    expect(cursor).not.toBeNull();
    await expect(f.search('cobalt', { type: 'prompt', cursor: cursor! })).rejects.toThrow('order=time');
    await expect(f.search('cobalt', { type: 'prompt', order: 'relevance', cursor: cursor! })).rejects.toThrow('order=time');
    await expect(f.search('cobalt', { order: 'newest' })).rejects.toThrow('order must be');
  });

  it('refuses an order by time that cannot page, and a cursor it did not issue or issued for another type', async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) { f.prompt(`p${i}`, 'cobalt'); f.insert('responses', { ...f.base, response_id: `r${i}`, prompt_id: `p${i}`, text: 'cobalt' }); }
    const { cursor } = await f.search('cobalt', { type: 'prompt', order: 'time', limit: 1 });
    expect(cursor).not.toBeNull();
    const forged = (value: unknown) => btoa(JSON.stringify(value)).replace(/=+$/, '');
    const bad = [
      'garbage!', '', 'a'.repeat(2000), forged('text'), forged({ type: 'prompt' }),
      forged({ type: 'prompt', created_at: 'x', id: 'p', project_id: 'search-a' }),
      forged({ type: 'prompt', created_at: 1.5, id: 'p', project_id: 'search-a' }),
      forged({ type: 'prompt', created_at: 1, id: 7, project_id: 'search-a' }),
    ];
    for (const value of bad) await expect(f.search('cobalt', { type: 'prompt', order: 'time', cursor: value })).rejects.toThrow('cursor');
    await expect(f.search('cobalt', { type: 'response', order: 'time', cursor: cursor! })).rejects.toThrow('cursor');
    await expect(f.search('cobalt', { order: 'time' })).rejects.toThrow('one type');
    await expect(f.search('cobalt', { type: 'all', order: 'time', cursor: cursor! })).rejects.toThrow('one type');
    await expect(f.search('cobalt', { type: 'session', order: 'time' })).rejects.toThrow('sessions');
    await expect(f.search('cobalt', { type: 'prompt', order: 'time', mode: 'semantic' })).rejects.toThrow('full-text');
    expect((await f.search('cobalt', { type: 'prompt', order: 'time', mode: 'fts', cursor: cursor! })).results.map((r) => r.id)).toEqual(['p1', 'p2']);
    // A search by time is full text whatever the mode asks, and reports no unavailable provider.
    expect(await f.search('cobalt', { type: 'prompt', order: 'time' })).toMatchObject({ mode: 'fts', provider_unavailable: false });
  });
});

describe('the turn a conversation hit names', () => {
  it('gives each hit its own time and the turn it opens, only where the Project\'s session holds the prompt', async () => {
    const f = fixture();
    f.insert('sessions', { project_id: 'search-a', session_id: 'other', machine_id: 'm', created_by_token_id: 't', first_received_at: 1000, last_received_at: 1000 });
    const prompt = (id: string, over: Record<string, unknown>) => f.insert('prompt_batches', { ...f.base, prompt_id: id, origin: 'user', updated_at: 1000, text: 'opening request', ...over });
    const reply = (id: string, promptId: string | null, createdAt: number, over: Record<string, unknown> = {}) =>
      f.insert('responses', { ...f.base, response_id: id, prompt_id: promptId, created_at: createdAt, text: 'cobalt answer', ...over });
    prompt('turn', { created_at: 1000 });
    prompt('steer', { created_at: 1500, parent_prompt_id: 'turn', text: 'steering words' });
    prompt('foreign-turn', { created_at: 900, session_id: 'other' });
    await f.blob('stored', 'a stored opening');
    prompt('stored-turn', { created_at: 1800, text: null, blob_key: 'stored' });
    reply('r_turn', 'turn', 2000);
    reply('r_steer', 'steer', 2100);
    reply('r_stored', 'stored-turn', 2200);
    reply('r_foreign', 'foreign-turn', 2300);
    reply('r_absent', 'never-captured', 2400);
    reply('r_none', null, 2500);
    const hits = new Map((await f.search('cobalt', { type: 'response', limit: 100 })).results.map((r) => [r.id, r]));
    expect([...hits.values()].map((r) => r.created_at).sort()).toEqual([2000, 2100, 2200, 2300, 2400, 2500]);
    expect(hits.get('r_turn')).toMatchObject({ created_at: 2000, prompt_id: 'turn', turn: { prompt_id: 'turn', preview: 'opening request', text_chars: 15, stored: false } });
    // A steering prompt opens the turn it steers.
    expect(hits.get('r_steer')).toMatchObject({ prompt_id: 'steer', turn: { prompt_id: 'turn', preview: 'opening request' } });
    expect(hits.get('r_stored')!.turn).toEqual({ prompt_id: 'stored-turn', preview: null, text_chars: null, stored: true });
    // A prompt of another session, one never captured and none at all leave the hit unlinked, with its own time.
    for (const id of ['r_foreign', 'r_absent', 'r_none']) expect(hits.get(id)!.turn).toBeNull();
    const prompts = (await f.search('opening', { type: 'prompt', limit: 100 })).results;
    expect(prompts.find((r) => r.id === 'steer')).toBeUndefined();
    // A prompt hit opens its own turn, checked against the session the prompt itself belongs to.
    expect(prompts.map((r) => [r.id, r.turn?.prompt_id]).sort()).toEqual([['foreign-turn', 'foreign-turn'], ['turn', 'turn']]);
    // Only a conversation's hits carry a turn.
    f.insert('spores', { project_id: 'search-a', id: 'sp', agent_id: 'search-agent', content: 'cobalt advice', observation_type: 'decision', created_at: 3000 });
    const spore = (await f.search('cobalt', { type: 'spore' })).results[0]!;
    expect(spore.created_at).toBe(3000);
    expect('turn' in spore).toBe(false);
  });
});
