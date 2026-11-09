/**
 * A repair never leaves a locator pointing at the wrong turn, keeps a correct one, survives a rebuilt session, and a
 * read says `building` rather than absent while a session's locators are being repaired.
 */
import { describe, expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { locatePrompts } from '@myco-server-worker/ingest/document-locators.js';
import { readPage } from '@myco-server-worker/content/document-reader.js';
import { documentTurnDetail } from '@myco-server-worker/content/session-turns.js';
import { LOCATOR_RETRY_MS, nextLocatorRepair, TurnLocatorBuilding } from '@myco-server-worker/db/documents/locators.js';
import { promptLocator, extractionSourceSession } from '@myco-server-worker/db/documents/prompt-locator.js';
import { projectionReadiness } from '@myco-server-worker/db/projections/catchup.js';
import { captureDocumentTranscript, withDocumentStores } from './helpers/document-stores.js';
import { memoryBlobStore } from './helpers/fixtures.js';
import { MIN, limits, queueLocatorRepair, reply, user } from './helpers/document-publication.js';
import { measuredStore } from './helpers/read-budget.js';

const scope = { projectId: 'project' } as never;
const tx = (session: string) => `tx_${[...session].map(c => c.charCodeAt(0).toString(16)).join('').padEnd(32, '0').slice(0, 32)}`;

/** A published session of `turns` turns, each with a large reply, and the page holding each prompt. */
async function published(db: RelationalStore, session: string, turns: number) {
  const t0 = Date.now() - 2 * 60 * MIN, blobs = memoryBlobStore();
  let text = '';
  for (let i = 0; i < turns; i += 1) text += user(`${session}-${i}`, `step ${i}`) + reply('x'.repeat(240_000));
  const env = await captureDocumentTranscript(db, blobs, session, tx(session), text, t0, 0, 'codex');
  await publishDocuments(env, t0 + 11 * MIN, limits());
  const expected: Record<string, number> = {};
  for (const at of (await db.prepare('SELECT owner,page FROM session_pages WHERE session_id=?').bind(session).all<{ owner: string; page: number }>()).results) {
    for (const record of (await readPage(env, 'project', session, at.owner, at.page))!) if (record.k === 'prompt') expected[record.id] = at.page;
  }
  return { env, blobs, expected };
}

const pages = async (db: RelationalStore, session: string) => Object.fromEntries((await db.prepare(
  'SELECT prompt_id,page FROM session_prompts WHERE session_id=?').bind(session).all<{ prompt_id: string; page: number }>()).results.map(row => [row.prompt_id, row.page]));

/** Wakes until the repair settles, the clock passing each retry delay. */
async function repaired(env: Parameters<typeof locatePrompts>[0]) {
  for (let wake = 0, now = Date.now() + LOCATOR_RETRY_MS + 1; wake < 20; wake += 1, now += LOCATOR_RETRY_MS + 1) {
    await locatePrompts(env, { calls: 500, deadline: now + 60_000, clock: () => now });
    if (await nextLocatorRepair(env.db, now + 86_400_000) === null) return;
  }
  throw new Error('repair did not settle');
}

describe('prompt locator repair', () => {
  it('records nothing from a stale view when the tail is rewritten under a repair, then locates every prompt on the next attempt', async () => {
    await withDocumentStores(async (db, target) => {
      const { env, blobs, expected } = await published(db, 'tail', 8);
      await db.prepare("UPDATE session_prompts SET page=NULL WHERE session_id='tail'").run();
      await queueLocatorRepair(db);
      const get = blobs.get.bind(blobs);
      let rewritten = false;
      blobs.get = async (...args: Parameters<typeof get>) => {
        if (!rewritten) {
          rewritten = true;
          await db.prepare("UPDATE session_chunks SET source_id=source_id||'-rewritten' WHERE session_id='tail' AND chunk_no=(SELECT MAX(chunk_no) FROM session_chunks WHERE session_id='tail' AND kind='page')").run();
        }
        return get(...args);
      };
      await locatePrompts(env, limits());
      expect(Object.values(await pages(db, 'tail')).every(page => page === null), target).toBe(true);
      await repaired(env);
      expect(await pages(db, 'tail'), target).toEqual(expected);
      expect(await nextLocatorRepair(db, Date.now() + 86_400_000), target).toBeNull();
    });
  });

  it('settles one repair when two passes race for it', async () => {
    await withDocumentStores(async (db, target) => {
      const { env, expected } = await published(db, 'pair', 6);
      await db.prepare("UPDATE session_prompts SET page=NULL WHERE session_id='pair'").run();
      await queueLocatorRepair(db);
      await Promise.all([locatePrompts(env, limits()), locatePrompts(env, limits())]);
      await repaired(env);
      expect(await pages(db, 'pair'), target).toEqual(expected);
    });
  });

  it('keeps a correct locator, corrects a false -1 from a page, and leaves -1 where no page holds the prompt', async () => {
    await withDocumentStores(async (db, target) => {
      const { env, expected } = await published(db, 'cases', 5);
      const ids = Object.keys(expected);
      await db.prepare("INSERT INTO session_prompts(project_id,session_id,generation,prompt_id,turn_key,ord,origin,created_at,page) SELECT project_id,session_id,generation,'phantom','phantom',999,'user',1,NULL FROM session_documents WHERE session_id='cases'").run();
      await db.prepare('UPDATE session_prompts SET page=-1 WHERE prompt_id=?').bind(ids[0]).run();
      await db.prepare('UPDATE session_prompts SET page=NULL WHERE prompt_id=?').bind(ids[1]).run();
      await queueLocatorRepair(db);
      await repaired(env);
      expect(await pages(db, 'cases'), target).toEqual({ ...expected, phantom: -1 });
    });
  });

  it('restarts the walk on a rebuilt session, so a cursor from the old generation never skips its pages', async () => {
    await withDocumentStores(async (db, target) => {
      const { env, expected } = await published(db, 'rebuilt', 6);
      await db.prepare("UPDATE session_prompts SET page=NULL WHERE session_id='rebuilt'").run();
      await queueLocatorRepair(db);
      await db.prepare("UPDATE document_locator_repair SET locate_after=99999 WHERE session_id='rebuilt'").run();
      for (const table of ['session_chunks', 'session_pages', 'session_prompts']) {
        const columns = (await db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map(row => row.name);
        await db.prepare(`INSERT INTO ${table}(${columns.join(',')}) SELECT ${columns.map(c => c === 'generation' ? 'generation+1' : c).join(',')} FROM ${table} WHERE session_id='rebuilt'`).run();
      }
      await db.prepare("UPDATE session_documents SET generation=generation+1 WHERE session_id='rebuilt'").run();
      await repaired(env);
      expect(await pages(db, 'rebuilt').then(p => Object.fromEntries(Object.entries(p).filter(([id]) => id in expected))), target).toEqual(expected);
    });
  });

  it('never places a prompt whose turn does not own the page, and reads it as absent rather than from another turn', async () => {
    await withDocumentStores(async (db, target) => {
      const { env, expected } = await published(db, 'owner', 3);
      const id = Object.keys(expected)[1]!;
      await db.prepare("UPDATE session_prompts SET page=NULL WHERE session_id='owner'").run();
      await db.prepare("UPDATE session_prompts SET turn_key='no-such-turn' WHERE prompt_id=?").bind(id).run();
      await queueLocatorRepair(db);
      await repaired(env);
      expect((await pages(db, 'owner'))[id], target).toBe(-1);
      expect(await documentTurnDetail(env, scope, 'owner', id), target).toBeNull();
    });
  });

  it('refuses a read as still building, not absent, while the session is being repaired, and the body once located', async () => {
    await withDocumentStores(async (db, target) => {
      const { env, expected } = await published(db, 'building', 3);
      const id = Object.keys(expected)[1]!;
      await db.prepare("UPDATE session_prompts SET page=NULL WHERE session_id='building'").run();
      await db.prepare("UPDATE session_prompts SET turn_key='missing-turn' WHERE prompt_id=?").bind(id).run();
      await db.prepare("UPDATE projection_catchup SET done=0 WHERE projection='document_locators'").run();
      await expect(documentTurnDetail(env, scope, 'building', id)).rejects.toBeInstanceOf(TurnLocatorBuilding);
      expect(await projectionReadiness(db, 'document_locators'), target).toBe('building');
      await queueLocatorRepair(db);
      await repaired(env);
      expect(await projectionReadiness(db, 'document_locators'), target).toBe('ready');
      expect(await documentTurnDetail(env, scope, 'building', id), target).toBeNull();
    });
  });

  it('stops answering building for a document whose pages cannot be read', async () => {
    await withDocumentStores(async (db, target) => {
      const { env, blobs } = await published(db, 'unreadable', 3);
      await db.prepare("INSERT INTO session_prompts(project_id,session_id,generation,prompt_id,turn_key,ord,origin,created_at,page) SELECT project_id,session_id,generation,'unplaced','unplaced',999,'user',1,NULL FROM session_documents WHERE session_id='unreadable'").run();
      await queueLocatorRepair(db);
      const get = blobs.get.bind(blobs);
      await expect(documentTurnDetail(env, scope, 'unreadable', 'unplaced'), target).rejects.toBeInstanceOf(TurnLocatorBuilding);
      blobs.get = async () => { throw new Error('document_chunk_missing'); };
      await locatePrompts(env, limits());
      blobs.get = get;
      expect(await nextLocatorRepair(db, Date.now() + 86_400_000 * 365), target).not.toBeNull();
      expect(await documentTurnDetail(env, scope, 'unreadable', 'unplaced'), target).toBeNull();
    });
  }, 60_000);

  it('returns the whole identity of a prompt, and fails closed on an unresolved extraction source', async () => {
    await withDocumentStores(async (db, target) => {
      await published(db, 'first', 1);
      const generation = (await db.prepare("SELECT generation FROM session_documents WHERE session_id='first'").first<{ generation: number }>())!.generation;
      const id = (await db.prepare("SELECT prompt_id FROM session_prompts WHERE session_id='first' LIMIT 1").first<{ prompt_id: string }>())!.prompt_id;
      expect(await promptLocator(db, 'project', 'first', id), target).toMatchObject({ projectId: 'project', sessionId: 'first', generation, promptId: id, turn: id, owner: id, page: 0 });
      expect(await promptLocator(db, 'project', 'first', 'no-such'), target).toBeNull();
      expect(await extractionSourceSession(db, 'project', id), target).toBe('first');
      await published(db, 'second', 1);
      await db.prepare("UPDATE session_prompts SET prompt_id=? WHERE session_id='second'").bind(id).run();
      expect(await extractionSourceSession(db, 'project', id), target).toBeNull();
    });
  });

  it('reads the same rows to find the next repair however many unlocated prompts wait behind one not yet due', async () => {
    await withDocumentStores(async (db, target) => {
      if (target !== 'D1') return;
      const reads = async (session: string, prompts: number) => {
        await db.prepare(`INSERT INTO session_documents(project_id,session_id,state,generation,last_record_at,updated_at,rollup_due) VALUES('project',?,'live',1,1,1,?)`).bind(session, Date.now() + 3_600_000).run();
        const rows = Array.from({ length: prompts }, (_, n) => ({ k: `${session}-${n}`, o: n }));
        for (let i = 0; i < rows.length; i += 200) await db.prepare(`INSERT INTO session_prompts(project_id,session_id,generation,prompt_id,turn_key,ord,origin,created_at)
          SELECT 'project',?1,1,json_extract(value,'$.k'),json_extract(value,'$.k'),json_extract(value,'$.o'),'user',1 FROM json_each(?2)`).bind(session, JSON.stringify(rows.slice(i, i + 200))).run();
        await queueLocatorRepair(db);
        const measured = measuredStore(db as never);
        await locatePrompts({ db: measured.db, blobs: memoryBlobStore() }, limits());
        return measured.reads();
      };
      const small = await reads('small', 100);
      await db.prepare("DELETE FROM document_locator_repair").run();
      await db.prepare("UPDATE session_prompts SET page=0 WHERE session_id='small'").run();
      expect(await reads('large', 1_500), target).toBe(small);
    });
  }, 60_000);
});
