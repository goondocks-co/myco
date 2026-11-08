import { expect, test } from 'bun:test';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { locatePrompts } from '@myco-server-worker/ingest/document-locators.js';
import { readPage } from '@myco-server-worker/content/document-reader.js';
import { captureDocumentTranscript, withDocumentStores } from './helpers/document-stores.js';
import { memoryBlobStore } from './helpers/fixtures.js';
import { MIN, limits, reply, user } from './helpers/document-publication.js';

test('a page chunk that appears while a locator wake reads leaves its prompts reachable at their real pages, never page -1', async () => {
  await withDocumentStores(async (db, name) => {
    const t0 = Date.now() - 2 * 60 * MIN, blobs = memoryBlobStore();
    let text = '';
    for (let i = 0; i < 12; i += 1) text += user(`turn-${i}`, `step ${i}`) + reply('x'.repeat(240_000));
    const env = await captureDocumentTranscript(db, blobs, 'session', `tx_${'a'.repeat(32)}`, text, t0, 0, 'codex');
    await publishDocuments(env, t0 + 11 * MIN, limits());
    const expected: Record<string, number> = {};
    for (const at of (await db.prepare(`SELECT owner,page FROM session_pages WHERE session_id='session'`).all<{ owner: string; page: number }>()).results) {
      for (const record of (await readPage(env, 'project', 'session', at.owner, at.page))!) if (record.k === 'prompt') expected[record.id] = at.page;
    }
    // A document written before locators, whose last page chunk lands only once the wake has listed the others.
    await db.prepare(`UPDATE session_prompts SET page=NULL WHERE session_id='session'`).run();
    await db.prepare(`UPDATE session_documents SET locate_after=NULL WHERE session_id='session'`).run();
    const last = (await db.prepare(`SELECT * FROM session_chunks WHERE session_id='session' AND kind='page' ORDER BY chunk_no DESC LIMIT 1`).first<Record<string, string | number>>())!;
    await db.prepare(`DELETE FROM session_chunks WHERE session_id='session' AND chunk_no=?`).bind(last.chunk_no).run();
    const columns = Object.keys(last);
    const get = blobs.get.bind(blobs);
    let appended = false;
    blobs.get = async (...args: Parameters<typeof get>) => {
      if (!appended) {
        appended = true;
        await db.prepare(`INSERT INTO session_chunks (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).bind(...columns.map(c => last[c])).run();
      }
      return get(...args);
    };
    for (let wake = 0; wake < 5; wake += 1) if (!(await locatePrompts(env, limits())).more) break;
    const located = Object.fromEntries((await db.prepare(`SELECT prompt_id,page FROM session_prompts WHERE session_id='session'`)
      .all<{ prompt_id: string; page: number }>()).results.map(row => [row.prompt_id, row.page]));
    expect({ appended, located }, name).toEqual({ appended: true, located: expected });
  });
});
