import { afterEach, describe, expect, it } from 'bun:test';
import type { RelationalStore, ServerEnv } from '@myco-server-worker/core/adapters.js';
import { reconcileSearchIndex, SEARCH_CHUNK_BYTES, SEARCH_CHUNKS_PER_PASS, SEARCH_CLAIM_LEASE_MS, SEARCH_RETIRE_PER_PASS } from '@myco-server-worker/core/search-index.js';
import { searchDeployment } from '@myco-server-worker/core/search.js';
import { claimSearchBlob, dueSearchBlob, pendingSearchBlobs, searchBacklog, searchBlobsDue } from '@myco-server-worker/db/search/blob-index.js';
import { blobObjectKeySql } from '@myco-server-worker/core/blob-objects.js';
import { withDocumentStores } from './helpers/document-stores.js';
import { memoryBlobStore } from './helpers/fixtures.js';
import { searchFixture, type SearchFixture } from './helpers/search-fixture.js';

const opened: SearchFixture[] = [];
afterEach(() => { for (const f of opened.splice(0)) f.sqlite.close(); });
const fixture = () => { const f = searchFixture(); opened.push(f); return f; };
const found = async (f: SearchFixture, query: string) => (await f.search(query, { mode: 'fts' })).hits.map((hit) => `${hit.type}:${hit.id}`);
/** A body of `chunks` chunks' worth of filler with `start` first and `end` last. */
const body = (chunks: number, start: string, end: string, filler = 'filler ') => `${start} ${filler.repeat(Math.ceil(chunks * SEARCH_CHUNK_BYTES / new TextEncoder().encode(filler).length))} ${end}`;

describe('indexing a plan body stored apart', () => {
  it('reads a body of several passes whole, with four-byte characters across every chunk end, and finds a phrase across a chunk end', async () => {
    const f = fixture();
    const text = body(SEARCH_CHUNKS_PER_PASS * 2 + 3, 'firstneedle', 'lastneedle', 'a😀 ');
    const half = text.length >> 1;
    await f.blob('emoji', `${text.slice(0, half)} middleneedle ${text.slice(half)}`);
    f.spilledPlan('emoji-plan', 'emoji');
    expect(await pendingSearchBlobs(f.db, 'search-a')).toBe(1);
    await f.index();
    expect({ first: await found(f, 'firstneedle'), middle: await found(f, 'middleneedle'), last: await found(f, 'lastneedle'), pending: await pendingSearchBlobs(f.db, 'search-a') })
      .toEqual({ first: ['plan:emoji-plan'], middle: ['plan:emoji-plan'], last: ['plan:emoji-plan'], pending: 0 });
    const boundary = 'x'.repeat(SEARCH_CHUNK_BYTES - 6);
    await f.blob('edge', `${boundary} straddling phrase here ${'y'.repeat(SEARCH_CHUNK_BYTES)}`);
    f.spilledPlan('edge-plan', 'edge');
    await f.index();
    expect((await f.search('"straddling phrase"', { mode: 'fts' })).hits.map((hit) => hit.id)).toEqual(['edge-plan']);
  });

  it('requests the same bytes for a pass whether it starts one chunk in or a hundred', async () => {
    const f = fixture();
    await f.blob('long', body(110, 'start', 'end'));
    f.spilledPlan('long-plan', 'long');
    const requested: number[] = [];
    const get = f.bucket.get.bind(f.bucket);
    f.bucket.get = async (key, options) => { requested.push(options?.range?.length ?? Infinity); return get(key, options); };
    for (let pass = 0; pass < 7; pass += 1) await reconcileSearchIndex(f.db, f.bucket, Date.now());
    expect(new Set(requested).size).toBe(1);
    expect(requested.length).toBe(7);
  });

  it('takes up a blob whose pass claimed it and never committed once the claim lapses, never while another pass holds it, and stores nothing from a pass whose plan left mid-read', async () => {
    const f = fixture();
    await f.blob('leased', body(1, 'leasedneedle', 'end'));
    f.spilledPlan('leased-plan', 'leased');
    const now = Date.now();
    const due = await dueSearchBlob(f.db, now);
    expect(await claimSearchBlob(f.db, due!, now, now + SEARCH_CLAIM_LEASE_MS)).not.toBeNull();
    expect(await searchBlobsDue(f.db, now + 1)).toBe(false);
    expect(await reconcileSearchIndex(f.db, f.bucket, now + 1)).toBe(0);
    await f.index(now + SEARCH_CLAIM_LEASE_MS + 1);
    expect({ found: await found(f, 'leasedneedle'), end: await found(f, 'end'), pending: await pendingSearchBlobs(f.db, 'search-a') })
      .toEqual({ found: ['plan:leased-plan'], end: ['plan:leased-plan'], pending: 0 });

    const get = f.bucket.get.bind(f.bucket);
    await f.blob('leaving', body(1, 'leavingneedle', 'end'));
    f.spilledPlan('leaving-plan', 'leaving');
    f.bucket.get = async (key, options) => { f.sqlite.run("DELETE FROM plans WHERE plan_key = 'leaving-plan'"); return get(key, options); };
    expect(await reconcileSearchIndex(f.db, f.bucket, now + 10)).toBe(0);
    expect({ found: await found(f, 'leavingneedle'), pending: await pendingSearchBlobs(f.db, 'search-a') }).toEqual({ found: [], pending: 0 });
  });

  it('keeps a missing body waiting and counted, and says how long the oldest has waited', async () => {
    const f = fixture();
    f.insert('blobs', { project_id: 'search-a', key: 'absent', size: 10, media_type: 'text/plain', token_id: 't', received_at: 1000, generation: crypto.randomUUID() });
    f.spilledPlan('absent-plan', 'absent');
    await reconcileSearchIndex(f.db, f.bucket, Date.now());
    expect(await pendingSearchBlobs(f.db)).toBe(1);
    expect((await searchBacklog(f.db)).oldestStoredAt).not.toBeNull();
  });
});

describe('finding plans by a body stored apart', () => {
  /** Every hit of one search, page by page, as `type:id`. */
  const walk = async (f: SearchFixture, query: string, options: Parameters<SearchFixture['search']>[1]) => {
    const listed: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 200; page += 1) {
      const answer = await f.search(query, { mode: 'fts', ...options, ...(cursor === undefined ? {} : { cursor }) });
      listed.push(...answer.hits.map((hit) => `${hit.type}:${hit.id}`));
      if (answer.nextCursor === null) return listed;
      cursor = answer.nextCursor;
    }
    throw new Error('the walk never ended');
  };

  it('finds every plan whose body is the same stored body, and filters each plan by its own status', async () => {
    const f = fixture();
    await f.blob('shared', body(1, 'okapineedle', 'end'));
    f.spilledPlan('older', 'shared', { over: { status: 'active', created_at: 1000 } });
    f.spilledPlan('newer', 'shared', { over: { status: 'completed', created_at: 2000 } });
    await f.index();
    expect({
      all: (await found(f, 'okapineedle')).sort(),
      active: (await f.search('okapineedle', { mode: 'fts', status: 'active' })).hits.map((hit) => hit.id),
      completed: (await f.search('okapineedle', { mode: 'fts', status: 'completed' })).hits.map((hit) => hit.id),
      byTime: (await walk(f, 'okapineedle', { type: 'plan', order: 'time' })).sort(),
    }).toEqual({ all: ['plan:newer', 'plan:older'], active: ['older'], completed: ['newer'], byTime: ['plan:newer', 'plan:older'] });
  });

  it('lists a plan once across every page when its title and several chunks of its body all match, by relevance and by time', async () => {
    const f = fixture();
    await f.blob('lemur-body', body(SEARCH_CHUNKS_PER_PASS, 'lemur', 'lemur', 'lemur filler '));
    f.spilledPlan('lemur-plan', 'lemur-body', { over: { title: 'lemur plan' } });
    for (let i = 0; i < 30; i += 1) f.plan(`inline-${i}`, `a lemur note ${i}`, { title: `note ${i}`, created_at: 1000 + i });
    await f.index();
    for (const options of [{ type: 'plan' as const, limit: 5 }, { type: 'plan' as const, limit: 1, order: 'time' as const }, { limit: 3 }]) {
      const listed = await walk(f, 'lemur', options);
      expect({ options, plan: listed.filter((hit) => hit === 'plan:lemur-plan').length, listed: listed.length }).toEqual({ options, plan: 1, listed: 31 });
    }
  });
});

/** When the body was received: not a whole second, as a capture's instant rarely is. */
const RECEIVED_AT = 1_794_302_352_688;

/** A plan whose body is `text`, written through `db` as capture writes it, its bytes in `blobs`. */
async function spilled(db: RelationalStore, blobs: ReturnType<typeof memoryBlobStore>, planKey: string, key: string, text: string) {
  const run = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values).run();
  const bytes = new TextEncoder().encode(text);
  await run("INSERT OR IGNORE INTO blobs (project_id, key, size, media_type, token_id, received_at, generation) VALUES ('project', ?, ?, 'text/plain', 't', ?, ?)", key, bytes.length, RECEIVED_AT, '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b');
  const objectKey = (await db.prepare(`SELECT ${blobObjectKeySql('project_id', 'key', 'generation')} AS k FROM blobs WHERE project_id = 'project' AND key = ?`).bind(key).first<{ k: string }>())!.k;
  await blobs.put(objectKey, new Response(bytes).body);
  await run(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, title, content, blob_key, content_hash, status, created_at, updated_at, token_id, received_at)
    VALUES ('project', ?, 'session', 'e', 'machine', 'restored plan', NULL, ?, 'h', 'active', 1000, 1000, 't', 1000)`, planKey, key);
  await run("INSERT OR IGNORE INTO processed_resources (project_id, kind, resource_id, blob_key, source_token_id, event_id) VALUES ('project', 'plan', ?, ?, 't', 'e')", planKey, key);
}

it('re-indexes the whole body when a plan returns while its blob is leaving the index, on both stores', async () => {
  await withDocumentStores(async (db, target) => {
    await db.prepare("INSERT OR IGNORE INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('project', 'session', 'machine', 't', 1, 1)").run();
    const blobs = memoryBlobStore();
    const env = { db, blobs } as unknown as ServerEnv;
    const drain = async () => { for (let pass = 0; pass < 40 && await searchBlobsDue(db, Date.now()); pass += 1) await reconcileSearchIndex(db, blobs, Date.now()); };
    const text = body(SEARCH_RETIRE_PER_PASS + 10, 'headneedle', 'tailneedle');
    await spilled(db, blobs, 'plan', 'big', text);
    await drain();
    await db.prepare("DELETE FROM plans WHERE project_id = 'project' AND plan_key = 'plan'").run();
    await reconcileSearchIndex(db, blobs, Date.now());
    await spilled(db, blobs, 'plan', 'big', text);
    await drain();
    const hits = async (query: string) => (await searchDeployment(env, { projectId: 'project' }, { query, mode: 'fts' }, 'member:a')).hits.map((hit) => hit.id);
    expect({ target, head: await hits('headneedle'), tail: await hits('tailneedle'), pending: await pendingSearchBlobs(db, 'project') })
      .toEqual({ target, head: ['plan'], tail: ['plan'], pending: 0 });
  });
});
