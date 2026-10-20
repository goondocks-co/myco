/**
 * Each transcript's prompt identity scheme is pinned once and read by everything that names its prompts.
 * - The segment that registers a transcript pins the scheme its agent declares; nothing else writes it, and a trigger
 *   refuses to change a set scheme while the segment and parse writes to the same row go on landing.
 * - A transcript read before the pin keeps the derivation that read it through a reread, so a reread after a
 *   declaration changed adds no row and conflicts with none.
 * - The migration and a restore of an older backup pin rows that arrive without a scheme by one function.
 * - An ask, or a delivery, naming a prompt under a scheme the session's transcript is not pinned to names none.
 * - A receipt whose prompt row recorded another text is counted, never linked.
 */
import { describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { parseTranscripts, rereadTranscripts, TRANSCRIPT_IDLE_MS } from '@myco-server-worker/ingest/parse.js';
import { promptIdAtOffset } from '@myco-server-worker/ingest/parsers/index.js';
import { DECLARED_SCHEMES } from '@myco-server-worker/ingest/prompt-scheme.js';
import { promptKeyMismatches } from '@myco-server-worker/read/prompt-reference-invariant.js';
import { BACKUP_FORMAT, deploymentId, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { sha256Hex, sha256HexOf, utf8 } from '@myco-server-worker/hash.js';
import { applySchemaSteps } from './helpers/migrate.js';
import { registerBlob, sqliteD1 } from './helpers/d1.js';
import { envelope, memberHeaders, sqliteEnv, uuid } from './helpers/fixtures.js';

const NOW = Date.now();
const SESSION = 'sess-scheme';
const rows = (sqlite: Database, sql: string, ...params: unknown[]) => sqlite.query(sql).all(...(params as never[])) as Record<string, unknown>[];

async function member() {
  const e = sqliteEnv();
  const issued = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, NOW);
  e.sqlite.run(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'proj_1', ?)`, [NOW]);
  e.sqlite.run(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'cortex', 1, 0, 'test')`);
  const ctx = { projectId: 'proj_1', machineId: 'machine_1', tokenId: issued.tokenId, bodyBytes: 10, now: NOW };
  /** Ship `text` as the transcript's next segment through the segment projection, as a member's shipment lands. */
  const ship = async (n: number, transcriptId: string, text: string, agent?: string) => {
    const bytes = utf8(text);
    const key = await sha256HexOf(bytes);
    const objectKey = registerBlob(e.sqlite, { projectId: 'proj_1', key, size: bytes.length, tokenId: issued.tokenId, receivedAt: NOW });
    await e.bucket.put(objectKey, new Blob([bytes]).stream());
    const held = e.sqlite.query(`SELECT size FROM transcripts WHERE transcript_id = ?`).get(transcriptId) as { size: number } | null;
    return ingestEvent(e.db, ctx, envelope({ eventId: uuid(500 + n), sessionId: SESSION, kind: 'transcript.segment', createdAt: NOW,
      payload: { transcriptId, baseOffset: held?.size ?? 0, length: bytes.length, blob: key, ...(agent === undefined ? {} : { agent }) } }));
  };
  /** Hold `text` as a transcript pinned to `scheme`, as the migration leaves one it already held. */
  const hold = async (transcriptId: string, text: string, agent: string, scheme: string) => {
    const bytes = utf8(text);
    const key = await sha256HexOf(bytes);
    const objectKey = registerBlob(e.sqlite, { projectId: 'proj_1', key, size: bytes.length, tokenId: issued.tokenId, receivedAt: NOW });
    await e.bucket.put(objectKey, new Blob([bytes]).stream());
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1', ?, 'machine_1', ?, ?, ?)`, [SESSION, issued.tokenId, NOW, NOW]);
    e.sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, segment_count, first_received_at, last_received_at, token_id, prompt_identity_scheme)
      VALUES ('proj_1', ?, ?, 'machine_1', ?, ?, 1, ?, ?, ?, ?)`, [transcriptId, SESSION, agent, bytes.length, NOW, NOW, issued.tokenId, scheme]);
    e.sqlite.run(`INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
      VALUES ('proj_1', ?, 0, ?, ?, ?, ?, ?, ?)`, [transcriptId, bytes.length, key, `seg-${transcriptId}`, NOW, NOW, issued.tokenId]);
  };
  const parse = async () => {
    for (const at of [NOW, NOW + TRANSCRIPT_IDLE_MS + 1]) for (let pass = 0; pass < 20; pass += 1) if ((await parseTranscripts(e.serverEnv, at)).changed === 0) break;
  };
  return { e, token: issued.token, ctx, ship, hold, parse };
}

const line = (o: Record<string, unknown>): string => `${JSON.stringify(o)}\n`;
const at = (s: number) => new Date(NOW - 60_000 + s * 1000).toISOString();
const codexUser = (s: number, text: string, order?: number) => line({ timestamp: at(s), type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }, ...(order === undefined ? {} : { metadata: { user_input_order: order } }) });
const codexReply = (s: number, text: string) => line({ timestamp: at(s), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] } });
const TX = `tx_${'a'.repeat(32)}`;

/**
 * Each witness that a parse has read a transcript, alone, and none: a Codex transcript read before the pin keeps the
 * line positions that read it whichever witness it carries, and an unread one takes Codex's turn key.
 */
const READ_WITNESSES = [
  ['codex-offset-only', { offset: 100 }],
  ['codex-parsed-at-only', { at: 1 }],
  ['codex-unread', {}],
  ['codex-version-only', { version: 5 }],
] as const satisfies ReadonlyArray<readonly [string, { version?: number; offset?: number; at?: number }]>;
const PINNED_BY_WITNESS = [
  { transcript_id: 'codex-offset-only', prompt_identity_scheme: 'offset-v1' },
  { transcript_id: 'codex-parsed-at-only', prompt_identity_scheme: 'offset-v1' },
  { transcript_id: 'codex-unread', prompt_identity_scheme: 'codex-turn-v1' },
  { transcript_id: 'codex-version-only', prompt_identity_scheme: 'offset-v1' },
];

describe('a transcript\'s prompt identity scheme', () => {
  it('is pinned to its agent\'s declaration by the segment that registers it, and is none for a transcript that names no agent', async () => {
    const m = await member();
    expect(await m.ship(1, TX, codexUser(1, 'hello'), 'codex')).toMatchObject({ persisted: true });
    expect(await m.ship(2, `tx_${'b'.repeat(32)}`, line({ type: 'note' }))).toMatchObject({ persisted: true });
    expect(rows(m.e.sqlite, `SELECT agent, prompt_identity_scheme FROM transcripts ORDER BY transcript_id`)).toEqual([
      { agent: 'codex', prompt_identity_scheme: DECLARED_SCHEMES.codex },
      { agent: null, prompt_identity_scheme: null },
    ]);
  });

  it('never changes, while the segment and parse writes to the same row still land', async () => {
    const m = await member();
    await m.ship(1, TX, line({ timestamp: at(0), type: 'session_meta', payload: { source: 'cli' } }) + codexUser(1, 'first', 0), 'codex');
    await m.parse();
    await m.ship(2, TX, codexReply(2, 'a reply'), 'codex');
    await m.parse();
    expect(rows(m.e.sqlite, `SELECT prompt_identity_scheme, parsed_offset = size AS caught_up, segment_count FROM transcripts`))
      .toEqual([{ prompt_identity_scheme: 'codex-turn-v1', caught_up: 1, segment_count: 2 }]);
    expect(() => m.e.sqlite.run(`UPDATE transcripts SET prompt_identity_scheme = 'offset-v1'`)).toThrow(/prompt identity scheme never changes/);
    m.e.sqlite.run(`UPDATE transcripts SET prompt_identity_scheme = 'codex-turn-v1', parse_error = NULL`);
    expect(rows(m.e.sqlite, `SELECT prompt_identity_scheme FROM transcripts`)).toEqual([{ prompt_identity_scheme: 'codex-turn-v1' }]);
  });

  it('keeps a transcript read before the pin on the derivation that read it through a reread, adding no row and conflicting with none', async () => {
    const m = await member();
    const text = line({ timestamp: at(0), type: 'session_meta', payload: { source: 'cli' } })
      + line({ timestamp: at(1), type: 'turn_context', payload: { turn_id: 'turn-1' } })
      + codexUser(1, 'how long is the window', 0) + codexReply(2, 'thirty days') + codexUser(3, 'and plans', 2) + codexReply(4, 'kept');
    // Pinned as the migration pins a Codex transcript read under line positions, while Codex now declares its turn key.
    expect(DECLARED_SCHEMES.codex).toBe('codex-turn-v1');
    await m.hold(TX, text, 'codex', 'offset-v1');
    await m.parse();
    const before = rows(m.e.sqlite, `SELECT prompt_id, text FROM prompt_batches ORDER BY created_at`);
    const offsets = text.split('\n').slice(0, -1).reduce<number[]>((acc, l, i, all) => [...acc, i === 0 ? 0 : acc[i - 1]! + utf8(all[i - 1]!).length + 1], []);
    expect(before).toEqual([
      { prompt_id: await promptIdAtOffset('codex-prompt', SESSION, offsets[2]!), text: 'how long is the window' },
      { prompt_id: await promptIdAtOffset('codex-prompt', SESSION, offsets[4]!), text: 'and plans' },
    ]);
    const log = spyOn(console, 'log');
    try {
      expect(await rereadTranscripts(m.e.db, { agent: 'codex' })).toBe(1);
      await m.parse();
      const said = log.mock.calls.map(([first]) => String(first));
      expect(said.filter((s) => s.includes('transcript_row_conflict'))).toEqual([]);
    } finally { log.mockRestore(); }
    expect(rows(m.e.sqlite, `SELECT prompt_id, text FROM prompt_batches ORDER BY created_at`)).toEqual(before);
    expect(rows(m.e.sqlite, `SELECT prompt_identity_scheme, parsed_offset = size AS caught_up FROM transcripts`)).toEqual([{ prompt_identity_scheme: 'offset-v1', caught_up: 1 }]);
  });

  it('pins a transcript restored from a backup taken before the pin as the migration pins one it holds', async () => {
    const m = await member();
    const transcript = ([id, read]: readonly [string, { version?: number; offset?: number; at?: number }]) => ({
      project_id: 'proj_1', transcript_id: id, session_id: SESSION, machine_id: 'machine_1', agent: 'codex', size: 100, segment_count: 0,
      first_received_at: 1, last_received_at: 1, token_id: m.ctx.tokenId, parsed_offset: read.offset ?? 0, parser_version: read.version ?? 0,
      parsed_at: read.at ?? null, role: 'primary',
    });
    const artifact = [
      { format: BACKUP_FORMAT, deploymentId: await deploymentId(m.e.db), schemaVersion: 89, createdAt: 1, producer: 'scheme test', counts: { transcripts: READ_WITNESSES.length } },
      ...READ_WITNESSES.map((witness) => ({ t: 'transcripts', r: transcript(witness) })),
    ].map((o) => JSON.stringify(o)).join('\n');
    await restoreArtifact(m.e.db, { authorization: { kind: 'recovery' }, text: artifact });
    expect(rows(m.e.sqlite, `SELECT transcript_id, prompt_identity_scheme FROM transcripts ORDER BY transcript_id`)).toEqual(PINNED_BY_WITNESS);
  });

  it('is pinned for every transcript held at the migration: one already read to the scheme that read it, any other to its declaration', async () => {
    const sqlite = new Database(':memory:');
    const db = sqliteD1(sqlite);
    const at89 = SCHEMA_STEPS.findIndex((step) => step.version === 90);
    for (const step of SCHEMA_STEPS.slice(0, at89)) for (const statement of step.statements) sqlite.exec(statement);
    const held = (id: string, agent: string | null, read: { version?: number; offset?: number; at?: number } = {}) => sqlite.run(`INSERT INTO transcripts
      (project_id, transcript_id, session_id, machine_id, agent, size, parsed_offset, parser_version, parsed_at, first_received_at, last_received_at, token_id)
      VALUES ('proj_1', ?, 's', 'm', ?, 100, ?, ?, ?, 1, 1, 't')`, [id, agent, read.offset ?? 0, read.version ?? 0, read.at ?? null]);
    sqlite.run(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_1', 'proj_1', 1)`);
    for (const [id, read] of READ_WITNESSES) held(id, 'codex', read);
    held('claude', 'claude-code', { version: 5, offset: 100, at: 1 });
    held('pi', 'pi');
    held('unknown', 'some-future-agent');
    held('agentless', null);
    expect(await applySchemaSteps(db)).toEqual([90]);
    expect(rows(sqlite, `SELECT transcript_id, prompt_identity_scheme FROM transcripts WHERE agent = 'codex' ORDER BY transcript_id`)).toEqual(PINNED_BY_WITNESS);
    expect(rows(sqlite, `SELECT transcript_id, prompt_identity_scheme FROM transcripts WHERE agent IS NOT 'codex' ORDER BY transcript_id`)).toEqual([
      { transcript_id: 'agentless', prompt_identity_scheme: null },
      { transcript_id: 'claude', prompt_identity_scheme: 'claude-v1' },
      { transcript_id: 'pi', prompt_identity_scheme: 'offset-v1' },
      { transcript_id: 'unknown', prompt_identity_scheme: null },
    ]);
  });
});

describe('an ask or a delivery naming a prompt under a scheme', () => {
  const ask = (token: string, body: unknown) => new Request('https://s/context/prompt', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify(body) });

  async function pinned(scheme: string) {
    const m = await member();
    m.e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent) VALUES ('proj_1', ?, 'machine_1', ?, 1, 1, 'codex')`, [SESSION, m.ctx.tokenId]);
    m.e.sqlite.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, first_received_at, last_received_at, token_id, role, prompt_identity_scheme)
      VALUES ('proj_1', ?, ?, 'machine_1', 'codex', 0, 1, 1, ?, 'primary', ?)`, [TX, SESSION, m.ctx.tokenId, scheme]);
    return m;
  }

  it('records an ask under a scheme the session\'s transcript is not pinned to as scheme-scoped, and one under its scheme by its id', async () => {
    for (const [scheme, expected] of [['offset-v1', { prompt_id: null, scope_reason: 'scheme' }], ['codex-turn-v1', { prompt_id: uuid(1), scope_reason: null }]] as const) {
      const m = await pinned(scheme);
      const answer = await (await worker.fetch(ask(m.token, { sessionId: SESSION, promptId: uuid(1), promptScheme: 'codex-turn-v1', identity: 1, at: NOW - 5, text: 'what window' }), m.e.env)).json();
      expect(answer).toMatchObject({ persisted: true });
      expect(rows(m.e.sqlite, `SELECT prompt_id, scope_reason, ask_protocol FROM prompt_context_answers`)).toEqual([{ ...expected, ask_protocol: 'v1' }]);
    }
  });

  it('takes the declaration of the session\'s agent before its transcript is registered, and refuses a scheme it does not know', async () => {
    const m = await member();
    m.e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent) VALUES ('proj_1', ?, 'machine_1', ?, 1, 1, 'codex')`, [SESSION, m.ctx.tokenId]);
    await worker.fetch(ask(m.token, { sessionId: SESSION, promptId: uuid(1), promptScheme: 'offset-v1', identity: 1, at: NOW - 5, text: 'what window' }), m.e.env);
    await worker.fetch(ask(m.token, { sessionId: SESSION, promptId: uuid(2), promptScheme: 'codex-turn-v1', identity: 1, at: NOW - 4, text: 'what window now' }), m.e.env);
    expect(rows(m.e.sqlite, `SELECT prompt_id, scope_reason FROM prompt_context_answers ORDER BY created_at, rowid`)).toEqual([
      { prompt_id: null, scope_reason: 'scheme' }, { prompt_id: uuid(2), scope_reason: null },
    ]);
    for (const body of [
      { sessionId: SESSION, promptId: uuid(3), promptScheme: 'codex-turn-v9', identity: 1, at: NOW, text: 'x' },
      { sessionId: SESSION, scopeReason: 'steering', promptScheme: 'codex-turn-v1', identity: 1, at: NOW, text: 'x' },
    ]) {
      expect({ body, code: ((await (await worker.fetch(ask(m.token, body), m.e.env)).json()) as { code?: string }).code }).toEqual({ body, code: 'parse' });
    }
  });

  it('records an ask and a delivery as scheme-scoped once the session\'s primary is registered unpinned, whatever its agent declares', async () => {
    for (const agent of [undefined, 'some-future-agent']) {
      const m = await member();
      m.e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent) VALUES ('proj_1', ?, 'machine_1', ?, 1, 1, 'codex')`, [SESSION, m.ctx.tokenId]);
      // The registering segment names no agent this Deployment declares: the primary is held, pinned to no scheme.
      expect(await m.ship(1, TX, line({ type: 'note' }), agent)).toMatchObject({ persisted: true });
      expect(rows(m.e.sqlite, `SELECT role, prompt_identity_scheme FROM transcripts`)).toEqual([{ role: 'primary', prompt_identity_scheme: null }]);
      const answer = await (await worker.fetch(ask(m.token, { sessionId: SESSION, promptId: uuid(1), promptScheme: 'codex-turn-v1', identity: 1, at: NOW - 5, text: 'what window' }), m.e.env)).json();
      expect({ agent, answer }).toMatchObject({ agent, answer: { persisted: true } });
      expect({ agent, rows: rows(m.e.sqlite, `SELECT prompt_id, scope_reason FROM prompt_context_answers`) }).toEqual({ agent, rows: [{ prompt_id: null, scope_reason: 'scheme' }] });
      m.e.sqlite.run(`INSERT INTO spore_injections (project_id, session_id, id, scope_reason, ask_protocol, asked_at, prompt_hash, spore_ids, created_at) VALUES ('proj_1', ?, ?, 'scheme', 'v1', 1, 'h', '[]', 1)`, [SESSION, uuid(10)]);
      expect(await ingestEvent(m.e.db, m.ctx, envelope({ eventId: uuid(100), sessionId: SESSION, kind: 'context.delivered', createdAt: NOW - 10,
        payload: { receiptId: uuid(10), renderedIn: uuid(2), renderedScheme: 'codex-turn-v1' } }))).toMatchObject({ persisted: true });
      expect({ agent, delivery: rows(m.e.sqlite, `SELECT delivered_prompt_id, delivered_scope_reason FROM spore_injections`) })
        .toEqual({ agent, delivery: [{ delivered_prompt_id: null, delivered_scope_reason: 'scheme' }] });
    }
  });

  it('records a delivery to a prompt under a scheme the session\'s transcript is not pinned to as scheme-scoped', async () => {
    const m = await pinned('offset-v1');
    m.e.sqlite.run(`INSERT INTO spore_injections (project_id, session_id, id, scope_reason, ask_protocol, asked_at, prompt_hash, spore_ids, created_at) VALUES ('proj_1', ?, ?, 'scheme', 'v1', 1, 'h', '[]', 1)`, [SESSION, uuid(10)]);
    const delivered = await ingestEvent(m.e.db, m.ctx, envelope({ eventId: uuid(100), sessionId: SESSION, kind: 'context.delivered', createdAt: NOW - 10,
      payload: { receiptId: uuid(10), renderedIn: uuid(2), renderedScheme: 'codex-turn-v1' } }));
    expect(delivered).toMatchObject({ persisted: true });
    expect(rows(m.e.sqlite, `SELECT delivered_at, delivered_prompt_id, delivered_scope_reason FROM spore_injections`))
      .toEqual([{ delivered_at: NOW - 10, delivered_prompt_id: null, delivered_scope_reason: 'scheme' }]);
  });
});

describe('the prompt key mismatch signal', () => {
  it('counts, per agent, a receipt whose prompt row recorded another text, and none whose texts agree', async () => {
    const m = await member();
    m.e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent) VALUES ('proj_1', ?, 'machine_1', ?, 1, 1, 'codex')`, [SESSION, m.ctx.tokenId]);
    const prompt = async (id: string, text: string) => m.e.sqlite.run(`INSERT INTO prompt_batches (project_id, prompt_id, session_id, event_id, origin, text, content_hash, prompt_key_hash, created_at, updated_at, token_id, received_at)
      VALUES ('proj_1', ?, ?, ?, 'user', ?, 'c', ?, 1, 1, 't', 1)`, [id, SESSION, `ev-${id}`, text, await sha256Hex(text)]);
    const receipt = async (n: number, id: string, asked: string) => m.e.sqlite.run(`INSERT INTO spore_injections (project_id, session_id, id, prompt_id, ask_protocol, asked_at, prompt_hash, spore_ids, created_at)
      VALUES ('proj_1', ?, ?, ?, 'v1', 1, ?, '[]', ?)`, [SESSION, uuid(n), id, await sha256Hex(asked), NOW]);
    await prompt(uuid(1), 'the opener the transcript holds');
    await prompt(uuid(2), 'a second opener');
    await receipt(11, uuid(1), 'a steering prompt that claimed the opener');
    await receipt(12, uuid(2), 'a second opener');
    expect(await promptKeyMismatches(m.e.db, 0)).toEqual({ codex: 1 });
  });
});
