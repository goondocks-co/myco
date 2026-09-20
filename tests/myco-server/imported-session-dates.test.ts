/**
 * An imported session's presented dates, and the raw lifecycle beneath them.
 *
 * An import dates a session by its transcript file's modification time, the one
 * instant a member knows without parsing. The parse derives the turns with
 * their own instants, and the presented dates move onto them.
 *
 * The property every case here asserts is that the same set of events reaches
 * the same state in any order. Presented dates live in their own columns and no
 * projection reads them, so the raw lifecycle — admission, reopen, titling —
 * compares the same baseline whether or not a parse has run.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { parseOnce, TRANSCRIPT_PARSE_EVENTS_PER_BATCH } from '@myco-server-worker/ingest/parse.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { resolvePresentedDates } from '@myco-server-worker/ingest/projections.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { listSessions } from '@myco-server-worker/read/sessions.js';
import { endSession } from '@myco-server-worker/core/session-end.js';
import { searchProject } from '@myco-server-worker/read/search.js';
import { registerBlob } from './helpers/d1.js';
import { envelope, sqliteEnv, uuid } from './helpers/fixtures.js';

const PROJECT = 'proj_1';
const SESSION = 's1';
const TRANSCRIPT = 'tx_0123456789abcdef0123456789abcdef';
const MACHINE = 'machine_1';
const NOW = Date.parse('2027-01-01T00:00:00Z');

/** The instants the cases are written against; the import's mtime is later than the conversation, as a real one is. */
const T = Date.parse('2026-09-01T10:00:00Z');
const DERIVED_FIRST = T;
const DERIVED_LAST = T + 10_000;
const IMPORT_AT = T + 100_000;
const LIVE_END = T + 150_000;
const LIVE_START = T + 200_000;

const line = (o: Record<string, unknown>): string => `${JSON.stringify(o)}\n`;

/** Two turns whose derived rows land at `DERIVED_FIRST` and `DERIVED_LAST`. */
const conversation = (): string =>
  line({ type: 'user', promptId: uuid(1), message: { content: 'a question' }, timestamp: new Date(DERIVED_FIRST).toISOString() })
  + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'an answer' }] }, timestamp: new Date(DERIVED_LAST).toISOString() });

/** Lines the parser derives nothing from. */
const metadataTail = (n: number): string =>
  Array.from({ length: n }, (_, i) => line({ type: 'file-history-snapshot', messageId: `m${i}`, snapshot: { trackedFileBackups: {} } })).join('');

async function rig(text: string, sliceBytes = 1 << 20) {
  const { sqlite, serverEnv } = sqliteEnv();
  const issued = await issueMemberToken(serverEnv.db, { memberId: 'mem_machine_1', machineId: MACHINE }, NOW);
  const bytes = new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
  sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
              VALUES (?, ?, ?, ?, ?, ?)`, [PROJECT, SESSION, MACHINE, issued.tokenId, NOW, NOW]);
  sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, segment_count, first_received_at, last_received_at, token_id, imported_at)
              VALUES (?, ?, ?, ?, 'claude-code', ?, 1, ?, ?, ?, ?)`,
             [PROJECT, TRANSCRIPT, SESSION, MACHINE, bytes.length, NOW, NOW, issued.tokenId, NOW]);
  await appendSegments(sqlite, serverEnv, issued.tokenId, bytes, 0, sliceBytes);
  return { sqlite, serverEnv, env: { db: serverEnv.db, blobs: serverEnv.blobs }, tokenId: issued.tokenId };
}

/** Stores `bytes` as segments from `baseOffset`, growing the transcript's size as a later upload does. */
async function appendSegments(sqlite: Database, serverEnv: { blobs: { put(key: string, body: ReadableStream): Promise<unknown> } }, tokenId: string, bytes: Uint8Array<ArrayBuffer>, baseOffset: number, sliceBytes: number) {
  for (let at = 0; at < bytes.length; at += sliceBytes) {
    const slice = bytes.subarray(at, Math.min(at + sliceBytes, bytes.length));
    const key = await sha256HexOf(slice);
    const objectKey = registerBlob(sqlite, { projectId: PROJECT, key, size: slice.length, tokenId, receivedAt: NOW });
    await serverEnv.blobs.put(objectKey, new Blob([slice]).stream() as ReadableStream);
    sqlite.run(`INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [PROJECT, TRANSCRIPT, baseOffset + at, slice.length, key, `e${baseOffset + at}`, NOW, NOW, tokenId]);
  }
  sqlite.run(`UPDATE transcripts SET size = ? WHERE project_id = ? AND transcript_id = ?`, [baseOffset + bytes.length, PROJECT, TRANSCRIPT]);
}

const ctxFor = (tokenId: string) => ({ projectId: PROJECT, machineId: MACHINE, tokenId, bodyBytes: 100, now: NOW });

let nextEvent = 100;
const send = (serverEnv: { db: unknown }, tokenId: string, kind: string, at: number, payload: Record<string, unknown>, channel: string) =>
  ingestEvent(serverEnv.db as never, ctxFor(tokenId), envelope({ eventId: uuid(nextEvent++), sessionId: SESSION, kind, createdAt: at, channel, payload }));

/** The two facts an import ships before any segment. */
async function importFacts(serverEnv: { db: unknown }, tokenId: string) {
  await send(serverEnv, tokenId, 'session.start', IMPORT_AT, { agent: 'claude-code', startedAt: IMPORT_AT, originPath: '/w/p' }, 'import');
  await send(serverEnv, tokenId, 'session.end', IMPORT_AT, { endedAt: IMPORT_AT }, 'import');
}

/** Drives passes to completion. */
async function drain(env: { db: unknown; blobs: unknown }, sqlite: Database, max = 50): Promise<number> {
  let passes = 0;
  for (;;) {
    const t = sqlite.query(`SELECT project_id, transcript_id, session_id, machine_id, token_id, agent, size, parsed_offset, fidelity, open_prompt_id, parser_context, imported_at, parse_error FROM transcripts`).get() as Record<string, unknown>;
    if (passes >= max || (t.parsed_offset as number) >= (t.size as number) || t.parse_error !== null) return passes;
    const before = t.parsed_offset as number;
    await parseOnce(env as never, {
      projectId: t.project_id as string, transcriptId: t.transcript_id as string, sessionId: t.session_id as string,
      machineId: t.machine_id as string, tokenId: t.token_id as string, agent: t.agent as string,
      size: t.size as number, parsedOffset: before, fidelity: null,
      openPromptId: (t.open_prompt_id as string | null) ?? null,
      parserContext: typeof t.parser_context === 'string' ? JSON.parse(t.parser_context) : null,
      imported: t.imported_at !== null && t.imported_at !== undefined,
    }, NOW);
    passes += 1;
    if ((sqlite.query(`SELECT parsed_offset FROM transcripts`).get() as { parsed_offset: number }).parsed_offset === before) return passes;
  }
}

/** Everything a later event or a later pass could disagree about. */
const state = (sqlite: Database) => sqlite.query(
  `SELECT started_at, ended_at, occurred_started_at, occurred_ended_at, facts_event_id, titling_requested_at, ended_by
     FROM sessions WHERE project_id = ? AND session_id = ?`).get(PROJECT, SESSION);

/** Runs one scenario's steps in the given order and returns the settled state. */
async function settle(steps: readonly ('parse' | 'liveEnd' | 'liveStart' | 'liveTurn')[], text = conversation()) {
  nextEvent = 100;
  const r = await rig(text);
  await importFacts(r.serverEnv, r.tokenId);
  for (const step of steps) {
    if (step === 'parse') await drain(r.env, r.sqlite);
    if (step === 'liveEnd') await send(r.serverEnv, r.tokenId, 'session.end', LIVE_END, { endedAt: LIVE_END }, 'cli');
    if (step === 'liveStart') await send(r.serverEnv, r.tokenId, 'session.start', LIVE_START, { agent: 'claude-code', startedAt: LIVE_START }, 'cli');
    if (step === 'liveTurn') await send(r.serverEnv, r.tokenId, 'prompt', LIVE_END, { promptId: uuid(900), text: 'resumed by hand', origin: 'user' }, 'cli');
  }
  // A parse always eventually runs; a scenario that did not name it runs it last
  // so both orders compare the same completed work.
  if (!steps.includes('parse')) await drain(r.env, r.sqlite);
  return state(r.sqlite);
}

/** Every ordering of the steps, as a list of step arrays. */
function orderings<T>(steps: readonly T[]): T[][] {
  if (steps.length <= 1) return [[...steps]];
  return steps.flatMap((step, n) => orderings([...steps.slice(0, n), ...steps.slice(n + 1)]).map((rest) => [step, ...rest]));
}

describe('an imported session\'s dates, in any order', () => {
  it('presents the conversation for a pure import, leaving the raw lifecycle at the import\'s own instants', async () => {
    expect(await settle(['parse'])).toMatchObject({
      started_at: IMPORT_AT, ended_at: IMPORT_AT,
      occurred_started_at: DERIVED_FIRST, occurred_ended_at: DERIVED_LAST,
    });
  });

  it('reaches one state whichever order a live end and a live start arrive in around the parse', async () => {
    const results = [];
    for (const order of orderings(['parse', 'liveEnd', 'liveStart'] as const)) results.push({ order: order.join('>'), state: await settle(order) });
    for (const result of results) expect({ order: result.order, state: result.state }).toEqual({ order: result.order, state: results[0].state });
    // The live end stands: nothing restores the raw lifecycle over it.
    expect(results[0].state).toMatchObject({ started_at: IMPORT_AT, ended_at: LIVE_END, occurred_started_at: null, occurred_ended_at: null });
  });

  it('reaches one state whichever order a live start arrives in, though it never wins the facts', async () => {
    const [a, b] = [await settle(['parse', 'liveStart']), await settle(['liveStart', 'parse'])];
    expect(a).toEqual(b);
    expect(a).toMatchObject({ started_at: IMPORT_AT, facts_event_id: expect.any(String), occurred_started_at: null });
  });

  it('reaches one state for an end between the derived turns and the import mtime', async () => {
    const between = async (order: readonly ('parse' | 'liveEnd')[]) => {
      nextEvent = 100;
      const r = await rig(conversation());
      await importFacts(r.serverEnv, r.tokenId);
      for (const step of order) {
        if (step === 'parse') await drain(r.env, r.sqlite);
        else await send(r.serverEnv, r.tokenId, 'session.end', DERIVED_LAST + 1_000, { endedAt: DERIVED_LAST + 1_000 }, 'cli');
      }
      if (!order.includes('parse')) await drain(r.env, r.sqlite);
      return state(r.sqlite);
    };
    const [a, b] = [await between(['parse', 'liveEnd']), await between(['liveEnd', 'parse'])];
    expect(a).toEqual(b);
    // The end is older than the standing import end, so it never applies and
    // never requests a title, whichever side of the parse it arrives on.
    expect(a).toMatchObject({ ended_at: IMPORT_AT, titling_requested_at: null });
  });

  it('leaves a session a person resumed by hand open, inventing no end for it', async () => {
    const [a, b] = [await settle(['parse', 'liveTurn']), await settle(['liveTurn', 'parse'])];
    expect(a).toEqual(b);
    expect(a).toMatchObject({ occurred_ended_at: null });
  });

  it('presents no end for a source that shipped none, however its turns are dated', async () => {
    nextEvent = 100;
    const r = await rig(conversation());
    // The start alone: a source still open ships no `session.end`.
    await send(r.serverEnv, r.tokenId, 'session.start', IMPORT_AT, { agent: 'claude-code', startedAt: IMPORT_AT, originPath: '/w/p' }, 'import');
    await drain(r.env, r.sqlite);

    expect(state(r.sqlite)).toMatchObject({ ended_at: null, occurred_started_at: DERIVED_FIRST, occurred_ended_at: null });
  });

  it('presents the conversation once a later upload arrives, though an earlier pass reached the bytes it had', async () => {
    nextEvent = 100;
    const r = await rig(conversation() + metadataTail(200), 4096);
    await importFacts(r.serverEnv, r.tokenId);
    await drain(r.env, r.sqlite);
    expect(state(r.sqlite)).toMatchObject({ occurred_ended_at: DERIVED_LAST });

    const later = new TextEncoder().encode(line({ type: 'user', promptId: uuid(2), message: { content: 'one more' }, timestamp: new Date(DERIVED_LAST + 5_000).toISOString() }));
    const size = (r.sqlite.query(`SELECT size FROM transcripts`).get() as { size: number }).size;
    await appendSegments(r.sqlite, r.serverEnv, r.tokenId, later, size, 4096);
    await drain(r.env, r.sqlite);

    expect(state(r.sqlite)).toMatchObject({ ended_at: IMPORT_AT, occurred_ended_at: DERIVED_LAST + 5_000 });
  });
});


describe('an imported session a member goes on capturing live', () => {
  it('presents no overlay once a segment arrives on a live channel, with no hook start or end', async () => {
    nextEvent = 100;
    const r = await rig(conversation());
    await importFacts(r.serverEnv, r.tokenId);
    await drain(r.env, r.sqlite);
    expect(state(r.sqlite)).toMatchObject({ occurred_started_at: DERIVED_FIRST, occurred_ended_at: DERIVED_LAST });

    // The member ships more of the same transcript from the live path. Its
    // turns parse under the same adapter as the imported ones, so the segment's
    // own channel is what says this session is no longer a backfill's.
    const more = new TextEncoder().encode(line({ type: 'user', promptId: uuid(3), message: { content: 'still here' }, timestamp: new Date(DERIVED_LAST + 5_000).toISOString() }));
    const size = (r.sqlite.query('SELECT size FROM transcripts').get() as { size: number }).size;
    const key = await sha256HexOf(more);
    const objectKey = registerBlob(r.sqlite, { projectId: PROJECT, key, size: more.length, tokenId: r.tokenId, receivedAt: NOW });
    await r.serverEnv.blobs.put(objectKey, new Blob([more]).stream() as ReadableStream);
    await send(r.serverEnv, r.tokenId, 'transcript.segment', DERIVED_LAST + 5_000,
               { transcriptId: TRANSCRIPT, baseOffset: size, length: more.length, blob: key, agent: 'claude-code' }, 'cli');

    expect((r.sqlite.query('SELECT imported_at FROM transcripts').get() as { imported_at: number | null }).imported_at).toBeNull();
    // The accepted segment clears it; no pass has run, and one that derived
    // nothing would leave a stale overlay standing.
    expect(state(r.sqlite)).toMatchObject({ occurred_started_at: null, occurred_ended_at: null });

    await drain(r.env, r.sqlite);
    expect(state(r.sqlite)).toMatchObject({ started_at: IMPORT_AT, occurred_started_at: null, occurred_ended_at: null });

    const later = new TextEncoder().encode(line({ type: 'user', promptId: uuid(4), message: { content: 'later import' }, timestamp: new Date(DERIVED_LAST + 10_000).toISOString() }));
    const laterKey = await sha256HexOf(later);
    const laterObject = registerBlob(r.sqlite, { projectId: PROJECT, key: laterKey, size: later.length, tokenId: r.tokenId, receivedAt: NOW });
    await r.serverEnv.blobs.put(laterObject, new Blob([later]).stream() as ReadableStream);
    expect(await send(r.serverEnv, r.tokenId, 'transcript.segment', DERIVED_LAST + 10_000,
      { transcriptId: TRANSCRIPT, baseOffset: size + more.length, length: later.length, blob: laterKey, agent: 'claude-code' }, 'import')).toMatchObject({ persisted: true, projected: true });
    expect((r.sqlite.query('SELECT imported_at FROM transcripts').get() as { imported_at: number | null }).imported_at).not.toBeNull();
    await drain(r.env, r.sqlite);
    expect(state(r.sqlite)).toMatchObject({ occurred_started_at: null, occurred_ended_at: null });
  });
});

describe('a conflicting turn on a session that carries an overlay', () => {
  it('still answers a projection conflict, though clearing the overlay changed a row', async () => {
    nextEvent = 100;
    const r = await rig(conversation());
    await importFacts(r.serverEnv, r.tokenId);
    await drain(r.env, r.sqlite);
    expect(state(r.sqlite)).toMatchObject({ occurred_started_at: DERIVED_FIRST });

    const derivedPrompt = r.sqlite.query('SELECT prompt_id FROM prompt_batches WHERE project_id = ? AND session_id = ?').get(PROJECT, SESSION) as { prompt_id: string } | null;
    expect(derivedPrompt).not.toBeNull();
    const promptId = derivedPrompt!.prompt_id;
    const stored = () => r.sqlite.query('SELECT text FROM prompt_batches WHERE project_id = ? AND prompt_id = ?').get(PROJECT, promptId);
    const before = stored();
    expect(before).not.toBeNull();
    const conflicting = await send(r.serverEnv, r.tokenId, 'prompt', LIVE_END, { promptId, text: 'a different text', origin: 'user' }, 'cli');
    expect(conflicting).toMatchObject({ persisted: true, projected: false, code: 'projection_conflict' });
    expect(stored()).toEqual(before);
    expect(state(r.sqlite)).toMatchObject({ occurred_started_at: null });
  });
});

describe('an import whose file was written before its last turn', () => {
  /** A conversation whose turns run past the import's mtime, which no filesystem clock guarantees against. */
  const pastMtime = (): string =>
    line({ type: 'user', promptId: uuid(1), message: { content: 'a question' }, timestamp: new Date(DERIVED_FIRST).toISOString() })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'an answer' }] }, timestamp: new Date(DERIVED_LAST).toISOString() })
    + line({ type: 'user', promptId: uuid(2), message: { content: 'one more' }, timestamp: new Date(IMPORT_AT + 30_000).toISOString() });

  it('presents an end at the last turn, and reads as ended rather than open', async () => {
    nextEvent = 100;
    const r = await rig(pastMtime());
    await importFacts(r.serverEnv, r.tokenId);
    await drain(r.env, r.sqlite);

    // The turn is newer than the import's end, so the raw lifecycle reopens;
    // the presented end is the conversation's own last instant.
    const settled = state(r.sqlite) as { ended_at: number | null; occurred_ended_at: number | null };
    expect(settled.ended_at).toBeNull();
    expect(settled.occurred_ended_at).toBe(IMPORT_AT + 30_000);

    const open = await listSessions(r.serverEnv.db, { projectId: PROJECT }, { state: 'open', fidelity: 'any' });
    const ended = await listSessions(r.serverEnv.db, { projectId: PROJECT }, { state: 'ended', fidelity: 'any' });
    expect({ open: open.rows.length, ended: ended.rows.length }).toEqual({ open: 0, ended: 1 });
    expect(ended.rows[0].endedAt).toBe(IMPORT_AT + 30_000);
  });

  it('leaves a session a person resumed by hand open on the same read', async () => {
    nextEvent = 100;
    const r = await rig(conversation());
    await importFacts(r.serverEnv, r.tokenId);
    await drain(r.env, r.sqlite);
    await send(r.serverEnv, r.tokenId, 'prompt', IMPORT_AT + 60_000, { promptId: uuid(901), text: 'resumed by hand', origin: 'user' }, 'cli');

    const open = await listSessions(r.serverEnv.db, { projectId: PROJECT }, { state: 'open', fidelity: 'any' });
    expect({ open: open.rows.length, occurred: state(r.sqlite) }).toMatchObject({ open: 1 });
    expect(state(r.sqlite)).toMatchObject({ occurred_ended_at: null });
  });
});

describe('the vector a presented date is filtered by', () => {
  const revision = (sqlite: Database) => (sqlite.query(
    "SELECT revision FROM embedding_versions WHERE project_id = ? AND type = 'session' AND record_id = ?").get(PROJECT, SESSION) as { revision: string } | null)?.revision ?? null;

  it('invalidates a session\'s vector when its presented start moves, and leaves it alone when a pass resolves the same instant', async () => {
    nextEvent = 100;
    const r = await rig(conversation());
    await importFacts(r.serverEnv, r.tokenId);
    const before = revision(r.sqlite);

    await drain(r.env, r.sqlite);
    const moved = revision(r.sqlite);
    expect(state(r.sqlite)).toMatchObject({ occurred_started_at: DERIVED_FIRST });
    expect(moved).not.toBe(before);

    // A pass over a transcript already read resolves the same minimum.
    await r.serverEnv.db.batch([resolvePresentedDates(r.serverEnv.db, PROJECT, SESSION)]);
    expect(revision(r.sqlite)).toBe(moved);
  });

  it('reads a session\'s search date from the instant it is presented at', async () => {
    nextEvent = 100;
    const r = await rig(conversation());
    await importFacts(r.serverEnv, r.tokenId);
    await drain(r.env, r.sqlite);
    r.sqlite.run("UPDATE sessions SET summary = 'a summary' WHERE project_id = ? AND session_id = ?", [PROJECT, SESSION]);

    const row = r.sqlite.query("SELECT created_at FROM embedding_sources WHERE project_id = ? AND type = 'session' AND record_id = ?").get(PROJECT, SESSION) as { created_at: number } | null;
    expect(row?.created_at).toBe(DERIVED_FIRST);
  });
});

describe('the dates and state a search filters on', () => {
  /** A conversation whose last human turn runs past the import's mtime. */
  const pastMtime = (): string =>
    line({ type: 'user', promptId: uuid(1), message: { content: 'a question' }, timestamp: new Date(DERIVED_FIRST).toISOString() })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'an answer' }] }, timestamp: new Date(DERIVED_LAST).toISOString() })
    + line({ type: 'user', promptId: uuid(2), message: { content: 'one more' }, timestamp: new Date(IMPORT_AT + 30_000).toISOString() });

  const seconds = (ms: number) => Math.floor(ms / 1000);

  async function searchable() {
    nextEvent = 100;
    const r = await rig(pastMtime());
    await importFacts(r.serverEnv, r.tokenId);
    await drain(r.env, r.sqlite);
    r.sqlite.run("UPDATE sessions SET title = 'cobalt session', summary = 'a summary' WHERE project_id = ? AND session_id = ?", [PROJECT, SESSION]);
    return r;
  }

  const ids = (answer: { results: readonly { id: string }[] }) => answer.results.map((x) => x.id);

  it('admits an imported session by the date it is presented at, on the path a project with no provider gets', async () => {
    const r = await searchable();
    const found = await searchProject(r.serverEnv.db, { projectId: PROJECT }, { query: 'cobalt', type: 'session', mode: 'fts', since: seconds(DERIVED_FIRST) });
    expect(ids(found)).toContain(SESSION);

    // The mtime is later than the conversation: a bound past the presented date
    // admits nothing, and a bound at the raw start would still admit it.
    const after = await searchProject(r.serverEnv.db, { projectId: PROJECT }, { query: 'cobalt', type: 'session', mode: 'fts', since: seconds(DERIVED_FIRST) + 1 });
    expect(ids(after)).not.toContain(SESSION);
  });

  it('reads the session as finished on that path, though the raw lifecycle reopened it', async () => {
    const r = await searchable();
    expect(state(r.sqlite)).toMatchObject({ ended_at: null });

    const completed = await searchProject(r.serverEnv.db, { projectId: PROJECT }, { query: 'cobalt', type: 'session', mode: 'fts', status: 'completed' });
    const active = await searchProject(r.serverEnv.db, { projectId: PROJECT }, { query: 'cobalt', type: 'session', mode: 'fts', status: 'active' });
    expect({ completed: ids(completed), active: ids(active) }).toEqual({ completed: [SESSION], active: [] });
  });

  it('gives the semantic source the same date and state the full-text path filtered on', async () => {
    const r = await searchable();
    const semantic = r.sqlite.query(
      "SELECT created_at AS created, status FROM embedding_sources WHERE project_id = ? AND type = 'session' AND record_id = ?")
      .get(PROJECT, SESSION) as { created: number; status: string };
    expect(semantic).toEqual({ created: DERIVED_FIRST, status: 'completed' });
  });
});


describe('an imported pass that stops after retaining rows', () => {
  it('presents retained dates when the project is archived between event batches', async () => {
    nextEvent = 100;
    const count = TRANSCRIPT_PARSE_EVENTS_PER_BATCH;
    const text = Array.from({ length: count + 1 }, (_, i) => line({ type: 'user', promptId: uuid(i + 1), message: { content: `retained ${i}` }, timestamp: new Date(DERIVED_FIRST + i).toISOString() })).join('');
    const r = await rig(text);
    await importFacts(r.serverEnv, r.tokenId);
    let archived = false;
    const db = { ...r.env.db, batch: async (statements: Parameters<typeof r.env.db.batch>[0]) => {
      const result = await r.env.db.batch(statements);
      if (!archived) {
        r.sqlite.run('UPDATE projects SET archived_at = ? WHERE project_id = ?', [NOW, PROJECT]);
        archived = true;
      }
      return result;
    } };
    await drain({ ...r.env, db }, r.sqlite);
    expect(r.sqlite.query('SELECT parse_error FROM transcripts').get()).toMatchObject({ parse_error: 'parse' });
    expect(r.sqlite.query('SELECT COUNT(*) AS n FROM prompt_batches').get()).toEqual({ n: count });
    expect(state(r.sqlite)).toMatchObject({ started_at: IMPORT_AT, ended_at: IMPORT_AT, occurred_started_at: DERIVED_FIRST, occurred_ended_at: DERIVED_FIRST + count - 1 });
  });
});

/**
 * The lifecycle beneath a presented date, on the two paths that read it.
 *
 * A presented end is a reader's fact. Ending a session and dating a line are
 * lifecycle acts, and both take the lifecycle columns: an imported session shown
 * as finished is still open to an owner's end, and a line the transcript left
 * undated belongs to the date the import gave the session rather than to the
 * instant the parse happened to run.
 */
describe('a presented date does not decide the lifecycle', () => {
  it('ends an imported session presented as finished whose lifecycle is still open', async () => {
    // Turns derived after the import's end: the end no longer applies to the
    // lifecycle, which reads open, while the presented end stands at the import's.
    const later = line({ type: 'user', promptId: uuid(31), message: { content: 'a later question' }, timestamp: new Date(IMPORT_AT + 50_000).toISOString() })
      + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'a later answer' }] }, timestamp: new Date(IMPORT_AT + 60_000).toISOString() });
    const r = await rig(later);
    await importFacts(r.serverEnv, r.tokenId);
    await drain(r.env, r.sqlite);
    await r.serverEnv.db.batch([resolvePresentedDates(r.serverEnv.db, PROJECT, SESSION)]);

    const presented = (await listSessions(r.serverEnv.db, { projectId: PROJECT })).rows[0]!;
    const raw = r.sqlite.query(`SELECT started_at, ended_at FROM sessions`).get() as { started_at: number | null; ended_at: number | null };
    expect(presented.endedAt).not.toBeNull();
    expect(raw.ended_at).toBeNull();

    const endedAt = NOW + 5_000;
    const outcome = await endSession(r.serverEnv.db, { projectId: PROJECT }, SESSION, endedAt, 'mem_machine_1');
    expect(outcome).toEqual({ outcome: 'ended', endedAt });

    // The lifecycle end requests titling.
    const after = r.sqlite.query(`SELECT ended_at, ended_by, titling_requested_at FROM sessions`).get() as { ended_at: number | null; ended_by: string | null; titling_requested_at: number | null };
    expect(after.ended_at).toBe(endedAt);
    expect(after.ended_by).toBe('mem_machine_1');
    expect(after.titling_requested_at).not.toBeNull();
  });

  it('answers already_ended only when the lifecycle itself holds an end', async () => {
    const r = await rig(conversation());
    await importFacts(r.serverEnv, r.tokenId);
    const raw = r.sqlite.query(`SELECT ended_at FROM sessions`).get() as { ended_at: number | null };
    expect(raw.ended_at).toBe(IMPORT_AT);

    expect(await endSession(r.serverEnv.db, { projectId: PROJECT }, SESSION, NOW + 5_000, 'mem_machine_1'))
      .toEqual({ outcome: 'already_ended', endedAt: IMPORT_AT });
  });

  it('dates an imported line the transcript left undated to the import, not to the parse', async () => {
    // One turn with no timestamp at all: the only date available is the session's.
    const undated = line({ type: 'user', promptId: uuid(41), message: { content: 'an undated question' } })
      + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'an undated answer' }] } });
    const r = await rig(undated);
    await send(r.serverEnv, r.tokenId, 'session.start', IMPORT_AT, { agent: 'claude-code', startedAt: IMPORT_AT, originPath: '/w/p' }, 'import');
    await drain(r.env, r.sqlite);
    await r.serverEnv.db.batch([resolvePresentedDates(r.serverEnv.db, PROJECT, SESSION)]);

    const prompts = r.sqlite.query(`SELECT created_at FROM prompt_batches WHERE project_id = ?`).all(PROJECT) as { created_at: number }[];
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) expect(prompt.created_at).toBe(IMPORT_AT);
    // The conversation stays where the import put it rather than moving to the parse.
    const presented = (await listSessions(r.serverEnv.db, { projectId: PROJECT })).rows[0]!;
    expect(presented.startedAt).toBe(IMPORT_AT);
    expect(presented.startedAt).not.toBe(NOW);
  });

  it('dates a live undated line to now, which is when it arrived', async () => {
    const undated = line({ type: 'user', promptId: uuid(51), message: { content: 'a live undated question' } });
    const r = await rig(undated);
    // A hook-shipped transcript owes no import date.
    r.sqlite.run(`UPDATE transcripts SET imported_at = NULL WHERE project_id = ?`, [PROJECT]);
    await drain(r.env, r.sqlite);

    const prompts = r.sqlite.query(`SELECT created_at FROM prompt_batches WHERE project_id = ?`).all(PROJECT) as { created_at: number }[];
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) expect(prompt.created_at).toBe(NOW);
  });
});

describe('two import ends at one instant', () => {
  /** An import ships a second `session.end` at the same instant, declaring a different end. */
  const sendEnd = (r: { serverEnv: { db: unknown }; tokenId: string }, eventId: number, endedAt: number) =>
    ingestEvent(r.serverEnv.db as never, ctxFor(r.tokenId),
      envelope({ eventId: uuid(eventId), sessionId: SESSION, kind: 'session.end', createdAt: IMPORT_AT, channel: 'import', payload: { endedAt } }));

  /** The two ends in the given arrival order, with a member's own turn between them. */
  async function settleEnds(order: readonly [number, number]) {
    nextEvent = 100;
    const r = await rig(conversation());
    await send(r.serverEnv, r.tokenId, 'session.start', IMPORT_AT, { agent: 'claude-code', startedAt: IMPORT_AT, originPath: '/w/p' }, 'import');
    await sendEnd(r, order[0], order[0] === 900 ? IMPORT_AT : IMPORT_AT + 40_000);
    // A turn a member shipped, dated between the two declared ends.
    await send(r.serverEnv, r.tokenId, 'prompt', IMPORT_AT + 20_000, { promptId: uuid(950), text: 'between the ends', origin: 'user' }, 'cli');
    await sendEnd(r, order[1], order[1] === 900 ? IMPORT_AT : IMPORT_AT + 40_000);
    await drain(r.env, r.sqlite);
    return state(r.sqlite);
  }

  it('names the same end whichever order they arrive in, so ownership does not turn on delivery', async () => {
    // Same instant, different declared ends: only the event id can order them.
    const [ascending, descending] = [await settleEnds([900, 901]), await settleEnds([901, 900])];
    expect(ascending).toEqual(descending);
  });
});
