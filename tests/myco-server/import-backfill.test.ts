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
import { registerBlob } from './helpers/d1.js';
import { refused } from './helpers/outcomes.js';
import { describe, expect, it } from 'bun:test';
import { laneSelectionSql, PARSER_VERSION, parseTranscripts, pendingTranscripts, TRANSCRIPT_PARSE_CONCURRENT_BYTES, TRANSCRIPT_PARSE_IMPORTED_AT_ONCE, withinBytes } from '@myco-server-worker/ingest/parse.js';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { CHAINED_WAKE_MS, engineAssertions, runTick, WAKE_INTERVALS } from '@myco-server-worker/core/tick.js';
import { nextWakeDelayMs } from '@myco-server-worker/core/power.js';
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
    const objectKey = registerBlob(sqlite, { projectId: PROJECT, key, size: bytes.length, tokenId: issued.tokenId, receivedAt: NOW });
    await serverEnv.blobs.put(objectKey, new Blob([bytes]).stream());
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
    const objectKey = registerBlob(rig.sqlite, { projectId: PROJECT, key, size: bytes.length, tokenId: issued.tokenId, receivedAt: NOW });
    await rig.serverEnv.blobs.put(objectKey, new Blob([bytes]).stream());
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
  it('is read beside live work: while it waits, live reading takes at most half the budget, and it moves in the same pass', async () => {
    const r = await rig();
    // Received FIRST and oldest, so a receipt-ordered queue takes it first.
    expect((await r.ship('s-import', tx('tx_import'), body(1), 'import', NOW - 100_000)).persisted).toBe(true);
    // More live transcripts than one pass's calls can read.
    for (let i = 0; i < 12; i += 1) {
      expect((await r.ship(`s-live-${i}`, tx(`live${i}`), body(i + 2), 'cli', NOW)).persisted).toBe(true);
    }

    await parseTranscripts(r.serverEnv, NOW, { budget: { calls: 12, wallMs: 60_000 } });
    const parsed = (id: string) => (r.sqlite.query(`SELECT parsed_offset FROM transcripts WHERE transcript_id = ?`).get(id) as { parsed_offset: number }).parsed_offset;
    const liveParsed = (r.sqlite.query(`SELECT COUNT(*) AS n FROM transcripts WHERE imported_at IS NULL AND parsed_offset > 0`).get() as { n: number }).n;
    expect({ importParsed: parsed(tx('tx_import')) > 0, liveParsed: liveParsed > 0 }).toEqual({ importParsed: true, liveParsed: true });
  });

  it('moves every pass while three live transcripts keep growing: live reading never starves an import', async () => {
    const r = await rig();
    // A long import: far more turns than a few passes can read.
    let history = '';
    for (let i = 0; i < 4_000; i += 1) history += body(20_000 + i);
    expect((await r.ship('s-history', tx('history'), history, 'import', NOW - 100_000)).persisted).toBe(true);
    const parsed = (id: string) => (r.sqlite.query(`SELECT parsed_offset FROM transcripts WHERE transcript_id = ?`).get(id) as { parsed_offset: number }).parsed_offset;
    const grown = [0, 0, 0];
    let imported = 0;
    for (let pass = 0; pass < 5; pass += 1) {
      // Each live session grows by more than one pass's whole budget can read.
      for (let k = 0; k < 3; k += 1) {
        let text = '';
        for (let turn = 0; turn < 40; turn += 1) text += body(10_000 + pass * 1_000 + k * 100 + turn);
        expect((await r.ship(`s-grow-${k}`, tx(`grow${k}`), text, 'cli', NOW + pass, grown[k])).persisted).toBe(true);
        grown[k] += new TextEncoder().encode(text).length;
      }
      await parseTranscripts(r.serverEnv, NOW + pass, { budget: { calls: 24, wallMs: 60_000 } });
      const now = parsed(tx('history'));
      expect({ pass, moved: now > imported }).toEqual({ pass, moved: true });
      imported = now;
    }
    // Live work moved too: the cap is a share, not a queue behind the import.
    expect([0, 1, 2].some((k) => parsed(tx(`grow${k}`)) > 0)).toBe(true);
  });

  it('reads the import with least left to read first, whatever order they arrived in', async () => {
    const r = await rig();
    let long = '';
    for (let i = 0; i < 200; i += 1) long += body(4_000 + i);
    await r.ship('s-long', tx('long'), long, 'import', NOW - 200_000);
    await r.ship('s-short', tx('short'), body(4_999), 'import', NOW - 100_000);
    const state = (id: string) => r.sqlite.query(`SELECT parsed_offset, size FROM transcripts WHERE transcript_id = ?`).get(id) as { parsed_offset: number; size: number };
    // The selection names the import with least left first, and the pass that reads imports side by side finishes it.
    const order = (r.sqlite.query(laneSelectionSql('imported', 2).replace('?', String(PARSER_VERSION))).all() as { transcript_id: string }[]).map((row) => row.transcript_id);
    expect(order).toEqual([tx('short'), tx('long')]);
    await parseTranscripts(r.serverEnv, NOW, { budget: { calls: 4, wallMs: 60_000 } });
    expect(state(tx('short')).parsed_offset).toBe(state(tx('short')).size);
    expect(state(tx('long')).parsed_offset).toBeLessThan(state(tx('long')).size);
  });

  it('chains the next wake while a backlog remains, and returns to the cadence once it is read', async () => {
    const r = await rig();
    let history = '';
    for (let i = 0; i < 600; i += 1) history += body(3_000 + i);
    await r.ship('s-history', tx('history'), history, 'import', NOW);
    const env = { ...r.serverEnv, platform: { ...r.serverEnv.platform, jobBudget: { calls: 6, wallMs: 60_000 } } };
    const first = await runTick(env, NOW);
    expect({ more: first.jobs.find((j) => j.name === 'transcript-parse')?.more, next: first.nextWakeMs, waiting: first.backlog.imported.transcripts })
      .toEqual({ more: true, next: CHAINED_WAKE_MS, waiting: 1 });
    let last = first;
    for (let tick = 1; tick < 200 && last.jobs.find((j) => j.name === 'transcript-parse')?.more === true; tick += 1) last = await runTick(env, NOW + tick);
    expect({ more: last.jobs.find((j) => j.name === 'transcript-parse')?.more, next: last.nextWakeMs, waiting: last.backlog.transcripts })
      .toEqual({ more: false, next: nextWakeDelayMs(last.state, WAKE_INTERVALS), waiting: 0 });
    expect(last.nextWakeMs).toBeGreaterThan(CHAINED_WAKE_MS);
  });

  it('selects each half through the partial backlog index, so a store of finished transcripts is never scanned', () => {
    const { sqlite } = sqliteEnv();
    for (const lane of ['live', 'imported', 'repair'] as const) {
      const plan = (sqlite.query(`EXPLAIN QUERY PLAN ${laneSelectionSql(lane).replace('?', String(PARSER_VERSION))}`).all() as { detail: string }[]).map((r) => r.detail);
      expect({ lane, indexed: plan.some((d) => /^SEARCH transcripts USING INDEX idx_transcripts_backlog \(imported_at/.test(d)) }).toEqual({ lane, indexed: true });
    }
  });

  it('counts as pending work but holds the Deployment no deeper than idle', async () => {
    const r = await rig();
    await r.ship('s-import', tx('tx_import'), body(1), 'import', NOW);
    expect(await pendingTranscripts(r.serverEnv.db)).toMatchObject({ transcripts: 1, imported: { transcripts: 1 } });

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

    // Both arms in one test: a change that stopped scheduling titles entirely
    // would pass an assertion that only checked the import arm.
    expect((await end('s-live', 'cli')).projected).toBe(true);
    expect((await end('s-imported', 'import')).projected).toBe(true);
    await e.deferred.settle();
    const requested = (id: string): boolean => (e.sqlite.query(`SELECT titling_requested_at AS at FROM sessions WHERE session_id = ?`).get(id) as { at: number | null }).at !== null;
    expect({ live: requested('s-live'), imported: requested('s-imported') }).toEqual({ live: true, imported: false });
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
    const outcome = await shipWithHead(tx('hh'), body(2), NOW + 1, new TextEncoder().encode(first).length, 'b'.repeat(64));
    expect(refused(outcome).code).toBe('transcript_replaced');
  });

  it('excludes an imported reduced-fidelity session from extraction, and shows it to a reader', async () => {
    const r = await rig();
    // The fidelity flag is written by the parse from the parser's own
    // declaration, so an imported Cursor session inherits the rule rather than
    // needing the import to apply it. Asserted rather than assumed.
    await r.ship('s-cursor', tx('cursor'), body(1), 'import', NOW);
    r.sqlite.run(`UPDATE transcripts SET agent = 'cursor', fidelity = 'no_tool_results' WHERE transcript_id = ?`, [tx('cursor')]);

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
                    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`, [PROJECT, row.id, MACHINE, r.tokenId, row.recv, row.recv, row.started]);
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

describe('imports read side by side', () => {
  /** Imports whose turns each name their own prompt, so every row they derive is told apart. */
  const imports = async (r: Awaited<ReturnType<typeof rig>>, count: number, turns: number) => {
    for (let t = 0; t < count; t += 1) {
      let text = '';
      for (let i = 0; i < turns; i += 1) text += body(50_000 + t * 1_000 + i);
      expect((await r.ship(`s-side-${t}`, tx(`side${t}`), text, 'import', NOW - 1_000 * (t + 1))).persisted).toBe(true);
    }
  };
  const state = (r: Awaited<ReturnType<typeof rig>>) => r.sqlite.query(`SELECT transcript_id, parsed_offset = size AS done, parse_error FROM transcripts ORDER BY transcript_id`).all();
  const counts = (r: Awaited<ReturnType<typeof rig>>) => Object.fromEntries(['events', 'prompt_batches', 'responses'].map((t) => [t, (r.sqlite.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n]));

  it('takes several distinct imports in one selection and reads each once to its end', async () => {
    const r = await rig();
    await imports(r, TRANSCRIPT_PARSE_IMPORTED_AT_ONCE, 5);
    const selected: number[] = [];
    const spy = (statement: PreparedStatement, sql: string): PreparedStatement => ({
      ...statement,
      bind: (...values: unknown[]) => spy(statement.bind(...values), sql),
      all: async <T,>() => {
        const answer = await statement.all<T>();
        if (/FROM transcripts\s/.test(sql) && /json_group_array/.test(sql)) selected.push(answer.results.length);
        return answer;
      },
    });
    const db: RelationalStore = { prepare: (sql: string) => spy(r.serverEnv.db.prepare(sql), sql), batch: (statements) => r.serverEnv.db.batch(statements) };
    await parseTranscripts({ ...r.serverEnv, db }, NOW, { budget: { calls: 200, wallMs: 60_000 } });
    // Each selection names every import: first its bytes, then its terminal continuation.
    expect(selected.filter((n) => n > 0)).toEqual([TRANSCRIPT_PARSE_IMPORTED_AT_ONCE, TRANSCRIPT_PARSE_IMPORTED_AT_ONCE]);
    expect(state(r)).toEqual(Array.from({ length: TRANSCRIPT_PARSE_IMPORTED_AT_ONCE }, (_, t) => ({ transcript_id: tx(`side${t}`), done: 1, parse_error: null }))
      .sort((a, b) => a.transcript_id.localeCompare(b.transcript_id)));
    expect(counts(r)).toMatchObject({ prompt_batches: TRANSCRIPT_PARSE_IMPORTED_AT_ONCE * 5, responses: TRANSCRIPT_PARSE_IMPORTED_AT_ONCE * 5 });
  });

  it('lands every row once when two wakes read the same imports at once', async () => {
    const alone = await rig();
    await imports(alone, 6, 40);
    for (let pass = 0; pass < 20 && (await pendingTranscripts(alone.serverEnv.db)).transcripts > 0; pass += 1) {
      await parseTranscripts(alone.serverEnv, NOW, { budget: { calls: 12, wallMs: 60_000 } });
    }
    const together = await rig();
    await imports(together, 6, 40);
    for (let pass = 0; pass < 20 && (await pendingTranscripts(together.serverEnv.db)).transcripts > 0; pass += 1) {
      // A clock wake and an owner's wake at once: each selects the same imports and reads them side by side.
      await Promise.all([
        parseTranscripts(together.serverEnv, NOW, { budget: { calls: 12, wallMs: 60_000 } }),
        parseTranscripts(together.serverEnv, NOW, { budget: { calls: 12, wallMs: 60_000 } }),
      ]);
    }
    expect(state(together)).toEqual(state(alone));
    expect(state(together).every((row) => (row as { done: number }).done === 1)).toBe(true);
    expect(counts(together)).toEqual(counts(alone));
  });
});

describe('imports read side by side within a byte budget', () => {
  /** An import of `turns` turns whose replies are `replyChars` long, in one segment. */
  const importOf = (name: string, turns: number, replyChars: number) => {
    let text = '';
    for (let i = 0; i < turns; i += 1) {
      text += line({ type: 'user', promptId: uuid(900_000 + name.length * 1_000 + i), message: { content: `${name} prompt ${i}` }, timestamp: '2026-09-01T10:00:00Z' })
        + line({ type: 'assistant', message: { content: [{ type: 'text', text: `${name} ${'r'.repeat(replyChars)}` }] }, timestamp: '2026-09-01T10:00:01Z' });
    }
    return text;
  };
  /** Every pass's start and end, and the most segment bytes and passes held at once. */
  const watch = () => {
    const held = new Map<string, number>();
    const seen = { bytes: [] as number[], most: 0, together: 0 };
    return {
      seen,
      passes: {
        started: (id: string, bytes: number) => {
          if (bytes > 0) held.set(id, bytes);
          seen.bytes.push(bytes);
          seen.most = Math.max(seen.most, [...held.values()].reduce((n, b) => n + b, 0));
          seen.together = Math.max(seen.together, held.size);
        },
        ended: (id: string) => { held.delete(id); },
      },
    };
  };

  it('reads full 8 MiB segments one at a time, holding no more than the budget at once', async () => {
    const r = await rig();
    const size = Buffer.byteLength(importOf('a', 40, 200_000));
    expect(size).toBeGreaterThan(8_000_000);
    for (const name of ['a', 'b', 'c', 'd']) await r.ship(`s-big-${name}`, tx(`big-${name}`), importOf(name, 40, 200_000), 'import', NOW - 1_000);
    const w = watch();
    await parseTranscripts(r.serverEnv, NOW, { budget: { calls: 200, wallMs: 600_000 }, passes: w.passes });
    // Each pass is counted at the segment it reads, and no two full ones were held at once.
    expect(w.seen.bytes.filter((b) => b === size).length).toBeGreaterThanOrEqual(TRANSCRIPT_PARSE_IMPORTED_AT_ONCE);
    expect(w.seen.most).toBeLessThanOrEqual(TRANSCRIPT_PARSE_CONCURRENT_BYTES);
    expect(w.seen.together).toBe(1);
  }, 120_000);

  it('still reads small imports together', async () => {
    const r = await rig();
    for (const name of ['p', 'q', 's', 't']) await r.ship(`s-small-${name}`, tx(`small-${name}`), importOf(name, 5, 100), 'import', NOW - 1_000);
    const w = watch();
    await parseTranscripts(r.serverEnv, NOW, { budget: { calls: 200, wallMs: 60_000 }, passes: w.passes });
    expect(w.seen.together).toBe(TRANSCRIPT_PARSE_IMPORTED_AT_ONCE);
    expect(w.seen.most).toBeLessThanOrEqual(TRANSCRIPT_PARSE_CONCURRENT_BYTES);
  });

  it('runs work side by side only while its bytes fit, in order, and alone where one is over the budget', async () => {
    const log: string[] = [];
    const gates = new Map<string, () => void>();
    const work = (name: string) => new Promise<string>((resolve) => { log.push(`start ${name}`); gates.set(name, () => { log.push(`end ${name}`); resolve(name); }); });
    const sizes: Record<string, number> = { a: 6, b: 6, c: 12, d: 2 };
    const done = withinBytes(['a', 'b', 'c', 'd'], (n) => sizes[n]!, 10, work);
    await Bun.sleep(0);
    expect(log).toEqual(['start a']);
    gates.get('a')!();
    await Bun.sleep(0);
    expect(log).toEqual(['start a', 'end a', 'start b']);
    gates.get('b')!();
    await Bun.sleep(0);
    expect(log.slice(-2)).toEqual(['end b', 'start c']);
    gates.get('c')!();
    await Bun.sleep(0);
    gates.get('d')!();
    expect(await done).toEqual(['a', 'b', 'c', 'd']);
  });
});
