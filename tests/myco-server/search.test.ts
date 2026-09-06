import { afterEach, describe, expect, it } from 'bun:test';
import { sqliteEnv } from './helpers/fixtures.js';
import { searchProject, sanitizeFtsQuery, SEARCH_TYPES } from '@myco-server-worker/read/search.js';
import { pendingSearchBlobs, reconcileSearchIndex, SEARCH_CHUNK_CHARS, SEARCH_CHUNKS_PER_PASS } from '@myco-server-worker/core/search-index.js';
import { sanitizeFtsQuery as localSanitize } from '@myco/db/queries/search.js';
import { createBackup, restoreArtifact } from '@myco-server-worker/core/backup.js';
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
    insert('blobs', { project_id: 'search-a', key, size: bytes.length, media_type: 'text/plain', token_id: 't', received_at: 1000 });
    await f.bucket.put(`search-a/${key}`, new Response(bytes).body);
  };
  const search = (query: string, options = {}) => searchProject(f.db, { projectId: 'search-a' }, { query, ...options });
  return { ...f, insert, base, prompt, plan, blob, search };
}

describe('full-text search', () => {
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
    const target = fixture();
    target.bucket.objects.set('search-a/restore-body', source.bucket.objects.get('search-a/restore-body')!);
    const result = await restoreArtifact(target.db, { text: artifact, allowForeignLineage: true });
    expect(result.tables.prompt_batches.inserted).toBe(1);
    expect((await target.search('restoredneedle')).results.map((r) => r.id)).toEqual(['restored-plan']);
    expect(await pendingSearchBlobs(target.db)).toBe(1);
    const tick = await runTick(target.serverEnv, POWER_THRESHOLDS.deepSleepMs + 100_000);
    expect(tick.state).toBe('active');
    expect((await target.search('deepbody')).results.map((r) => r.id)).toEqual(['restored']);
    const repeated = await restoreArtifact(target.db, { text: artifact, allowForeignLineage: true });
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
    f.insert('skill_records', { project_id: 'search-a', id: 'sk', agent_id: 'search-agent', name: 'cobalt', display_name: 'Cobalt skill', description: 'a skill', path: 'skills/cobalt', created_at: 1000, updated_at: 1000 });
    const result = await f.search('cobalt');
    expect(result.results.map((r) => r.type).sort()).toEqual([...SEARCH_TYPES].sort());
    expect(result.results.some((r) => r.id === 'foreign')).toBe(false);
    expect(result.results.find((r) => r.type === 'plan')?.retrieve?.input.id).toBe('plan');
    expect(result.results.find((r) => r.type === 'prompt')).toMatchObject({ id: 'p', session_id: 's', prompt_id: 'p' });
    expect(result.results.find((r) => r.type === 'prompt')?.retrieve).toBeUndefined();
    expect((await f.search('cobalt', { mode: 'semantic' }))).toMatchObject({ results: [], mode: 'semantic', provider_unavailable: true });
    expect((await f.search('absent')).results).toEqual([]);
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
    for (const q of ['one two', 'skill-evolve', 'a/b.ts', 'quote"value', 'ümlaut x']) expect(sanitizeFtsQuery(q)).toBe(localSanitize(q));
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
    f.bucket.objects.delete('search-a/missing');
    await expect(reconcileSearchIndex(f.db, f.bucket, 1)).rejects.toThrow('missing');
    expect((await f.search('secret')).coverage.pending_blobs).toBe(1);
  });
});
