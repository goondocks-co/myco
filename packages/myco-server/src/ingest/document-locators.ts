/**
 * Page locators for the prompts of documents written before `session_prompts.page` existed, and repair of any recorded
 * as held by no page. A wake reads at most `LOCATE_CHUNKS_PER_WAKE` page chunks, in chunk order from the document's
 * repair cursor, so each chunk is read once, and records the page of every prompt they hold under its own turn's owner.
 * A correct locator is kept. Once a document's last page chunk is read, a prompt no page holds is recorded as page -1.
 * Every locator lands only while the chunks read are still the document's, so a stale view never marks a prompt page -1.
 */
import type { ServerEnv } from '../core/adapters.js';
import { readPageChunk } from '../content/document-reader.js';
import { commitLocated, LOCATOR_RETRY_MS, locatorPageChunks, nextLocatorRepair, postponeLocatorRepair, rebindLocatorRepair } from '../db/documents/locators.js';
import { PASS_CLOSING_BLOB_CALLS, PASS_CLOSING_STATEMENTS, reserveReached } from './document-batch.js';
import type { PassLimits } from './parse.js';
import { catchUpSummaries } from './document-summaries.js';
import { deferDocumentReadFailure } from './document-read-failures.js';

/** Page chunks one wake reads to locate prompts. */
export const LOCATE_CHUNKS_PER_WAKE = 4;

/**
 * Repairs the due documents within one wake's share; `more` while any repair may remain due. A document whose chunks
 * changed under the wake records nothing from them and waits for its next attempt, leaving its share to the next document.
 */
export async function locatePrompts(env: Pick<ServerEnv, 'db' | 'blobs'>, limits: PassLimits): Promise<{ changed: number; more: boolean }> {
  const db = env.db;
  let read = 0, changed = 0;
  const now = limits.clock();
  while (read < LOCATE_CHUNKS_PER_WAKE) {
    if (limits.clock() >= limits.deadline || reserveReached(db, PASS_CLOSING_STATEMENTS, PASS_CLOSING_BLOB_CALLS)) return { changed, more: true };
    const repair = await nextLocatorRepair(db, now);
    if (repair === null) {
      const summaries = await catchUpSummaries(env, limits, LOCATE_CHUNKS_PER_WAKE - read);
      return { changed: changed + summaries.changed, more: summaries.more };
    }
    if (repair.live_generation === null) { await postponeLocatorRepair(db, repair, now + LOCATOR_RETRY_MS); read += 1; continue; }
    if (repair.rollup_due !== null && repair.rollup_due > now) { await postponeLocatorRepair(db, repair, repair.rollup_due); read += 1; continue; }
    if (repair.live_generation !== repair.generation) { await rebindLocatorRepair(db, repair); read += 1; continue; }
    try {
      const share = LOCATE_CHUNKS_PER_WAKE - read;
      const rows = await locatorPageChunks(db, repair, share + 1);
      const chunks = rows.slice(0, share);
      const placed: { id: string; owner: string; page: number }[] = [];
      for (const row of chunks) {
        read += 1;
        for (const page of (await readPageChunk(env, row)).pages) {
          for (const record of page.records) if (record.k === 'prompt') placed.push({ id: record.id, owner: page.owner, page: page.page });
        }
      }
      const finished = rows.length <= share;
      const located = await commitLocated(db, repair, { chunks, placed, finished });
      if (located === null) { await postponeLocatorRepair(db, repair, now + LOCATOR_RETRY_MS); continue; }
      changed += located;
      if (!finished) return { changed, more: true };
    } catch (error) { await deferDocumentReadFailure(db, repair, error, now); read += 1; }
  }
  return { changed, more: true };
}
