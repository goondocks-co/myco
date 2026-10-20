/**
 * claude-v2: every Claude Code record kept, none named by another's key. The first record to claim a `promptId` owns
 * it under the id its hook derives; a later submission reusing the key, another agent's line, a delegated agent's
 * record and a compaction summary are each keyed on their own thread and uuid. Read against the owner-approved real
 * records in `tests/fixtures/claude-siblings/` and the dispositions written for them from the contract
 * (`expected-dispositions.json`), and through the Deployment's own parse, store and restore.
 */
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { parserFor } from '@myco-server-worker/ingest/parsers/registry.js';
import { claudeCodeParser } from '@myco-server-worker/ingest/parsers/claude-code.js';
import { claudeRecordIdFor, promptOwners, type DerivedEvent, type ParsedLine, type ParserInput } from '@myco-server-worker/ingest/parsers/index.js';
import { parseTranscripts, rereadTranscripts } from '@myco-server-worker/ingest/parse.js';
import { sessionTurnContexts } from '@myco-server-worker/read/turns.js';
import { readKpis } from '@myco-server-worker/read/kpis.js';
import { identityRig, type IdentityRig } from './helpers/prompt-identity-rig.js';

const FIXTURES = path.join(import.meta.dir, '..', 'fixtures', 'claude-siblings');
const records = (name: string): Record<string, unknown>[] =>
  fs.readFileSync(path.join(FIXTURES, name), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
const EXPECTED = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'expected-dispositions.json'), 'utf8')) as Record<string, { lines: [number, number]; records: ([string, string, string | null] | null)[] }[]>;
const SESSION = 'sess-claude-v2';
const NOW = Date.parse('2026-06-01T00:00:00.000Z');
/** A prompt open before a window begins, as a pass that stopped there recorded it. */
const OPEN_BEFORE = '00000000-0000-4000-8000-0000000000aa';

/** Lines as a parse reads them: each record at the byte its JSON line starts at. */
function linesOf(values: readonly Record<string, unknown>[]): ParsedLine[] {
  let offset = 0;
  return values.map((value) => {
    const line = { value, offset };
    offset += Buffer.byteLength(`${JSON.stringify(value)}\n`);
    return line;
  });
}

/** A parse as the Deployment runs one: the registered parser, walking the window a line at a time. */
const parse = (values: readonly Record<string, unknown>[], extra: Partial<ParserInput> = {}): Promise<DerivedEvent[]> =>
  parserFor('claude-code')!.parse({ lines: linesOf(values), sessionId: SESSION, scheme: 'claude-v2', now: NOW, ...extra });

const promptAt = (events: readonly DerivedEvent[], offset: number) => events.filter((e) => e.kind === 'prompt' && e.offset === offset);
const repliesTo = (events: readonly DerivedEvent[]) => events.filter((e) => e.kind === 'response').map((e) => e.payload.promptId);

const savedHome = process.env.MYCO_HOME;
afterEach(() => { process.env.MYCO_HOME = savedHome; resetMachineIdCache(); });

describe('claude-v2 dispositions over every fixture record', () => {
  for (const [file, groups] of Object.entries(EXPECTED)) {
    it(`gives every record of ${file} the disposition the contract names, and none an undefined kind, origin or claim`, async () => {
      // The samples are not transcripts: a record's predecessor session (`session_id`) is not this one's to judge.
      const all = records(file).map(({ session_id: _predecessor, ...value }) => value);
      for (const group of groups) {
        const values = all.slice(group.lines[0] - 1, group.lines[1]);
        const lines = linesOf(values);
        const events = await parse(values);
        const got = lines.map(({ value, offset }) => {
          const prompts = promptAt(events, offset);
          expect({ group: group.lines, line: offset, count: prompts.length }).toEqual({ group: group.lines, line: offset, count: prompts.length > 1 ? 1 : prompts.length });
          if (str(value.type) !== 'user' || prompts.length === 0) return null;
          const p = prompts[0]!.payload;
          for (const field of ['promptId', 'promptKind', 'origin', 'claim', 'sourceThread', 'sourceRecord']) expect({ group: group.lines, field, defined: typeof p[field] === 'string' && p[field] !== '' }).toEqual({ group: group.lines, field, defined: true });
          return [p.claim, p.promptKind, p.origin] as const;
        });
        const expected = group.records.map((r) => (r === null ? null : [r[0], r[1], r[2] ?? 'any']));
        expect({ group: group.lines, got: got.map((g, i) => (g === null || expected[i]?.[2] !== 'any' ? g : [g[0], g[1], 'any'])) }).toEqual({ group: group.lines, got: expected });
        // A delegated agent's record never claims a key, and a summary or a meta record there never becomes the current prompt.
        for (const { value, offset } of lines) {
          if (value.isSidechain !== true) continue;
          for (const p of promptAt(events, offset)) expect(p.payload.claim).not.toBe('owner');
        }
      }
    });
  }

  it('attaches no reply to a delegated agent\'s meta record, and gives none of them a prompt row', async () => {
    const window = records('contiguous-reuse.jsonl').slice(306, 387);
    const events = await parse(window, { openPromptId: OPEN_BEFORE });
    const metas = linesOf(window).filter(({ value }) => value.isSidechain === true && value.isMeta === true);
    expect(metas.length).toBeGreaterThan(0);
    for (const { offset } of metas) expect(promptAt(events, offset)).toEqual([]);
  });
});

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

describe('claude-v2 on one key many submissions share (contiguous reuse)', () => {
  for (const [from, to, reused] of [[1, 56, 8], [57, 306, 42]] as const) {
    it(`gives lines ${from}-${to} one owner, ${reused} reused submissions with their own replies, and a summary that is context`, async () => {
      const window = records('contiguous-reuse.jsonl').slice(from - 1, to);
      const lines = linesOf(window);
      for (const open of [undefined, OPEN_BEFORE]) {
        const events = await parse(window, open === undefined ? {} : { openPromptId: open });
        const prompts = events.filter((e) => e.kind === 'prompt');
        expect(prompts.filter((p) => p.payload.claim === 'owner').length).toBe(1);
        expect(prompts.filter((p) => p.payload.claim === 'reused').length).toBe(reused);
        expect(prompts.filter((p) => p.payload.claim === 'context').length).toBe(1);
        expect(new Set(prompts.map((p) => p.payload.promptId)).size).toBe(prompts.length);
        // Every reply belongs to the submission before it; the replies right after the summary stay with the prompt open before it.
        const summary = prompts.find((p) => p.payload.claim === 'context')!;
        const firstOpener = prompts.find((p) => p.payload.claim === 'owner')!;
        for (const reply of events.filter((e) => e.kind === 'response')) {
          const before = prompts.filter((p) => p.payload.claim !== 'context' && p.offset < reply.offset).at(-1);
          expect({ reply: reply.offset, promptId: reply.payload.promptId })
            .toEqual({ reply: reply.offset, promptId: reply.offset < firstOpener.offset ? open : before?.payload.promptId });
        }
        expect(summary.payload.promptKind).toBe('compact_summary');
        expect(lines.length).toBe(to - from + 1);
      }
    });
  }

  it('keeps the prompt open before a summary current when the parser itself walks the window', async () => {
    const window = records('contiguous-reuse.jsonl').slice(0, 12);
    const events = await claudeCodeParser.parse({ lines: linesOf(window), sessionId: SESSION, scheme: 'claude-v2', now: NOW, openPromptId: OPEN_BEFORE });
    const summary = events.find((e) => e.kind === 'prompt' && e.payload.claim === 'context')!;
    expect(events.filter((e) => e.kind === 'response' && e.offset > summary.offset).map((e) => e.payload.promptId)[0]).toBe(OPEN_BEFORE);
  });

  it('decides the same with any prefix stored first: a reread or a resumed window names every record as the first read did', async () => {
    const window = records('contiguous-reuse.jsonl').slice(0, 56);
    const whole = await parse(window);
    const owner = whole.find((e) => e.kind === 'prompt' && e.payload.claim === 'owner')!;
    const key = owner.payload.sourceKey as string;
    // The owner already stored: every record decides as before.
    const seeded = await parse(window, { owners: promptOwners([[key, { thread: 'main', record: owner.payload.sourceRecord as string }]]) });
    expect(seeded.filter((e) => e.kind === 'prompt')).toEqual(whole.filter((e) => e.kind === 'prompt'));
    // A later window alone, its key's owner stored: none of its records takes the key again.
    const later = window.slice(20);
    const resumed = await parse(later, { owners: promptOwners([[key, { thread: 'main', record: owner.payload.sourceRecord as string }]]) });
    expect(resumed.filter((e) => e.kind === 'prompt' && e.payload.claim === 'owner')).toEqual([]);
    // Without the stored owner, the later window's first submission would take it: the seed is what keeps it.
    const unseeded = await parse(later);
    expect(unseeded.filter((e) => e.kind === 'prompt' && e.payload.claim === 'owner').length).toBe(1);
  });
});

const user = (uuid: string, promptId: string | undefined, content: unknown, extra: Record<string, unknown> = {}) =>
  ({ type: 'user', uuid, ...(promptId === undefined ? {} : { promptId }), sessionId: SESSION, timestamp: '2026-05-01T00:00:01.000Z', message: { role: 'user', content }, ...extra });
const reply = (uuid: string, text: string) =>
  ({ type: 'assistant', uuid, sessionId: SESSION, timestamp: '2026-05-01T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const human = { origin: { kind: 'human' }, promptSource: 'typed', turnOrigin: 'human' };

describe('claude-v2 ownership', () => {
  for (const repeated of ['first ask', 'third ask']) {
    it(`keys a key's return after another key on its own record (P, Q, P with ${repeated === 'first ask' ? 'equal' : 'unequal'} text)`, async () => {
      const events = await parse([
        user('u1', 'P', 'first ask', human), reply('a1', 'one'),
        user('u2', 'Q', 'second ask', human), reply('a2', 'two'),
        user('u3', 'P', repeated, human), reply('a3', 'three'),
      ]);
      const prompts = events.filter((e) => e.kind === 'prompt').map((e) => [e.payload.claim, e.payload.promptId]);
      expect(prompts).toEqual([
        ['owner', await claudeRecordIdFor(SESSION, { owner: 'P' })],
        ['owner', await claudeRecordIdFor(SESSION, { owner: 'Q' })],
        ['reused', await claudeRecordIdFor(SESSION, { thread: 'main', uuid: 'u3' })],
      ]);
      expect(repliesTo(events)).toEqual(prompts.map(([, id]) => id));
    });
  }

  it('keeps two delegated threads holding one record uuid as two records, in either order (U:149, U:153)', async () => {
    const all = records('unknown-siblings.jsonl');
    const [a, b] = [all[148]!, all[152]!];
    expect([a.uuid === b.uuid, a.agentId !== b.agentId, a.sessionId === b.sessionId]).toEqual([true, true, true]);
    const ids = async (values: Record<string, unknown>[]) => (await parse(values, { role: 'subagent' }))
      .filter((e) => e.kind === 'prompt').map((e) => [e.payload.promptId, e.payload.sourceThread]);
    const one = await ids([a]);
    const two = await ids([b]);
    expect(one[0]![0]).not.toBe(two[0]![0]);
    expect([...(await ids([a, b])), ...(await ids([b, a]))].map(([id]) => id).sort()).toEqual([one[0]![0], two[0]![0], one[0]![0], two[0]![0]].sort());
    // The same thread read again keeps its id.
    expect(await ids([a])).toEqual(one);
  });

  it('labels a contradiction or an unknown value, and never reads a record without opener fields as a person\'s prompt', async () => {
    const events = await parse([
      user('c1', 'K1', 'contradiction', { origin: { kind: 'human' }, turnOrigin: 'peer' }),
      user('c2', 'K2', 'unknown source', { promptSource: 'telepathy' }),
      user('c3', 'K3', 'unknown kind', { origin: { kind: 'schedule' } }),
      user('c4', 'K4', 'no opener fields at all'),
      user('c5', 'K5', [{ type: 'text', text: '[Request interrupted by user]' }], human),
      user('c6', 'K6', 'scheduled wake', { promptSource: 'system', turnOrigin: 'scheduled', isMeta: true }),
      user('c7', 'K7', 'sdk turn', { turnOrigin: 'sdk' }),
    ]);
    expect(events.filter((e) => e.kind === 'prompt').map((e) => [e.payload.claim, e.payload.promptKind, e.payload.origin])).toEqual([
      ['owner', 'opener_conflict', 'system'],
      ['owner', 'unrecognized', 'system'],
      ['owner', 'unrecognized', 'system'],
      ['owner', 'unmarked', 'user'],
      ['owner', 'user_prompt', 'user'],
      ['owner', 'scheduled', 'system'],
      ['owner', 'sdk', 'user'],
    ]);
  });

  it('counts a turn opener whose field has an unknown shape, and never drops it as marker text', async () => {
    const events = await parse([
      user('m1', 'K1', [{ type: 'text', text: '[Request interrupted by user]' }], { origin: 'human' }),
      user('m2', 'K2', 'an origin with no kind beside a typed source', { origin: {}, promptSource: 'typed' }),
      user('m3', 'K3', 'a source of another type', { promptSource: 7 }),
    ]);
    expect(events.filter((e) => e.kind === 'prompt').map((e) => [e.payload.claim, e.payload.promptKind, e.payload.origin])).toEqual([
      ['owner', 'unrecognized', 'system'], ['owner', 'unrecognized', 'system'], ['owner', 'unrecognized', 'system'],
    ]);
  });

  it('counts every record whose markers disagree with its transcript: the session\'s own carries neither, a delegated agent\'s both', async () => {
    const cases = [
      ['primary', { isSidechain: true }], ['primary', { agentId: 'a1' }], ['primary', { isSidechain: true, agentId: 'a1' }],
      ['subagent', { isSidechain: true }], ['subagent', { agentId: 'a1' }], ['subagent', {}],
    ] as const;
    for (const [role, markers] of cases) {
      const events = await parse([user('c1', 'P', 'a line', { ...markers, parentUuid: null })], role === undefined ? {} : { role });
      expect({ role, markers, got: events.filter((e) => e.kind === 'prompt').map((e) => [e.payload.claim, e.payload.promptKind]) })
        .toEqual({ role, markers, got: [['sibling', 'contract_violation']] });
    }
  });

  it('holds a delegated agent\'s record to its transcript\'s registered role', async () => {
    const sidechainless = user('s1', 'P', 'a subagent line with no sidechain flag', { agentId: 'a1' });
    const flagged = user('s2', 'P', 'a primary line carrying a sidechain', { isSidechain: true, agentId: 'a2' });
    const asSubagent = await parse([sidechainless], { role: 'subagent' });
    const asPrimary = await parse([flagged], { role: 'primary' });
    for (const events of [asSubagent, asPrimary]) {
      expect(events.filter((e) => e.kind === 'prompt').map((e) => [e.payload.claim, e.payload.promptKind])).toEqual([['sibling', 'contract_violation']]);
    }
  });

  it('keeps an invented future shape as a counted sibling, with the person\'s prompt and its replies intact', async () => {
    const events = await parse([
      user('p1', 'P', 'review the window', human), reply('a1', 'looking'),
      user('f1', 'P', '<handoff-note from="x">carry on</handoff-note>'), reply('a2', 'carrying on'),
    ]);
    const prompts = events.filter((e) => e.kind === 'prompt');
    expect(prompts.map((p) => [p.payload.claim, p.payload.promptKind, p.payload.text])).toEqual([
      ['owner', 'user_prompt', 'review the window'],
      ['sibling', 'unrecognized', '<handoff-note from="x">carry on</handoff-note>'],
    ]);
    expect(repliesTo(events)).toEqual([prompts[0]!.payload.promptId, prompts[1]!.payload.promptId]);
  });

  it('keeps a queued command on its own id, current for the reply and tool after it', async () => {
    const events = await parse([
      user('p1', 'P', 'first', human),
      { type: 'attachment', uuid: 'q1', sessionId: SESSION, timestamp: '2026-05-01T00:00:03.000Z', attachment: { type: 'queued_command', prompt: 'also check plans' } },
      { type: 'assistant', uuid: 'a2', sessionId: SESSION, timestamp: '2026-05-01T00:00:04.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'toolu_q', name: 'Read', input: {} }] } },
      user('r1', 'P', [{ type: 'tool_result', tool_use_id: 'toolu_q', content: 'ok' }]),
    ]);
    const queued = events.find((e) => e.kind === 'prompt' && e.payload.promptKind === 'queued_command')!;
    expect(queued.payload).toMatchObject({ promptId: await claudeRecordIdFor(SESSION, { queued: 'q1' }), claim: 'owner', sourceKey: 'q1', sourceRecord: 'q1', sourceThread: 'main' });
    expect(events.filter((e) => e.kind === 'response' || e.kind === 'tool.use').map((e) => e.payload.promptId)).toEqual([queued.payload.promptId, queued.payload.promptId]);
  });

  it('closes a call issued before an unknown sibling on the prompt that issued it, while the sibling takes what follows', async () => {
    const events = await parse([
      user('p1', 'P', 'run it', human),
      { type: 'assistant', uuid: 'a1', sessionId: SESSION, timestamp: '2026-05-01T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] } },
      user('f1', 'P', '<handoff-note>later</handoff-note>'),
      user('r1', 'P', [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }]),
      reply('a2', 'after'),
    ]);
    const [owner, sibling] = events.filter((e) => e.kind === 'prompt').map((e) => e.payload.promptId);
    expect(events.find((e) => e.kind === 'tool.use')!.payload.promptId).toBe(owner);
    expect(events.find((e) => e.kind === 'response')!.payload.promptId).toBe(sibling);
  });
});

describe('claude-v2 through the Deployment', () => {
  async function stored(text: string, opts: { session?: string; transcriptId?: string; role?: 'primary' | 'subagent' } = {}): Promise<IdentityRig> {
    const r = await identityRig({ relevant: 0, background: 0 });
    r.rig.env.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent)
      VALUES ('proj_1', ?, 'machine_1', ?, 1, 1, 'claude-code')`, [opts.session ?? SESSION, r.rig.tokenId]);
    await r.storeTranscript({ transcriptId: opts.transcriptId ?? `tx_${'c'.repeat(32)}`, sessionId: opts.session ?? SESSION, agent: 'claude-code', text, role: opts.role, scheme: 'claude-v2' });
    return r;
  }
  const jsonl = (values: readonly Record<string, unknown>[]) => values.map((v) => `${JSON.stringify({ ...v, sessionId: SESSION })}\n`).join('');
  const semantic = (r: IdentityRig) => ({
    prompts: r.rows(`SELECT prompt_id, claim, prompt_kind, origin, source_key, source_thread, source_record, text FROM prompt_batches ORDER BY prompt_id`),
    responses: r.rows(`SELECT response_id, prompt_id FROM responses ORDER BY response_id`),
    conflicts: r.rows(`SELECT * FROM prompt_identity_conflicts`),
  });
  const WINDOW = records('contiguous-reuse.jsonl').slice(0, 56);

  it('stores the same rows from one read, a read line by line, a read under a small call budget, and a full reread into the populated store', async () => {
    const whole = await stored(jsonl(WINDOW));
    await whole.parse();
    const once = semantic(whole);
    expect((once.prompts as { claim: string }[]).filter((p) => p.claim === 'reused').length).toBe(8);
    expect(once.conflicts).toEqual([]);

    const byLine = await stored(jsonl(WINDOW.slice(0, 1)));
    await byLine.parse();
    for (const value of WINDOW.slice(1)) {
      await byLine.appendTranscript({ transcriptId: `tx_${'c'.repeat(32)}`, text: jsonl([value]) });
      await byLine.parse();
    }
    expect(semantic(byLine)).toEqual(once);

    const budgeted = await stored(jsonl(WINDOW));
    for (let pass = 0; pass < 400; pass += 1) {
      if ((await parseTranscripts(budgeted.rig.env.serverEnv, Date.now(), { budget: { calls: 8, wallMs: 10_000 }, clock: () => 0 })).changed === 0) break;
    }
    await budgeted.parse();
    expect(semantic(budgeted)).toEqual(once);

    expect(await rereadTranscripts(whole.rig.env.serverEnv.db, { agent: 'claude-code' })).toBe(1);
    await whole.parse();
    expect(semantic(whole)).toEqual(once);
  });

  it('keys a second record claiming a stored key on its own record, and refuses a second source for one prompt id, recording it once', async () => {
    const r = await stored(jsonl([user('u1', 'P', 'first', human), user('x1', 'P', 'a line under P')]));
    await r.parse();
    // Another transcript of the session: a record claiming the stored key is reused, and the same record under another key collides.
    await r.storeTranscript({ transcriptId: `tx_${'d'.repeat(32)}`, sessionId: SESSION, agent: 'claude-code',
      text: jsonl([user('u9', 'P', 'first', human), user('u2', 'Q', 'second', human), user('x1', 'Q', 'a line under P')]), scheme: 'claude-v2' });
    // The colliding line carries the same text: it is refused for its source, never merged into the stored row.
    const log = spyOn(console, 'log');
    try {
      await r.parse();
      await r.parse();
      const said = log.mock.calls.map(([first]) => String(first)).filter((line) => line.includes('"projection_conflict"') && line.includes('"prompt"'));
      expect(said.length).toBeGreaterThan(0);
    } finally { log.mockRestore(); }
    expect(r.rows(`SELECT claim, source_key, source_record FROM prompt_batches ORDER BY source_record`)).toEqual([
      { claim: 'owner', source_key: 'P', source_record: 'u1' },
      { claim: 'owner', source_key: 'Q', source_record: 'u2' },
      { claim: 'reused', source_key: 'P', source_record: 'u9' },
      { claim: 'sibling', source_key: 'P', source_record: 'x1' },
    ]);
    expect(r.rows(`SELECT prompt_id, source_key, source_thread, source_record FROM prompt_identity_conflicts`))
      .toEqual([{ prompt_id: await claudeRecordIdFor(SESSION, { thread: 'main', uuid: 'x1' }), source_key: 'Q', source_thread: 'main', source_record: 'x1' }]);
  });

  it('counts on Health what the parse kept without naming it the usual way, per agent, and names no line', async () => {
    const r = await stored(jsonl([...WINDOW, user('k1', 'K', 'no opener fields'), user('k2', 'K', 'contradiction', { origin: { kind: 'human' }, turnOrigin: 'peer' })]));
    await r.parse();
    const report = await readKpis(r.rig.env.serverEnv.db, { windowDays: null, now: Date.now() });
    expect(report.promptIdentity).toEqual([{
      harness: 'claude-code', sampleSize: 12, unrecognized: 0, unmarked: 1, openerConflict: 1, contractViolation: 0, reused: 9,
      identityConflicts: 0, schemeConflicts: 0, mixedSchemeSessions: 0, duplicatePromptSkips: 0,
    }]);
  });

  it('admits one owner when two transcripts of a session claim one key at once, and derives the other as its reuse', async () => {
    const r = await stored(jsonl([user('u1', 'P', 'same words', human), reply('a1', 'one')]));
    await r.storeTranscript({ transcriptId: `tx_${'d'.repeat(32)}`, sessionId: SESSION, agent: 'claude-code', text: jsonl([user('c0', 'P', 'a companion line first', { isMeta: true }), user('u2', 'P', 'same words', human), reply('a2', 'two')]), scheme: 'claude-v2' });
    // Imported transcripts are read side by side: both passes start with no owner of the key stored.
    r.rig.env.sqlite.run(`UPDATE transcripts SET imported_at = ?`, [Date.now()]);
    await r.parse();
    const prompts = r.rows(`SELECT prompt_id, claim, source_record FROM prompt_batches ORDER BY source_record`) as { prompt_id: string; claim: string; source_record: string }[];
    expect(prompts.map((p) => p.claim).sort()).toEqual(['owner', 'reused']);
    const owner = prompts.find((p) => p.claim === 'owner')!;
    const reused = prompts.find((p) => p.claim === 'reused')!;
    expect(owner.prompt_id).toBe(await claudeRecordIdFor(SESSION, { owner: 'P' }));
    expect(r.rows(`SELECT source_key, source_record FROM prompt_key_owners`)).toEqual([{ source_key: 'P', source_record: owner.source_record }]);
    expect(r.rows(`SELECT COUNT(*) AS n FROM prompt_identity_conflicts`)).toEqual([{ n: 0 }]);
    const replies = r.rows(`SELECT prompt_id, text FROM responses ORDER BY text`) as { prompt_id: string; text: string }[];
    expect(replies).toEqual([
      { prompt_id: owner.source_record === 'u1' ? owner.prompt_id : reused.prompt_id, text: 'one' },
      { prompt_id: owner.source_record === 'u2' ? owner.prompt_id : reused.prompt_id, text: 'two' },
    ]);
    expect(r.rows(`SELECT parsed_offset = size AS caught_up, parse_error FROM transcripts`)).toEqual([{ caught_up: 1, parse_error: null }, { caught_up: 1, parse_error: null }]);
  });

  it('counts a session whose transcripts already hold two schemes, from the pins alone', async () => {
    const r = await stored(jsonl([user('u1', 'P', 'first', human)]));
    for (const [id, pin] of [[`tx_${'1'.repeat(32)}`, 'offset-v1'], [`tx_${'2'.repeat(32)}`, 'codex-turn-v1']] as const) {
      r.rig.env.sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, segment_count, first_received_at, last_received_at, token_id, role, prompt_identity_scheme)
        VALUES ('proj_1', ?, 'sess-codex', 'machine_1', 'codex', 0, 0, ?, ?, ?, 'primary', ?)`, [id, Date.now(), Date.now(), r.rig.tokenId, pin]);
    }
    const report = await readKpis(r.rig.env.serverEnv.db, { windowDays: null, now: Date.now() });
    expect(report.promptIdentity.find((row) => row.harness === 'codex')).toMatchObject({ mixedSchemeSessions: 1, schemeConflicts: 0 });
  });

  it('credits no subagent receipt to a delegated thread whose id only matches a string', async () => {
    const r = await stored(jsonl([{ ...user('d1', 'P', 'dispatch', { isSidechain: true, agentId: 'agent-x', parentUuid: null }) }]), { role: 'subagent' });
    await r.parse();
    expect(r.rows(`SELECT source_thread, thread_id FROM prompt_batches`)).toEqual([{ source_thread: 'agent-x', thread_id: null }]);
    r.rig.env.sqlite.run(`INSERT INTO session_injections (project_id, session_id, kind, created_at) VALUES ('proj_1', ?, 'cortex:agent-x', 1)`, [SESSION]);
    expect(await sessionTurnContexts(r.rig.env.serverEnv.db, { projectId: 'proj_1' } as never, SESSION)).toEqual({});
  });
});
