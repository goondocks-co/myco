/**
 * Page locators for the prompts of documents written before `session_prompts.page` existed. A wake reads at most
 * `LOCATE_CHUNKS_PER_WAKE` page chunks, in chunk order from the one after the document's `locate_after`, so each chunk
 * is read once, and records the page of every prompt they hold. A locator the publisher or conversion has already
 * written is kept. Once a document's last page chunk is read, a prompt no page holds is recorded as page -1. Each
 * locator is written through its prompt's primary key, so a wake's catalog reads follow the prompts it located. Every
 * locator lands only while the chunks read are still the document's, so a stale view never marks a prompt page -1.
 */
import type { ServerEnv } from '../core/adapters.js';
import { readPageChunk } from '../content/document-reader.js';
import { commitLocated, locatorPageChunks, nextUnlocatedDocument } from '../db/documents/locators.js';
import { PASS_CLOSING_BLOB_CALLS, PASS_CLOSING_STATEMENTS, reserveReached } from './document-batch.js';
import type { PassLimits } from './parse.js';
import { catchUpSummaries } from './document-summaries.js';
import { deferDocumentReadFailure } from './document-read-failures.js';

/** Page chunks one wake reads to locate prompts. */
export const LOCATE_CHUNKS_PER_WAKE = 4;

/**
 * Locates prompts of live documents within one wake's share; `more` while any may remain unlocated. A wake whose chunks
 * changed under it records nothing from them and leaves the document to the next wake.
 */
export async function locatePrompts(env: Pick<ServerEnv, 'db' | 'blobs'>, limits: PassLimits): Promise<{ changed: number; more: boolean }> {
  const db = env.db;
  let read = 0, changed = 0;
  const now = limits.clock();
  while (read < LOCATE_CHUNKS_PER_WAKE) {
    if (limits.clock() >= limits.deadline || reserveReached(db, PASS_CLOSING_STATEMENTS, PASS_CLOSING_BLOB_CALLS)) return { changed, more: true };
    const doc = await nextUnlocatedDocument(db, now);
    if (doc === null) {
      const summaries = await catchUpSummaries(env, limits, LOCATE_CHUNKS_PER_WAKE - read);
      return { changed: changed + summaries.changed, more: summaries.more };
    }
    try {
      const share = LOCATE_CHUNKS_PER_WAKE - read;
      const rows = await locatorPageChunks(db, doc, share + 1);
      const chunks = rows.slice(0, share);
      const placed: { id: string; page: number }[] = [];
      for (const row of chunks) {
        read += 1;
        for (const page of (await readPageChunk(env, row)).pages) {
          for (const record of page.records) if (record.k === 'prompt') placed.push({ id: record.id, page: page.page });
        }
      }
      const finished = rows.length <= share;
      if (!(await commitLocated(db, doc, chunks, placed, finished))) return { changed, more: true };
      changed += placed.length;
      if (!finished) return { changed, more: true };
    } catch (error) { await deferDocumentReadFailure(db, doc, error, now); read += 1; }
  }
  return { changed, more: true };
}
