/**
 * A card settles once, in source order, however many other cards wait, and a pass that cannot move a card never
 * answers that work remains for it.
 */
import { describe, expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { settleCards, SETTLE_TURNS_PER_WAKE } from '@myco-server-worker/ingest/card-settle.js';
import { SETTLE_PROMOTE_PAGE } from '@myco-server-worker/db/documents/card-settlement.js';
import { TURN_QUIET_MS } from '@myco-server-worker/db/schema-v110.js';
import { rereadTranscripts } from '@myco-server-worker/db/documents/rebuild.js';
import { captureDocumentTranscript, withDocumentStores } from './helpers/document-stores.js';
import { memoryBlobStore } from './helpers/fixtures.js';
import { MIN, limits, reply, user } from './helpers/document-publication.js';
import { measuredStore } from './helpers/read-budget.js';

const NOW = 1_800_000_000_000;
const noBlobs = { get: async () => null, put: async () => {}, delete: async () => {}, head: async () => null } as never;
const pass = () => ({ calls: 500, deadline: NOW + 60_000, clock: () => NOW });
const tx = (session: string) => `tx_${[...session].map(c => c.charCodeAt(0).toString(16)).join('').padEnd(32, '0').slice(0, 32)}`;

/** A published session whose turns are pending again, as settlement finds them; a transcript of plain turns falls due for a model. */
async function pendingSession(db: RelationalStore, session: string, turns: number) {
  const t0 = Date.now() - 2 * 60 * MIN, blobs = memoryBlobStore();
  let text = '';
  for (let i = 0; i < turns; i += 1) text += user(`${session}-${i}`, `step ${i} of ${session}`) + reply(`reply ${i}`);
  const env = await captureDocumentTranscript(db, blobs, session, tx(session), text, t0, 0, 'codex');
  await publishDocuments(env, t0 + 11 * MIN, limits());
  await db.prepare("UPDATE turn_cards SET state='pending',due_at=NULL,settle_at=?,settle_promoted_at=NULL,changes=changes+1 WHERE session_id=?").bind(t0, session).run();
  return { env, at: t0 + 11 * MIN };
}

/** Cards with no live document: settlement can only move their deadline, which is what these scenarios watch. */
async function seedCards(db: RelationalStore, session: string, cards: readonly { key: string; settleAt: number; activity: number }[]) {
  for (let i = 0; i < cards.length; i += 200) await db.prepare(`INSERT INTO turn_cards(project_id,session_id,turn_key,created_at,source_activity_at,settle_at)
    SELECT 'project',?1,json_extract(value,'$.k'),1,json_extract(value,'$.a'),json_extract(value,'$.s') FROM json_each(?2)`)
    .bind(session, JSON.stringify(cards.slice(i, i + 200).map(c => ({ k: c.key, s: c.settleAt, a: c.activity })))).run();
}

const cardRows = async (db: RelationalStore, session: string) => (await db.prepare(
  `SELECT turn_key,state,due_at,settle_at FROM turn_cards WHERE session_id=? ORDER BY turn_key`).bind(session).all<Record<string, unknown>>()).results;

describe('card settlement', () => {
  it('settles a due card once and leaves one not due where it is, including on a replay, a duplicate pass or a concurrent pass', async () => {
    await withDocumentStores(async (db, target) => {
      const { env, at } = await pendingSession(db, 'due', 3);
      await db.prepare("UPDATE turn_cards SET settle_at=? WHERE session_id='due' AND turn_key=(SELECT MIN(turn_key) FROM turn_cards WHERE session_id='due')").bind(at + 3_600_000).run();
      const first = await settleCards(env, at, limits());
      const after = await cardRows(db, 'due');
      expect(first, target).toEqual({ settled: 2, more: false });
      expect(after.filter(row => row.settle_at === at + 3_600_000), target).toHaveLength(1);
      expect(after.filter(row => row.settle_at === null && row.due_at === at), target).toHaveLength(2);
      expect(await settleCards(env, at, limits()), target).toEqual({ settled: 0, more: false });
      expect(await cardRows(db, 'due'), target).toEqual(after);

      const { env: other, at: otherAt } = await pendingSession(db, 'race', 4);
      const passes = await Promise.all([settleCards(other, otherAt, limits()), settleCards(other, otherAt, limits())]);
      expect(passes.reduce((sum, report) => sum + report.settled, 0), target).toBe(4);
      expect(new Set((await cardRows(db, 'race')).map(row => row.due_at)), target).toEqual(new Set([otherAt]));
    });
  });

  it('leaves a card a session reset carried over settled exactly as it would have been', async () => {
    await withDocumentStores(async (db, target) => {
      const { env, at } = await pendingSession(db, 'reset', 2);
      const { env: twin, at: twinAt } = await pendingSession(db, 'twin', 2);
      await settleCards(twin, twinAt, limits());
      await rereadTranscripts(db, { projectId: 'project', sessionId: 'reset' });
      // A card the rebuilding generation does not hold yet waits a quiet window, then settles the same.
      for (let wake = 0; wake < 8 && (await cardRows(db, 'reset')).some(row => row.settle_at !== null); wake += 1) await publishDocuments(env, at + wake * (TURN_QUIET_MS + 1), limits());
      const shape = (rows: readonly Record<string, unknown>[]) => rows.map(row => ({ state: row.state, settled: row.settle_at === null, due: row.due_at !== null }));
      expect(shape(await cardRows(db, 'reset')), target).toEqual(shape(await cardRows(db, 'twin')));
    });
  });

  it('settles the newest source activity first and leaves the rest ready for the next pass', async () => {
    await withDocumentStores(async (db, target) => {
      await seedCards(db, 'gone', Array.from({ length: SETTLE_TURNS_PER_WAKE + 2 }, (_, n) => ({ key: `t${String(n).padStart(3, '0')}`, settleAt: NOW - 10, activity: n })));
      const report = await settleCards({ db, blobs: noBlobs }, NOW, pass());
      const moved = (await cardRows(db, 'gone')).filter(row => row.settle_at === NOW + TURN_QUIET_MS).map(row => row.turn_key);
      expect(report, target).toEqual({ settled: 0, more: true });
      expect(moved, target).toHaveLength(SETTLE_TURNS_PER_WAKE);
      expect(moved, target).not.toContain('t000');
      expect(moved, target).not.toContain('t001');
    });
  });

  it('drains a backlog larger than one promotion page, and a pass that moved everything answers no more work', async () => {
    await withDocumentStores(async (db, target) => {
      const backlog = SETTLE_PROMOTE_PAGE + 3;
      await seedCards(db, 'gone', Array.from({ length: backlog }, (_, n) => ({ key: `t${n}`, settleAt: NOW - 1 - n, activity: n })));
      const env = { db, blobs: noBlobs };
      let answered = true;
      for (let wake = 0; wake < 15 && answered; wake += 1) answered = (await settleCards(env, NOW, pass())).more;
      expect(answered, target).toBe(false);
      expect((await cardRows(db, 'gone')).every(row => row.settle_at === NOW + TURN_QUIET_MS), target).toBe(true);
    }, 180_000);
  }, 200_000);

  it('moves a card it cannot settle to a later deadline instead of reporting that work remains', async () => {
    await withDocumentStores(async (db, target) => {
      const { env, at } = await pendingSession(db, 'stuck', 1);
      // The catalog still holds the turn but its pages are gone, so the turn reads as absent and cannot be forgotten either.
      await db.prepare("DELETE FROM session_pages WHERE session_id='stuck' AND owner<>''").run();
      expect(await settleCards(env, at, limits()), target).toEqual({ settled: 0, more: false });
      expect((await cardRows(db, 'stuck'))[0], target).toMatchObject({ state: 'pending', settle_at: at + TURN_QUIET_MS });
      // Its next deadline keeps it out of the selection until it comes around.
      expect(await settleCards(env, at, limits()), target).toEqual({ settled: 0, more: false });
    });
  });

  it('reads the same rows for a pass however many cards wait behind a future deadline', async () => {
    await withDocumentStores(async (db, target) => {
      if (target !== 'D1') return;
      const reads = async (session: string, waiting: number) => {
        await seedCards(db, session, [{ key: 'due', settleAt: NOW - 1, activity: 5 }]);
        await seedCards(db, `${session}-w`, Array.from({ length: waiting }, (_, n) => ({ key: `w${n}`, settleAt: NOW + 3_600_000, activity: n })));
        const measured = measuredStore(db as never);
        await settleCards({ db: measured.db, blobs: noBlobs }, NOW, pass());
        return measured.reads();
      };
      expect(await reads('small', 100), target).toBe(await reads('large', 1_500));
    });
  }, 60_000);

  it('moves an unreadable card whose failure cannot be recorded, so the cards behind it are reached', async () => {
    await withDocumentStores(async (db, target) => {
      const dead = await pendingSession(db, 'dead', SETTLE_TURNS_PER_WAKE + 5);
      const live = await pendingSession(db, 'live', 1);
      await db.prepare("INSERT INTO session_tombstones(project_id,session_id,reason,created_at,created_by) VALUES('project','dead','t',1,'t')").run();
      await db.prepare("UPDATE turn_cards SET source_activity_at=CASE session_id WHEN 'dead' THEN 2 ELSE 1 END").run();
      const failing = { ...dead.env, blobs: { ...dead.env.blobs, get: async () => { throw new Error('document_chunk_missing'); } } };
      const now = Math.max(dead.at, live.at);
      for (let wake = 0; wake < 2; wake += 1) await settleCards(failing, now, limits());
      const unmoved = await db.prepare('SELECT session_id, COUNT(*) AS n FROM turn_cards WHERE settle_at<=? GROUP BY session_id').bind(now).all();
      expect(unmoved.results, target).toEqual([]);
    });
  }, 60_000);
});
