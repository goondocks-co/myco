/**
 * How an imported transcript differs from a live one once it is in the store.
 *
 * It differs in exactly three ways, and each is a property something else
 * depends on:
 *
 *   - it is parsed BEHIND live work. A backfill of a machine's whole archive
 *     sitting ahead of the session someone is having right now would delay that
 *     session for as many ticks as the archive is long.
 *   - it does not hold the Deployment awake. Unread live bytes do; an import
 *     backlog finishes as the Deployment is used.
 *   - it schedules no title. A join over three harnesses queues one model run
 *     per imported session under the live rule, for history nobody asked to
 *     have summarised.
 *
 * The lane is the lane of the NEWEST segment rather than the first, so a
 * session imported and then continued live is live work again. Asserting only
 * that an import sets the lane would pin the opposite.
 */
import { describe, expect, it } from 'bun:test';
import { parseTranscripts, pendingImportedTranscripts, pendingTranscriptBytes, TRANSCRIPT_PARSE_CALLS_PER_PASS } from '@myco-server-worker/ingest/parse.js';
import { engineAssertions } from '@myco-server-worker/core/tick.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { listSessions } from '@myco-server-worker/read/sessions.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import worker from '@myco-server-worker/index.js';
import { memberPost, sqliteEnv, uuid } from './helpers/fixtures.js';

const NOW = Date.parse('2027-01-01T00:00:00Z');
const PROJECT = 'proj_1';
const MACHINE = 'machine_1';
const line = (o: Record<string, unknown>): string => `${JSON.stringify(o)}\n`;
/**
 * A distinct transcript id in the grammar the envelope admits: `tx_` and 32 hex.
 *
 * Derived from a hash of the name rather than by padding it, so two names that
 * share a prefix cannot pad to one id — `live1` and `live10` do, and a
 * collision here reads as an offset refusal several assertions later.
 */
const tx = (name: string): string => {
  let h = 0x811c9dc5;
  for (const ch of name) { h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0; }
  return `tx_${h.toString(16).padStart(8, '0').repeat(4)}`;
};
let seq = 0;
const nextId = () => uuid(1000 + (seq += 1));

/** A transcript body of one turn, at a stated instant. */
const body = (n: number) =>
  line({ type: 'user', promptId: uuid(n), message: { content: `prompt ${n}` }, timestamp: '2026-09-01T10:00:00Z' })
  + line({ type: 'assistant', message: { content: [{ type: 'text', text: `reply ${n}` }] }, timestamp: '2026-09-01T10:00:01Z' });

async function rig() {
  const { sqlite, serverEnv } = sqliteEnv();
  const issued = await issueMemberToken(serverEnv.db, { memberId: 'mem_machine_1', machineId: MACHINE }, NOW);

  /** Ship one segment of a transcript through the real ingest path, on the named channel. */
  const ship = async (sessionId: string, transcriptId: string, text: string, channel: 'cli' | 'import', at: number, baseOffset = 0) => {
    const bytes = new TextEncoder().encode(text);
    const key = await sha256HexOf(bytes);
    await serverEnv.blobs.put(`${PROJECT}/${key}`, new Blob([bytes]).stream());
    sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (project_id, key) DO NOTHING`, PROJECT, key, bytes.length, 'text/plain', issued.tokenId, NOW);
    return ingestEvent(serverEnv.db, { projectId: PROJECT, machineId: MACHINE, tokenId: issued.tokenId, bodyBytes: 200, now: at }, {
      eventId: nextId(),
      sessionId, kind: 'transcript.segment', createdAt: at, channel,
      producer: { adapter: 'claude-code', version: '1' },
      payload: { transcriptId, baseOffset, length: bytes.length, blob: key, agent: 'claude-code' },
    });
  };

  const shipSegment = async (rig: { serverEnv: typeof serverEnv; sqlite: typeof sqlite }, sessionId: string, transcriptId: string, text: string, channel: 'cli' | 'import', at: number, baseOffset: number, headHash: string) => {
    const bytes = new TextEncoder().encode(text);
    const key = await sha256HexOf(bytes);
    await rig.serverEnv.blobs.put(`${PROJECT}/${key}`, new Blob([bytes]).stream());
    rig.sqlite.run(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at) VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT (project_id, key) DO NOTHING`, PROJECT, key, bytes.length, 'text/plain', issued.tokenId, NOW);
    return ingestEvent(rig.serverEnv.db, { projectId: PROJECT, machineId: MACHINE, tokenId: issued.tokenId, bodyBytes: 200, now: at }, {
      eventId: nextId(), sessionId, kind: 'transcript.segment', createdAt: at, channel,
      producer: { adapter: 'claude-code', version: '1' },
      payload: { transcriptId, baseOffset, length: bytes.length, blob: key, agent: 'claude-code', headHash },
    });
  };

  const lane = (transcriptId: string) =>
    (sqlite.query(`SELECT imported_at FROM transcripts WHERE transcript_id = ?`).get(transcriptId) as { imported_at: number | null }).imported_at;

  return { sqlite, serverEnv, ship, shipSegment, lane, tokenId: issued.tokenId };
}

describe('an imported transcript in the store', () => {
  it('is parsed behind live work, whatever their receipts, and a live backlog spends the whole budget first', async () => {
    const r = await rig();
    // Received FIRST and oldest, so a receipt-ordered queue takes it first.
    expect((await r.ship('s-import', tx('tx_import'), body(1), 'import', NOW - 100_000)).persisted).toBe(true);
    // More live transcripts than one tick's call budget can read. The lane is
    // what keeps the backfill from taking a share of that budget while a live
    // backlog is waiting.
    for (let i = 0; i < TRANSCRIPT_PARSE_CALLS_PER_PASS; i += 1) {
      expect((await r.ship(`s-live-${i}`, tx(`live${i}`), body(i + 2), 'cli', NOW)).persisted).toBe(true);
    }

    await parseTranscripts(r.serverEnv, NOW);
    const parsed = (id: string) => (r.sqlite.query(`SELECT parsed_offset FROM transcripts WHERE transcript_id = ?`).get(id) as { parsed_offset: number }).parsed_offset;
    const liveParsed = (r.sqlite.query(`SELECT COUNT(*) AS n FROM transcripts WHERE imported_at IS NULL AND parsed_offset > 0`).get() as { n: number }).n;
    expect({ importParsed: parsed(tx('tx_import')), liveParsed: liveParsed > 0 }).toEqual({ importParsed: 0, liveParsed: true });

    // Once the live backlog is drained the backfill is read; it is deferred,
    // never abandoned.
    for (let tick = 0; tick < 20; tick += 1) await parseTranscripts(r.serverEnv, NOW);
    expect(parsed(tx('tx_import'))).toBeGreaterThan(0);
  });

  it('counts as pending work but holds the Deployment no deeper than idle', async () => {
    const r = await rig();
    await r.ship('s-import', tx('tx_import'), body(1), 'import', NOW);
    expect(await pendingTranscriptBytes(r.serverEnv.db)).toBe(1);
    expect(await pendingImportedTranscripts(r.serverEnv.db)).toBe(1);

    const imported = await engineAssertions(r.serverEnv, NOW);
    expect(imported.find((a) => a.name === 'import:pending')).toEqual({ name: 'import:pending', maxDepth: 'idle' });
    expect(imported.find((a) => a.name === 'transcript:pending')).toBeUndefined();

    // A live transcript beside it does hold the Deployment awake.
    await r.ship('s-live', tx('tx_live'), body(2), 'cli', NOW);
    const both = await engineAssertions(r.serverEnv, NOW);
    expect(both.find((a) => a.name === 'transcript:pending')).toEqual({ name: 'transcript:pending', maxDepth: 'active' });
  });

  it('carries the lane of its newest segment, so a live segment returns it to live work', async () => {
    const r = await rig();
    const first = body(1);
    await r.ship('s1', tx('tx_1'), first, 'import', NOW);
    expect(r.lane(tx('tx_1'))).toBe(NOW);

    // The session continues live. A COALESCE would leave it in the backfill
    // lane for the rest of its life.
    await r.ship('s1', tx('tx_1'), body(2), 'cli', NOW + 5, new TextEncoder().encode(first).length);
    expect(r.lane(tx('tx_1'))).toBeNull();
  });

  it('closes an imported session and dates it when it happened, so it does not read as live', async () => {
    const r = await rig();
    const ended = NOW - 30 * 86_400_000;
    const send = (kind: string, payload: Record<string, unknown>, channel: 'cli' | 'import') =>
      ingestEvent(r.serverEnv.db, { projectId: PROJECT, machineId: MACHINE, tokenId: r.tokenId, bodyBytes: 100, now: NOW }, {
        eventId: nextId(), sessionId: 's-old', kind, createdAt: ended, channel,
        producer: { adapter: 'claude-code', version: '1' }, payload,
      });
    expect((await send('session.start', { agent: 'claude-code', startedAt: ended }, 'import')).persisted).toBe(true);
    expect((await send('session.end', { endedAt: ended }, 'import')).persisted).toBe(true);

    const open = await listSessions(r.serverEnv.db, { projectId: PROJECT }, { state: 'open', fidelity: 'any' });
    expect(open.rows.map((s) => s.sessionId)).toEqual([]);
    const all = await listSessions(r.serverEnv.db, { projectId: PROJECT }, { fidelity: 'any' });
    expect(all.rows.map((s) => ({ id: s.sessionId, startedAt: s.startedAt, ended: s.endedAt !== null }))).toEqual([{ id: 's-old', startedAt: ended, ended: true }]);
  });

  it('schedules a title for a live session end and none for an imported one', async () => {
    // Driven through the deployed entry, whose clock is the real one, so the
    // instants here are the wall clock rather than this file's fixed NOW.
    const at = Date.now();
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: MACHINE }, at);
    const end = async (sessionId: string, channel: 'cli' | 'import') => {
      const body = JSON.stringify({
        eventId: nextId(), sessionId, kind: 'session.end', createdAt: at, channel,
        producer: { adapter: 'claude-code', version: '2.0.0-test' }, payload: { endedAt: at },
      });
      return (await worker.fetch(memberPost(t.token, body), e.env, e.deferred)).json() as Promise<Record<string, unknown>>;
    };

    const start = async (sessionId: string, channel: 'cli' | 'import') => {
      const body = JSON.stringify({
        eventId: nextId(), sessionId, kind: 'session.start', createdAt: at - 1000, channel,
        producer: { adapter: 'claude-code', version: '2.0.0-test' }, payload: { agent: 'claude-code', startedAt: at - 1000 },
      });
      return (await worker.fetch(memberPost(t.token, body), e.env, e.deferred)).json() as Promise<Record<string, unknown>>;
    };
    expect((await start('s-live', 'cli')).persisted).toBe(true);
    expect((await start('s-imported', 'import')).persisted).toBe(true);
    expect(e.deferred.pending).toHaveLength(0);

    // Both arms in one test: a change that stopped scheduling titles entirely
    // would pass an assertion that only checked the import arm.
    expect((await end('s-live', 'cli')).projected).toBe(true);
    expect(e.deferred.pending).toHaveLength(1);

    expect((await end('s-imported', 'import')).projected).toBe(true);
    expect(e.deferred.pending).toHaveLength(1);
    await e.deferred.settle();
  });

  it('lets ordinary capture through while import is switched off', async () => {
    const r = await rig();
    await settingsWriter(r.serverEnv.db).setLeaf('import.enabled', false, 'mem_machine_1', NOW);

    // The switch governs the import channel alone. Composing its check for
    // every channel would fail only an arity count, so the direction that must
    // not break is asserted here rather than inferred.
    const live = await r.ship('s-live', tx('open'), body(1), 'cli', NOW);
    expect(live.persisted).toBe(true);

    const imported = await r.ship('s-import', tx('shut'), body(2), 'import', NOW);
    expect({ persisted: imported.persisted, code: imported.persisted ? null : imported.code }).toEqual({ persisted: false, code: 'import_disabled' });
  });

  it('stamps the head digest an import ships, and refuses a later segment that disagrees', async () => {
    const r = await rig();
    const head = 'a'.repeat(64);
    const shipWithHead = (transcriptId: string, text: string, at: number, baseOffset: number, headHash: string) =>
      r.shipSegment(r, 's1', transcriptId, text, 'import', at, baseOffset, headHash);

    const first = body(1);
    expect((await shipWithHead(tx('hh'), first, NOW, 0, head)).persisted).toBe(true);
    expect((r.sqlite.query(`SELECT head_hash FROM transcripts WHERE transcript_id = ?`).get(tx('hh')) as { head_hash: string | null }).head_hash).toBe(head);

    // A file truncated and rewritten in place keeps its path and its inode, so
    // it keeps its identity, and only the head digest says it is a different
    // file. With the digest on the wire the Deployment refuses it; with none,
    // its bytes join the record of the file it replaced and nothing shows it.
    const refused = await shipWithHead(tx('hh'), body(2), NOW + 1, new TextEncoder().encode(first).length, 'b'.repeat(64));
    expect({ persisted: refused.persisted, code: refused.code }).toEqual({ persisted: false, code: 'transcript_replaced' });
  });

  it('excludes an imported reduced-fidelity session from extraction, and shows it to a reader', async () => {
    const r = await rig();
    // The fidelity flag is written by the parse from the parser's own
    // declaration, so an imported Cursor session inherits the rule rather than
    // needing the import to apply it. Asserted rather than assumed.
    await r.ship('s-cursor', tx('cursor'), body(1), 'import', NOW);
    r.sqlite.run(`UPDATE transcripts SET agent = 'cursor', fidelity = 'no_tool_results' WHERE transcript_id = ?`, tx('cursor'));

    const extraction = await listSessions(r.serverEnv.db, { projectId: PROJECT }, {});
    expect(extraction.rows.map((x) => x.sessionId)).toEqual([]);
    const reader = await listSessions(r.serverEnv.db, { projectId: PROJECT }, { fidelity: 'any' });
    expect(reader.rows.map((x) => x.sessionId)).toEqual(['s-cursor']);
  });

  it('sorts by when a session happened rather than when it was received', async () => {
    const r = await rig();
    const send = (sessionId: string, startedAt: number) =>
      ingestEvent(r.serverEnv.db, { projectId: PROJECT, machineId: MACHINE, tokenId: r.tokenId, bodyBytes: 100, now: NOW }, {
        eventId: nextId(), sessionId, kind: 'session.start', createdAt: startedAt, channel: 'cli',
        producer: { adapter: 'claude-code', version: '1' }, payload: { agent: 'claude-code', startedAt },
      });
    // Received in the order old-then-new; a receipt-ordered list would answer
    // the imported month-old session first.
    await send('s-old', NOW - 30 * 86_400_000);
    await send('s-new', NOW - 60_000);
    const page = await listSessions(r.serverEnv.db, { projectId: PROJECT }, { fidelity: 'any' });
    expect(page.rows.map((s) => s.sessionId)).toEqual(['s-new', 's-old']);
  });

  it('pages every session exactly once when the boundary lands on a started session', async () => {
    const r = await rig();
    // The discriminating shape. Received in one order and started in another,
    // and the page boundary falls on a session whose `started_at` differs from
    // its `first_received_at` — the only rows where the sort expression and a
    // cursor minted from the receipt disagree. A boundary on a session with no
    // start time proves nothing: there the two expressions are equal.
    const rows = [
      { id: 'a', started: NOW - 1000, recv: NOW + 900 },
      { id: 'b', started: NOW - 2000, recv: NOW + 800 },
      { id: 'c', started: NOW - 3000, recv: NOW + 700 },
      { id: 'd', started: null, recv: NOW - 4000 },
    ];
    for (const row of rows) {
      r.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, started_at, ended_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`, PROJECT, row.id, MACHINE, r.tokenId, row.recv, row.recv, row.started);
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 8; page += 1) {
      const got = await listSessions(r.serverEnv.db, { projectId: PROJECT }, { limit: 2, cursor, fidelity: 'any' });
      seen.push(...got.rows.map((x) => x.sessionId));
      if (got.cursor === null) break;
      cursor = got.cursor;
    }
    // Exactly once each: a cursor built from the wrong expression re-serves
    // page one rather than failing an ordering assertion.
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(seen.length).toBe(4);
  });
});
