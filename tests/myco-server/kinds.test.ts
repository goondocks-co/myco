import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { describe, it, expect } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { KINDS, kindSpec, parsePayload, blobFields, promptReferenceFields, orderingFields, idFields, PROMPT_ORIGINS, PLAN_STATUSES, MAX_ARRAY_ITEMS, MAX_TIME_MS, PROMPT_REFERENCE_COLUMNS, type Bound } from '@myco-server-worker/ingest/kinds.js';
import { basenameOf, planKind, RAW_ROW_GATE, type WriteContext } from '@myco-server-worker/ingest/projections.js';
import { MAX_PAYLOAD_BYTES, PAYLOAD_CAP_REASON } from '@myco-server-worker/ingest/envelope.js';
import { MAX_BODY_BYTES } from '@myco-server-worker/ingest/body.js';
import { MAX_BLOB_BYTES, MAX_CLOCK_SKEW_MS, MEMBER_TOKEN_BYTE_QUOTA } from '@myco-server-worker/constants.js';
import { sha256Hex, sha256HexOf, utf8 } from '@myco-server-worker/hash.js';
import { blobPost, bytesWritten, count, envelope, memberHeaders, memberPost, sqliteEnv, PRODUCER, TEXT_MEDIA_TYPE, uuid } from './helpers/fixtures.js';

const json = async (res: Response) => res.json() as Promise<Record<string, unknown>>;
/** A server clock every fixture's caller times sit behind. */
const FIXTURE_NOW = 1_000_000;

/** A bound is finite when it states a ceiling of its own, never the language's. Every bound shape is classified here by name; a shape this function does not know is not finite, so the catalogue gate refuses any column-mapped field that carries one. */
function finite(bound: Bound): boolean {
  switch (bound.type) {
    case 'string': return bound.max > 0 && bound.max <= MAX_PAYLOAD_BYTES;
    case 'int': return bound.min >= 0 && bound.max > bound.min && bound.max < Number.MAX_SAFE_INTEGER;
    case 'stringArray': return bound.maxItems > 0 && bound.maxItems <= MAX_ARRAY_ITEMS && bound.maxItem > 0 && bound.maxItem <= MAX_PAYLOAD_BYTES;
    case 'json': return bound.maxBytes > 0 && bound.maxBytes <= MAX_PAYLOAD_BYTES;
    // Grammar-shaped bounds are finite by their shape; an enum is finite when it names at least one value.
    case 'id': case 'transcriptId': case 'sessionId': case 'blobKey': case 'bool': return true;
    case 'enum': return bound.values.length > 0;
    // A time is bounded by the server clock at validation, not by a constant in the catalogue.
    case 'time': return true;
  }
  void (bound satisfies never);
  return false;
}

/** A fixture per kind: the payload and the typed table row it must produce. */
const FIXTURES: Record<string, { payload: Record<string, unknown>; table: string | null }> = {
  'session.start': { payload: { agent: 'claude-code', branch: 'main', startedAt: 900, originPath: '/t.jsonl', parentSessionId: 'sess_0', parentReason: 'fork' }, table: 'sessions' },
  'session.end': { payload: { endedAt: 5_000 }, table: 'sessions' },
  prompt: { payload: { promptId: uuid(2), text: 'hi', origin: 'user', promptKind: 'user', threadId: uuid(30), threadLabel: 'main' }, table: 'prompt_batches' },
  'tool.use': { payload: { toolCallId: uuid(3), promptId: uuid(2), toolName: 'Read', input: { path: '/x' }, output: 'ok', durationMs: 5, filesAffected: ['/x'], success: true, mycoTool: 'myco_search', mycoOp: 'get', canopyInjectionTokens: 12 }, table: 'tool_calls' },
  'tool.failure': { payload: { toolCallId: uuid(4), toolName: 'Bash', input: { cmd: 'x' }, success: false, errorMessage: 'boom' }, table: 'tool_calls' },
  response: { payload: { responseId: uuid(5), promptId: uuid(2), text: 'done' }, table: 'responses' },
  plan: { payload: { planKey: uuid(6), title: 'P', content: '# plan', status: 'active', tags: ['a', 'b'] }, table: 'plans' },
  attachment: { payload: { attachmentId: uuid(7), promptId: uuid(2), blob: '', description: 'shot' }, table: 'attachments' },
  'transcript.segment': { payload: { transcriptId: `tx_${'0'.repeat(32)}`, baseOffset: 0, length: 0, blob: '', agent: 'claude-code' }, table: 'transcript_segments' },
  'compaction.pre': { payload: { trigger: 'auto', summary: 's' }, table: null },
  'compaction.post': { payload: { trigger: 'auto', summary: 's' }, table: null },
  'subagent.start': { payload: { subagentId: uuid(8), agentType: 'Explore', parentPromptId: uuid(2) }, table: null },
  'subagent.stop': { payload: { subagentId: uuid(8) }, table: null },
  'stop.failure': { payload: { message: 'x', data: { code: 1 } }, table: null },
  'task.completed': { payload: { message: 'done', data: { id: 't1' } }, table: null },
  notification: { payload: { message: 'hey', level: 'info' }, table: null },
  error: { payload: { message: 'bad', data: { stack: 's' } }, table: null },
};

async function member(env: ReturnType<typeof sqliteEnv>, project = 'proj_1', machine = 'machine_1') {
  return issueMemberToken(env.db, { memberId: `mem_${machine}`, machineId: machine }, Date.now());
}

/** Uploads bytes as a blob for the token and returns the key. */
async function upload(env: ReturnType<typeof sqliteEnv>, token: string, bytes: Uint8Array, mediaType = TEXT_MEDIA_TYPE): Promise<string> {
  const key = await sha256HexOf(bytes);
  const res = await worker.fetch(blobPost(token, key, bytes, mediaType), env.env);
  expect((await json(res)).stored).toBe(true);
  return key;
}

/** Exact projection-statement totals, pinned per payload shape: a projection that vanishes fails the gate. */
const FULL_PROJECTION_STATEMENTS = 14;
const REQUIRED_ONLY_PROJECTION_STATEMENTS = 12;
/** Every field carrying the prompt-reference marker across the catalogue. */
const PROMPT_REFERENCE_MARKERS = 9;
/** Every blob-key field of the catalogue as `kind.field`, pinned by name; the absent-key admission gate drives each one. */
const BLOB_KEY_FIELDS = [
  'attachment.blob', 'compaction.post.blob', 'compaction.pre.blob', 'plan.blob', 'prompt.blob',
  'response.blob', 'tool.failure.blob', 'tool.failure.outputBlob', 'tool.use.blob', 'tool.use.outputBlob',
  'transcript.segment.blob',
];
/** Cost-gate pins: the exact count of distinct statements it drives, and a floor on the index steps it inspects on project-scoped tables. */
const PLANNED_STATEMENTS = 46;
const MIN_INDEX_STEPS = 60;
/** Every id-bounded field across the catalogue, by the role it declares. */
const ID_ROLES = { key: 7, prompt: 9, group: 1 };
/** Every field carrying the time bound across the catalogue: `session.start.startedAt` and `session.end.endedAt`. */
const ORDERING_FIELDS = 2;
/** The projection families whose identity row carries `machine_id` are owned by that row; every other keyed table routes ownership through its session. Pinned from the catalogue's projection family, independent of the plan's own `owner`, so a flipped owner is caught by name. */
const ROW_OWNED_PROJECTIONS = new Set(['plans', 'transcript_segments']);

describe('kind catalogue', () => {
  it('has a fixture, a schema, a finite ceiling on every column-mapped field, a marker on every prompt reference, and a projection for every kind', () => {
    expect(Object.keys(FIXTURES).sort()).toEqual(KINDS.map((k) => k.name).sort());
    let marked = 0;
    let ordering = 0;
    const roles: Record<string, number> = {};
    for (const spec of KINDS) {
      for (const [field, f] of Object.entries(spec.fields)) {
        if (f.column) expect({ kind: spec.name, field, bounded: finite(f.bound) }).toEqual({ kind: spec.name, field, bounded: true });
        // Every id declares what it names, and the reference marker is derived from that declaration alone. A field
        // naming a prompt cannot enter the catalogue unlabelled: `id` takes the role as its first argument, so the
        // omission is a type error rather than a gate the field's name and column decide.
        expect({ kind: spec.name, field, roled: f.bound.type !== 'id' || f.role !== undefined }).toEqual({ kind: spec.name, field, roled: true });
        expect({ kind: spec.name, field, derived: (f.references === 'prompt') === (f.role === 'prompt') }).toEqual({ kind: spec.name, field, derived: true });
        expect({ kind: spec.name, field, onlyIds: f.role === undefined || f.bound.type === 'id' }).toEqual({ kind: spec.name, field, onlyIds: true });
        if (f.role !== undefined) roles[f.role] = (roles[f.role] ?? 0) + 1;
        // The name and the typed column stay a second, independent implication: a field that reads as a prompt
        // reference must also declare the prompt role, so a mislabelled one under a known name still fails.
        const suspected = /prompt_?id$/i.test(field) || (f.column !== undefined && (PROMPT_REFERENCE_COLUMNS as readonly string[]).includes(f.column));
        if (suspected) expect({ kind: spec.name, field, marked: f.references === 'prompt' }).toEqual({ kind: spec.name, field, marked: true });
        if (f.references === 'prompt') marked += 1;
        // A field that reads as a caller-supplied instant — by name, or by the typed column it lands in — must carry
        // the time bound, so a new timestamp cannot enter the catalogue as a plain int and escape the clock rule.
        const instant = /At$/.test(field) || (f.column !== undefined && /_at$/.test(f.column));
        if (instant) expect({ kind: spec.name, field, timed: f.bound.type === 'time' }).toEqual({ kind: spec.name, field, timed: true });
      }
      ordering += orderingFields(spec).length;
      const p = parsePayload(spec, FIXTURES[spec.name].payload, FIXTURE_NOW);
      if (spec.name !== 'attachment' && spec.name !== 'transcript.segment') expect({ kind: spec.name, ok: p.ok }).toEqual({ kind: spec.name, ok: true });
    }
    expect(marked).toBe(PROMPT_REFERENCE_MARKERS);
    expect(roles).toEqual(ID_ROLES);
    expect(idFields(kindSpec('prompt')!).sort()).toEqual([['parentPromptId', 'prompt'], ['promptId', 'prompt'], ['threadId', 'group']].sort());
    expect(ordering).toBe(ORDERING_FIELDS);
    expect(orderingFields(kindSpec('session.start')!)).toEqual(['startedAt']);
    expect(orderingFields(kindSpec('session.end')!)).toEqual(['endedAt']);
    expect(kindSpec('made.up')).toBeNull();
    expect(PROMPT_ORIGINS).toContain('hook_injected');
    expect(PLAN_STATUSES).toContain('abandoned');
  });

  it('round-trips every kind through the deployed entry into its typed table', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const bytes = utf8('screenshot-bytes');
    const key = await upload(e, t.token, bytes, 'image/png');
    const segBytes = utf8('{"line":1}\n');
    const segKey = await upload(e, t.token, segBytes);
    let n = 100;
    for (const spec of KINDS) {
      const fixture = FIXTURES[spec.name];
      const payload = { ...fixture.payload };
      if (spec.name === 'attachment') payload.blob = key;
      if (spec.name === 'transcript.segment') { payload.blob = segKey; payload.length = segBytes.byteLength; }
      const res = await worker.fetch(memberPost(t.token, envelope({ eventId: uuid(n++), kind: spec.name, createdAt: 1_000 + n, payload })), e.env);
      const body = await json(res);
      expect({ kind: spec.name, body }).toEqual({ kind: spec.name, body: spec.projection === 'raw' ? { persisted: true } : spec.name === 'transcript.segment' ? { persisted: true, projected: true, transcript: { size: segBytes.byteLength, segmentCount: 1 } } : { persisted: true, projected: true } });
    }
    expect(count(e.sqlite, 'events')).toBe(KINDS.length);
    expect(count(e.sqlite, 'prompt_batches')).toBe(1);
    expect(count(e.sqlite, 'tool_calls')).toBe(2);
    expect(count(e.sqlite, 'responses')).toBe(1);
    expect(count(e.sqlite, 'plans')).toBe(1);
    expect(count(e.sqlite, 'attachments')).toBe(1);
    expect(count(e.sqlite, 'transcript_segments')).toBe(1);
    expect(count(e.sqlite, 'transcripts')).toBe(1);
    expect(e.sqlite.query(`SELECT tag FROM tags WHERE entity_kind = 'plan' ORDER BY tag`).all()).toEqual([{ tag: 'a' }, { tag: 'b' }]);
    const session = e.sqlite.query(`SELECT agent, branch, started_at, ended_at, origin_path, parent_session_id, parent_reason, machine_id FROM sessions`).get();
    expect(session).toEqual({ agent: 'claude-code', branch: 'main', started_at: 900, ended_at: 5_000, origin_path: '/t.jsonl', parent_session_id: 'sess_0', parent_reason: 'fork', machine_id: 'machine_1' });
    const attachment = e.sqlite.query(`SELECT media_type, byte_size, blob_key FROM attachments`).get();
    expect(attachment).toEqual({ media_type: 'image/png', byte_size: bytes.byteLength, blob_key: key });
    const prompt = e.sqlite.query(`SELECT content_hash, ended_at, thread_id FROM prompt_batches`).get() as any;
    expect(prompt.content_hash).toBe(await sha256Hex('hi'));
    expect(prompt.ended_at).toBe(1_000 + 106);
    expect(prompt.thread_id).toBe(uuid(30));
    const tool = e.sqlite.query(`SELECT success, error_message, canopy_injection_tokens FROM tool_calls ORDER BY tool_call_id`).all();
    expect(tool).toEqual([{ success: 1, error_message: null, canopy_injection_tokens: 12 }, { success: 0, error_message: 'boom', canopy_injection_tokens: null }]);
    expect((e.sqlite.query(`SELECT COUNT(*) c FROM events WHERE producer_adapter = '' OR producer_version = ''`).get() as any).c).toBe(0);
  });

  it('refuses an unknown kind and an unknown payload field by name, storing nothing and charging nothing', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    expect(await json(await worker.fetch(memberPost(t.token, envelope({ kind: 'made.up', payload: {} })), e.env))).toEqual({ persisted: false, code: 'unknown_kind', reason: 'unknown kind made.up' });
    expect(await json(await worker.fetch(memberPost(t.token, envelope({ payload: { promptId: uuid(2), text: 'x', origin: 'user', extra: 1 } })), e.env))).toEqual({ persisted: false, code: 'unknown_field', reason: 'unknown field payload.extra' });
    expect(await json(await worker.fetch(memberPost(t.token, envelope({ payload: { promptId: uuid(2), origin: 'user' } })), e.env))).toEqual({ persisted: false, code: 'refused', reason: 'exactly one of text or blob is required' });
    expect(await json(await worker.fetch(memberPost(t.token, envelope({ payload: { promptId: uuid(2), text: 'x', blob: 'a'.repeat(64), origin: 'user' } })), e.env))).toEqual({ persisted: false, code: 'refused', reason: 'exactly one of text or blob is required' });
    expect(await json(await worker.fetch(memberPost(t.token, envelope({ payload: { promptId: uuid(2), text: 'x', origin: 'human' } })), e.env))).toEqual({ persisted: false, code: 'refused', reason: `origin must be one of ${PROMPT_ORIGINS.join(', ')}` });
    expect(await json(await worker.fetch(memberPost(t.token, envelope({ kind: 'tool.use', payload: { toolCallId: uuid(3), toolName: 'x'.repeat(65), input: {}, success: true } })), e.env))).toEqual({ persisted: false, code: 'refused', reason: 'toolName must be a string of at most 64 characters' });
    expect(count(e.sqlite, 'events')).toBe(0);
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(0);
  });

  it('holds every ordering field to the envelope\'s own clock rule, and admits a caller time behind it so history can still be replayed', async () => {
    // A merge ordering decided by a caller time is decided by it forever: `started_at` is a minimum and `ended_at` a
    // maximum, so one value past the clock rule pins the column for the life of the session. The catalogue's own
    // ceiling (MAX_TIME_MS, the year 2100) is not that rule — the envelope's skew bound is, and the payload fields
    // that stand in for `createdAt` must obey the same one. There is no past bound: a session started before the
    // member came online, and the 1.4.x history a migration replays, are both older than any window would allow, and
    // an old value can only reorder the sessions of the machine that wrote it.
    const e = sqliteEnv();
    const t = await member(e);
    const now = Date.now();
    const ahead = `is more than ${MAX_CLOCK_SKEW_MS} ms ahead of the server clock`;
    for (const [kind, payload, field] of [
      ['session.start', { agent: 'claude-code', startedAt: MAX_TIME_MS }, 'startedAt'],
      ['session.start', { agent: 'claude-code', startedAt: now + MAX_CLOCK_SKEW_MS + 60_000 }, 'startedAt'],
      ['session.end', { endedAt: MAX_TIME_MS }, 'endedAt'],
      ['session.end', { endedAt: now + MAX_CLOCK_SKEW_MS + 60_000 }, 'endedAt'],
    ] as [string, Record<string, unknown>, string][]) {
      const res = await json(await worker.fetch(memberPost(t.token, envelope({ kind, payload, sessionId: 'sess_skew' })), e.env));
      expect({ kind, field, res }).toEqual({ kind, field, res: { persisted: false, code: 'clock_skew', reason: `${field} ${ahead}` } });
    }
    expect(count(e.sqlite, 'events')).toBe(0);
    expect(count(e.sqlite, 'sessions')).toBe(0);

    const old = await json(await worker.fetch(memberPost(t.token, envelope({ eventId: uuid(80), kind: 'session.start', sessionId: 'sess_old', payload: { agent: 'claude-code', startedAt: 0 } })), e.env));
    expect(old).toEqual({ persisted: true, projected: true });
    expect(e.sqlite.query(`SELECT started_at FROM sessions WHERE session_id = 'sess_old'`).get()).toEqual({ started_at: 0 });

    // The boundary itself, against a fixed clock: at the bound admitted, one millisecond past it refused — the same
    // edge the envelope gate holds for `createdAt`.
    for (const spec of KINDS) {
      for (const field of orderingFields(spec)) {
        const required = Object.fromEntries(Object.entries(FIXTURES[spec.name].payload).filter(([f]) => spec.fields[f]?.required === true));
        expect({ kind: spec.name, field, atBound: parsePayload(spec, { ...required, [field]: FIXTURE_NOW + MAX_CLOCK_SKEW_MS }, FIXTURE_NOW).ok }).toEqual({ kind: spec.name, field, atBound: true });
        expect({ kind: spec.name, field, past: parsePayload(spec, { ...required, [field]: FIXTURE_NOW + MAX_CLOCK_SKEW_MS + 1 }, FIXTURE_NOW) })
          .toEqual({ kind: spec.name, field, past: { ok: false, reason: `${field} ${ahead}`, classifier: 'clock_skew' } });
      }
    }
  });

  it('enforces the id grammar on every member-minted logical id, and the transcript form only on transcriptId', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const cases: [string, Record<string, unknown>, string][] = [
      ['prompt', { promptId: '1', text: 'x', origin: 'user' }, 'promptId'],
      ['prompt', { promptId: uuid(2), text: 'x', origin: 'user', parentPromptId: 'pbat_1' }, 'parentPromptId'],
      ['tool.use', { toolCallId: 'act_1', toolName: 'x', input: {}, success: true }, 'toolCallId'],
      ['response', { responseId: `tx_${'0'.repeat(32)}`, text: 'x' }, 'responseId'],
      ['plan', { planKey: 'plans/x.md', content: 'x' }, 'planKey'],
      ['attachment', { attachmentId: 'att_1', blob: 'a'.repeat(64) }, 'attachmentId'],
      ['subagent.start', { subagentId: 'sub-1' }, 'subagentId'],
    ];
    for (const [kind, payload, field] of cases) {
      const res = await json(await worker.fetch(memberPost(t.token, envelope({ kind, payload })), e.env));
      expect({ kind, res }).toEqual({ kind, res: { persisted: false, code: 'id_grammar', reason: `${field} must match the id grammar` } });
    }
    // The transcript grammar admits exactly the `tx_` form and the envelope's one lowercase id grammar: a case
    // variant of either form is refused, so a transcript can never fork into case-variant ids.
    for (const transcriptId of ['tx_short', `TX_${'0'.repeat(32)}`, `tx_${'A'.repeat(32)}`, 'ABCDEF12-3456-7000-8000-0123456789AB']) {
      const bad = await json(await worker.fetch(memberPost(t.token, envelope({ kind: 'transcript.segment', payload: { transcriptId, baseOffset: 0, length: 1, blob: 'a'.repeat(64) } })), e.env));
      expect({ transcriptId, bad }).toEqual({ transcriptId, bad: { persisted: false, code: 'id_grammar', reason: 'transcriptId must match the transcript id grammar' } });
    }
    expect(count(e.sqlite, 'events')).toBe(0);
  });

  it('refuses a payload one byte over its cap through the wire with the spill route named, so the payload cap stands reachable below the body cap', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const fixed = JSON.stringify({ promptId: uuid(2), text: '', origin: 'user' }).length;
    const atCap = await json(await worker.fetch(memberPost(t.token, envelope({ eventId: uuid(280), payload: { promptId: uuid(2), text: 'x'.repeat(MAX_PAYLOAD_BYTES - fixed), origin: 'user' } })), e.env));
    expect(atCap).toEqual({ persisted: true, projected: true });
    const over = await json(await worker.fetch(memberPost(t.token, envelope({ eventId: uuid(281), payload: { promptId: uuid(282), text: 'x'.repeat(MAX_PAYLOAD_BYTES - fixed + 1), origin: 'user' } })), e.env));
    expect(over).toEqual({ persisted: false, code: 'refused', reason: PAYLOAD_CAP_REASON });
    expect(count(e.sqlite, 'events')).toBe(1);
  });

  it('refuses a reference to an absent blob, leaving no row and no charge; the same event id succeeds once the blob exists, whatever media type the blob carries', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const bytes = utf8('a long prompt');
    const key = await sha256HexOf(bytes);
    const spilled = envelope({ eventId: uuid(40), payload: { promptId: uuid(41), blob: key, origin: 'user' } });
    expect(await json(await worker.fetch(memberPost(t.token, spilled), e.env))).toEqual({ persisted: false, code: 'blob_absent', reason: `blob not present: ${key}` });
    expect(count(e.sqlite, 'events')).toBe(0);
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(0);
    const png = await upload(e, t.token, utf8('png-bytes'), 'image/png');
    expect(await json(await worker.fetch(memberPost(t.token, envelope({ eventId: uuid(42), payload: { promptId: uuid(43), blob: png, origin: 'user' } })), e.env))).toEqual({ persisted: true, projected: true });
    await upload(e, t.token, bytes);
    expect(await json(await worker.fetch(memberPost(t.token, spilled), e.env))).toEqual({ persisted: true, projected: true });
    expect(e.sqlite.query(`SELECT blob_key, content_hash, text FROM prompt_batches WHERE prompt_id = ?`).get(uuid(41))).toEqual({ blob_key: key, content_hash: key, text: null });
    expect((e.sqlite.query(`SELECT blob_key FROM events WHERE event_id = ?`).get(uuid(40)) as any).blob_key).toBe(key);
    const att = envelope({ eventId: uuid(44), kind: 'attachment', payload: { attachmentId: uuid(45), blob: 'b'.repeat(64) } });
    expect(await json(await worker.fetch(memberPost(t.token, att), e.env))).toEqual({ persisted: false, code: 'blob_absent', reason: `blob not present: ${'b'.repeat(64)}` });
    expect(count(e.sqlite, 'events')).toBe(2);
  });

  it('refuses a cross-project blob reference while allowing a same-project reference by another member', async () => {
    const e = sqliteEnv();
    const t1 = await member(e);
    const t3 = await member(e, 'proj_1', 'machine_3');
    const t2 = await member(e, 'proj_2', 'machine_2');
    const key = await upload(e, t1.token, utf8('shared'), 'image/png');
    expect(await json(await worker.fetch(memberPost(t3.token, envelope({ eventId: uuid(50), sessionId: 'sess_3', kind: 'attachment', payload: { attachmentId: uuid(51), blob: key } })), e.env))).toEqual({ persisted: true, projected: true });
    expect(await json(await worker.fetch(memberPost(t2.token, envelope({ eventId: uuid(52), sessionId: 'sess_2', kind: 'attachment', payload: { attachmentId: uuid(53), blob: key } }), '/events', { [PROJECT_HEADER]: 'proj_2' }), e.env))).toEqual({ persisted: false, code: 'blob_absent', reason: `blob not present: ${key}` });
    expect((e.sqlite.query(`SELECT media_type FROM attachments`).get() as any).media_type).toBe('image/png');
  });

  it('merges prompt fields from a later event but never rewrites text: the miner refines, a differing text is a visible projection conflict, replay in any order converges', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const live = envelope({ eventId: uuid(60), createdAt: 1_000, payload: { promptId: uuid(61), text: 'hi', origin: 'user' } });
    const mined = envelope({ eventId: uuid(62), createdAt: 2_000, payload: { promptId: uuid(61), text: 'hi', origin: 'user', promptKind: 'user', parentPromptId: uuid(63) } });
    const differing = envelope({ eventId: uuid(64), createdAt: 3_000, payload: { promptId: uuid(61), text: 'other', origin: 'user' } });
    expect(await json(await worker.fetch(memberPost(t.token, live), e.env))).toEqual({ persisted: true, projected: true });
    expect(await json(await worker.fetch(memberPost(t.token, mined), e.env))).toEqual({ persisted: true, projected: true });
    expect(e.sqlite.query(`SELECT text, prompt_kind, parent_prompt_id, updated_at FROM prompt_batches`).get()).toEqual({ text: 'hi', prompt_kind: 'user', parent_prompt_id: uuid(63), updated_at: 2_000 });
    expect(await json(await worker.fetch(memberPost(t.token, differing), e.env))).toEqual({ persisted: true, projected: false, code: 'projection_conflict', reason: 'prompt text differs from the stored prompt' });
    expect(e.sqlite.query(`SELECT text FROM prompt_batches`).get()).toEqual({ text: 'hi' });
    expect(count(e.sqlite, 'events')).toBe(3);
    const older = envelope({ eventId: uuid(65), createdAt: 500, payload: { promptId: uuid(61), text: 'hi', origin: 'user', promptKind: 'system' } });
    expect(await json(await worker.fetch(memberPost(t.token, older), e.env))).toEqual({ persisted: true, projected: true });
    expect(e.sqlite.query(`SELECT prompt_kind, created_at, updated_at FROM prompt_batches`).get()).toEqual({ prompt_kind: 'user', created_at: 500, updated_at: 2_000 });
    const e2 = sqliteEnv();
    const t2 = await member(e2);
    for (const ev of [older, differing, mined, live]) await worker.fetch(memberPost(t2.token, ev), e2.env);
    expect(e2.sqlite.query(`SELECT text, prompt_kind, parent_prompt_id, created_at, updated_at FROM prompt_batches`).get()).toEqual({ text: 'hi', prompt_kind: 'user', parent_prompt_id: uuid(63), created_at: 500, updated_at: 2_000 });
  });

  it('upserts plans by client time so a retried older edit never regresses a newer one, and replaces tags atomically', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const v1 = envelope({ eventId: uuid(70), createdAt: 1_000, kind: 'plan', payload: { planKey: uuid(71), title: 'v1', content: 'one', tags: ['x'] } });
    const v2 = envelope({ eventId: uuid(72), createdAt: 2_000, kind: 'plan', payload: { planKey: uuid(71), title: 'v2', content: 'two', status: 'completed', tags: ['y', 'z'] } });
    expect(await json(await worker.fetch(memberPost(t.token, v2), e.env))).toEqual({ persisted: true, projected: true });
    expect(await json(await worker.fetch(memberPost(t.token, v1), e.env))).toEqual({ persisted: true, projected: true });
    expect(e.sqlite.query(`SELECT title, content, status, updated_at, created_at FROM plans`).get()).toEqual({ title: 'v2', content: 'two', status: 'completed', updated_at: 2_000, created_at: 1_000 });
    expect(e.sqlite.query(`SELECT tag FROM tags ORDER BY tag`).all()).toEqual([{ tag: 'y' }, { tag: 'z' }]);
    expect(count(e.sqlite, 'events')).toBe(2);
    const spilled = utf8('# very long plan');
    const key = await upload(e, t.token, spilled);
    const v3 = envelope({ eventId: uuid(73), createdAt: 3_000, kind: 'plan', payload: { planKey: uuid(71), blob: key } });
    expect(await json(await worker.fetch(memberPost(t.token, v3), e.env))).toEqual({ persisted: true, projected: true });
    expect(e.sqlite.query(`SELECT content, blob_key, content_hash, status FROM plans`).get()).toEqual({ content: null, blob_key: key, content_hash: key, status: 'completed' });
    expect(count(e.sqlite, 'tags')).toBe(0);
  });

  it('keeps a plan\'s prompt and administrator: a create names its prompt, an update without one keeps it, identical content leaves the stamp, and a newer capture clears the administrator', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    await worker.fetch(memberPost(t.token, envelope({ eventId: uuid(90), payload: { promptId: uuid(91), text: 'hi', origin: 'user' } })), e.env);
    const create = envelope({ eventId: uuid(92), createdAt: 1_000, kind: 'plan', payload: { planKey: uuid(93), promptId: uuid(91), title: 'p', content: 'one', status: 'active' } });
    expect(await json(await worker.fetch(memberPost(t.token, create), e.env))).toEqual({ persisted: true, projected: true });
    const row = () => e.sqlite.query(`SELECT prompt_id, updated_by, status, content, event_id, updated_at FROM plans`).get() as Record<string, unknown>;
    expect(row()).toEqual({ prompt_id: uuid(91), updated_by: null, status: 'active', content: 'one', event_id: uuid(92), updated_at: 1_000 });
    // Identical content, title and status: the row keeps its stamp and its event.
    const same = envelope({ eventId: uuid(94), createdAt: 2_000, kind: 'plan', payload: { planKey: uuid(93), title: 'p', content: 'one' } });
    expect(await json(await worker.fetch(memberPost(t.token, same), e.env))).toEqual({ persisted: true, projected: true });
    expect(row()).toMatchObject({ event_id: uuid(92), updated_at: 1_000 });
    // An administrative edit names its member; a newer capture with new content clears it and keeps the prompt the row already names.
    e.sqlite.run(`UPDATE plans SET status = 'completed', updated_by = 'mem_x', updated_at = 2_500 WHERE plan_key = ?`, [uuid(93)]);
    const newer = envelope({ eventId: uuid(95), createdAt: 3_000, kind: 'plan', payload: { planKey: uuid(93), content: 'two' } });
    expect(await json(await worker.fetch(memberPost(t.token, newer), e.env))).toEqual({ persisted: true, projected: true });
    expect(row()).toEqual({ prompt_id: uuid(91), updated_by: null, status: 'completed', content: 'two', event_id: uuid(95), updated_at: 3_000 });
    // A prompt another machine captured is refused as a plan's origin.
    const t3 = await member(e, 'proj_1', 'machine_3');
    const foreign = envelope({ eventId: uuid(96), sessionId: 'sess_3', createdAt: 4_000, kind: 'plan', payload: { planKey: uuid(93), promptId: uuid(91), content: 'three' } });
    expect(await json(await worker.fetch(memberPost(t3.token, foreign), e.env))).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
  });

  it('binds continued rows to the first inserter\'s machine: another machine\'s token is refused on the session and the transcript, storing nothing — and updates a plan, a Project-shared row, keeping the first machine and recording its own credential', async () => {
    const e = sqliteEnv();
    const t1 = await member(e);
    const t3 = await member(e, 'proj_1', 'machine_3');
    await worker.fetch(memberPost(t1.token, envelope({ eventId: uuid(80), kind: 'session.start', payload: { agent: 'claude-code' } })), e.env);
    const foreign = envelope({ eventId: uuid(81), kind: 'session.start', payload: { agent: 'codex' } });
    expect(await json(await worker.fetch(memberPost(t3.token, foreign), e.env))).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
    expect(await json(await worker.fetch(memberPost(t3.token, envelope({ eventId: uuid(82), payload: { promptId: uuid(83), text: 'x', origin: 'user' } })), e.env))).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
    await worker.fetch(memberPost(t1.token, envelope({ eventId: uuid(84), kind: 'plan', payload: { planKey: uuid(85), content: 'mine' } })), e.env);
    const theirs = envelope({ eventId: uuid(86), sessionId: 'sess_3', kind: 'plan', createdAt: 2_000, payload: { planKey: uuid(85), content: 'theirs' } });
    expect(await json(await worker.fetch(memberPost(t3.token, theirs), e.env))).toEqual({ persisted: true, projected: true });
    const seg = utf8('seg');
    const key = await upload(e, t1.token, seg);
    const tx = `tx_${'a'.repeat(32)}`;
    await worker.fetch(memberPost(t1.token, envelope({ eventId: uuid(87), kind: 'transcript.segment', payload: { transcriptId: tx, baseOffset: 0, length: seg.byteLength, blob: key } })), e.env);
    const append = await json(await worker.fetch(memberPost(t3.token, envelope({ eventId: uuid(88), sessionId: 'sess_3', kind: 'transcript.segment', payload: { transcriptId: tx, baseOffset: seg.byteLength, length: seg.byteLength, blob: key } })), e.env));
    expect(append).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
    expect(count(e.sqlite, 'events')).toBe(4);
    expect(bytesWritten(e.sqlite, t3.tokenId)).toBe(new TextEncoder().encode(JSON.stringify(theirs)).byteLength);
    expect(e.sqlite.query(`SELECT agent FROM sessions WHERE session_id = 'sess_1'`).get()).toEqual({ agent: 'claude-code' });
    expect(e.sqlite.query(`SELECT content, machine_id, session_id, token_id FROM plans`).get()).toEqual({ content: 'theirs', machine_id: 'machine_1', session_id: 'sess_1', token_id: t3.tokenId });
  });

  it('is the offset authority for transcripts: append, duplicate, overlap, and gap each carry the held size', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const a = utf8('first-line\n');
    const b = utf8('second\n');
    const ka = await upload(e, t.token, a);
    const kb = await upload(e, t.token, b);
    const tx = `tx_${'b'.repeat(32)}`;
    const seg = (n: number, baseOffset: number, blob: string, length: number) =>
      memberPost(t.token, envelope({ eventId: uuid(90 + n), kind: 'transcript.segment', payload: { transcriptId: tx, baseOffset, length, blob } }));
    expect(await json(await worker.fetch(seg(0, 0, ka, a.byteLength), e.env))).toEqual({ persisted: true, projected: true, transcript: { size: a.byteLength, segmentCount: 1 } });
    expect(await json(await worker.fetch(seg(1, a.byteLength + 5, kb, b.byteLength), e.env))).toEqual({ persisted: false, code: 'offset_gap', reason: 'transcript offset gap', transcript: { size: a.byteLength, segmentCount: 1 } });
    expect(await json(await worker.fetch(seg(2, 0, ka, a.byteLength), e.env))).toEqual({ persisted: true, duplicate: true, transcript: { size: a.byteLength, segmentCount: 1 } });
    expect(await json(await worker.fetch(seg(3, 0, kb, b.byteLength), e.env))).toEqual({ persisted: false, code: 'offset_overlap', reason: 'transcript offset overlap', transcript: { size: a.byteLength, segmentCount: 1 } });
    expect(await json(await worker.fetch(seg(4, a.byteLength, kb, b.byteLength + 1), e.env))).toEqual({ persisted: false, code: 'blob_length_mismatch', reason: 'blob size does not match length', transcript: { size: a.byteLength, segmentCount: 1 } });
    expect(await json(await worker.fetch(seg(5, a.byteLength, kb, b.byteLength), e.env))).toEqual({ persisted: true, projected: true, transcript: { size: a.byteLength + b.byteLength, segmentCount: 2 } });
    expect(count(e.sqlite, 'events')).toBe(2);
    expect(count(e.sqlite, 'transcript_segments')).toBe(2);
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(a.byteLength + b.byteLength + [0, 5].reduce((sum, n) => sum + new TextEncoder().encode(JSON.stringify(envelope({ eventId: uuid(90 + n), kind: 'transcript.segment', payload: { transcriptId: tx, baseOffset: n === 0 ? 0 : a.byteLength, length: n === 0 ? a.byteLength : b.byteLength, blob: n === 0 ? ka : kb } }))).byteLength, 0));
  });

  it('refuses a payload whose keys come from the object prototype', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const payload = JSON.parse(`{"promptId":"${uuid(2)}","text":"x","origin":"user","${key}":"x"}`);
      expect(await json(await worker.fetch(memberPost(t.token, envelope({ payload })), e.env))).toEqual({ persisted: false, code: 'unknown_field', reason: `unknown field payload.${key}` });
    }
    expect(count(e.sqlite, 'events')).toBe(0);
  });

  it('refuses, for every kind with a blob-key field, a reference to an absent key, leaving no row and no charge', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const absent = 'c'.repeat(64);
    let n = 300;
    // The fields are taken from the catalogue's own bounds, not from the enforcement's helper, and the set driven is
    // pinned by name — so the gate and the admission can never narrow together.
    const driven: string[] = [];
    for (const spec of KINDS) {
      const fields = Object.entries(spec.fields).filter(([, f]) => f.bound.type === 'blobKey').map(([field]) => field);
      expect({ kind: spec.name, fields: blobFields(spec) }).toEqual({ kind: spec.name, fields });
      for (const field of fields) {
        driven.push(`${spec.name}.${field}`);
        const base = { ...FIXTURES[spec.name].payload };
        for (const pair of [spec.exactlyOne, spec.atMostOne]) if (pair && pair[1] === field) delete base[pair[0]];
        if (spec.name === 'transcript.segment') base.length = 9;
        const extra = spec.name === 'transcript.segment' ? { transcript: { size: 0, segmentCount: 0 } } : {};
        const missing = await json(await worker.fetch(memberPost(t.token, envelope({ eventId: uuid(n++), kind: spec.name, payload: { ...base, [field]: absent } })), e.env));
        expect({ kind: spec.name, field, missing }).toEqual({ kind: spec.name, field, missing: { persisted: false, code: 'blob_absent', reason: `blob not present: ${absent}`, ...extra } });
      }
    }
    expect(driven.sort()).toEqual(BLOB_KEY_FIELDS);
    expect(count(e.sqlite, 'events')).toBe(0);
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(0);
  });

  /** Keyed projections that carry no row owner: a Project-shared row any member may update. Exactly these, by name. */
  const SHARED_ROW_PROJECTIONS = new Set(['plans']);

  it('derives an owned identity for every keyed column a kind projects, so a keyed table cannot enter the catalogue without its ownership check — but the named Project-shared projections, which carry none', async () => {
    const recorder = { prepare: (sql: string) => ({ sql, params: [] as unknown[], bind: (...params: unknown[]) => ({ sql, params }) }) } as any;
    const ctx: WriteContext = { projectId: 'proj_1', tokenId: 'mt_1', machineId: 'machine_1', now: 1, nonce: 'nonce-1' };
    for (const spec of KINDS) {
      const payload = { ...FIXTURES[spec.name].payload, blob: 'a'.repeat(64) };
      const e = { eventId: uuid(1), sessionId: 'sess_1', kind: spec.name, createdAt: 1_000, channel: 'cli', producer: { adapter: 'a', version: '1' }, payload, payloadJson: '{}', payloadBytes: new Uint8Array(0) } as any;
      const plan = planKind(spec, { db: recorder, ctx, e, p: payload, contentHash: null });
      const owner = ROW_OWNED_PROJECTIONS.has(spec.projection) ? 'row' : 'session';
      const keyed = Object.entries(spec.fields)
        .filter(([, f]) => ((f.bound.type === 'id' && f.role === 'key') || f.bound.type === 'transcriptId') && f.column !== undefined)
        .map(([field, f]) => ({ keyColumn: f.column as string, key: payload[field], owner }));
      const expected = spec.projection === 'raw' || SHARED_ROW_PROJECTIONS.has(spec.projection) ? [] : keyed;
      expect({ kind: spec.name, identities: plan.identities.map(({ keyColumn, key, owner }) => ({ keyColumn, key, owner })) })
        .toEqual({ kind: spec.name, identities: expected });
    }
  });

  it('binds a row keyed by its own id to the machine that owns its session: another machine cannot squat a tool call, response, or attachment id', async () => {
    const e = sqliteEnv();
    const t1 = await member(e);
    const t3 = await member(e, 'proj_1', 'machine_3');
    const png = await upload(e, t1.token, utf8('att-bytes'), 'image/png');
    const ids = { toolCallId: uuid(600), responseId: uuid(601), attachmentId: uuid(602) };
    const mine: [string, Record<string, unknown>][] = [
      ['tool.use', { toolCallId: ids.toolCallId, toolName: 'Read', input: { a: 1 }, success: true }],
      ['response', { responseId: ids.responseId, text: 'mine' }],
      ['attachment', { attachmentId: ids.attachmentId, blob: png }],
    ];
    let n = 610;
    for (const [kind, payload] of mine) {
      const own = await json(await worker.fetch(memberPost(t1.token, envelope({ eventId: uuid(n++), kind, createdAt: 1_000, payload })), e.env));
      expect({ kind, own }).toEqual({ kind, own: { persisted: true, projected: true } });
    }
    const before = ['tool_calls', 'responses', 'attachments'].map((t) => e.sqlite.query(`SELECT * FROM ${t}`).all());
    for (const [kind, payload] of mine) {
      const res = await json(await worker.fetch(memberPost(t3.token, envelope({ eventId: uuid(n++), sessionId: 'sess_3', kind, createdAt: 9_000, payload })), e.env));
      expect({ kind, res }).toEqual({ kind, res: { persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' } });
    }
    expect(['tool_calls', 'responses', 'attachments'].map((t) => e.sqlite.query(`SELECT * FROM ${t}`).all())).toEqual(before);
  });

  it('binds referenced prompts to the machine that owns their session: another machine\'s token cannot merge, time, join to, or parent onto them, and sees no oracle', async () => {
    const e = sqliteEnv();
    const t1 = await member(e);
    const t3 = await member(e, 'proj_1', 'machine_3');
    const promptId = uuid(400);
    const own = envelope({ eventId: uuid(401), createdAt: 1_000, payload: { promptId, text: 'secret', origin: 'user' } });
    expect(await json(await worker.fetch(memberPost(t1.token, own), e.env))).toEqual({ persisted: true, projected: true });
    const before = e.sqlite.query(`SELECT * FROM prompt_batches`).all();
    const attacks: [string, Record<string, unknown>][] = [
      ['prompt', { promptId, text: 'secret', origin: 'user', promptKind: 'system', threadId: uuid(402), threadLabel: 'x' }],
      ['prompt', { promptId, text: 'guess', origin: 'user' }],
      ['response', { responseId: uuid(403), promptId, text: 'r' }],
      ['tool.use', { toolCallId: uuid(404), promptId, toolName: 'Read', input: {}, success: true }],
      ['prompt', { promptId: uuid(405), text: 'child', origin: 'user', parentPromptId: promptId }],
      ['subagent.start', { subagentId: uuid(406), parentPromptId: promptId }],
    ];
    let n = 410;
    for (const [kind, payload] of attacks) {
      const res = await json(await worker.fetch(memberPost(t3.token, envelope({ eventId: uuid(n++), sessionId: 'sess_3', kind, createdAt: 9_000, payload })), e.env));
      expect({ kind, res }).toEqual({ kind, res: { persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' } });
    }
    expect(e.sqlite.query(`SELECT * FROM prompt_batches`).all()).toEqual(before);
    expect(count(e.sqlite, 'responses')).toBe(0);
    expect(count(e.sqlite, 'tool_calls')).toBe(0);
    expect(count(e.sqlite, 'events')).toBe(1);
    expect(bytesWritten(e.sqlite, t3.tokenId)).toBe(0);
    for (const kind of KINDS) {
      for (const field of promptReferenceFields(kind)) expect({ kind: kind.name, field, marked: kind.fields[field].references }).toEqual({ kind: kind.name, field, marked: 'prompt' });
    }
    expect(promptReferenceFields(kindSpec('subagent.start')!)).toEqual(['parentPromptId']);
    expect(promptReferenceFields(kindSpec('prompt')!).sort()).toEqual(['parentPromptId', 'promptId']);
  });

  it('never times a prompt from a response another machine posted before the prompt existed', async () => {
    const e = sqliteEnv();
    const t1 = await member(e);
    const t3 = await member(e, 'proj_1', 'machine_3');
    const promptId = uuid(430);
    expect(await json(await worker.fetch(memberPost(t3.token, envelope({ eventId: uuid(431), sessionId: 'sess_3', kind: 'response', createdAt: 1, payload: { responseId: uuid(432), promptId, text: 'early' } })), e.env))).toEqual({ persisted: true, projected: true });
    expect(await json(await worker.fetch(memberPost(t1.token, envelope({ eventId: uuid(433), createdAt: 5_000, payload: { promptId, text: 'mine', origin: 'user' } })), e.env))).toEqual({ persisted: true, projected: true });
    expect(e.sqlite.query(`SELECT ended_at FROM prompt_batches WHERE prompt_id = ?`).get(promptId)).toEqual({ ended_at: null });
    expect(await json(await worker.fetch(memberPost(t1.token, envelope({ eventId: uuid(434), kind: 'response', createdAt: 6_000, payload: { responseId: uuid(435), promptId, text: 'own' } })), e.env))).toEqual({ persisted: true, projected: true });
    expect(e.sqlite.query(`SELECT ended_at FROM prompt_batches WHERE prompt_id = ?`).get(promptId)).toEqual({ ended_at: 6_000 });
    expect(await json(await worker.fetch(memberPost(t3.token, envelope({ eventId: uuid(436), sessionId: 'sess_3', kind: 'response', createdAt: 2, payload: { responseId: uuid(437), promptId, text: 'late' } })), e.env))).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
  });

  it('refuses a zero-length segment and never advances a transcript without its bytes', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const tx = `tx_${'c'.repeat(32)}`;
    const zero = await json(await worker.fetch(memberPost(t.token, envelope({ eventId: uuid(420), kind: 'transcript.segment', payload: { transcriptId: tx, baseOffset: 0, length: 0, blob: 'a'.repeat(64) } })), e.env));
    expect(zero).toEqual({ persisted: false, code: 'refused', reason: `length must be an integer between 1 and ${MAX_BLOB_BYTES}` });
    const a = utf8('ten-bytes!');
    const ka = await upload(e, t.token, a);
    expect(await json(await worker.fetch(memberPost(t.token, envelope({ eventId: uuid(421), kind: 'transcript.segment', payload: { transcriptId: tx, baseOffset: 0, length: a.byteLength, blob: ka } })), e.env))).toEqual({ persisted: true, projected: true, transcript: { size: a.byteLength, segmentCount: 1 } });
    const same = await json(await worker.fetch(memberPost(t.token, envelope({ eventId: uuid(422), kind: 'transcript.segment', payload: { transcriptId: tx, baseOffset: 0, length: a.byteLength, blob: ka } })), e.env));
    expect(same).toEqual({ persisted: true, duplicate: true, transcript: { size: a.byteLength, segmentCount: 1 } });
    expect(e.sqlite.query(`SELECT size, segment_count FROM transcripts`).get()).toEqual({ size: a.byteLength, segment_count: 1 });
    expect((e.sqlite.query(`SELECT SUM(length) s FROM transcript_segments`).get() as any).s).toBe(a.byteLength);
  });


  it('conjoins the raw-row gate into every projection statement of every kind, and binds this request\'s nonce to it', () => {
    const recorder = { prepare: (sql: string) => ({ sql, params: [] as unknown[], bind: (...params: unknown[]) => ({ sql, params }) }) } as any;
    const ctx: WriteContext = { projectId: 'proj_1', tokenId: 'mt_1', machineId: 'machine_1', now: 1, nonce: 'nonce-1' };
    // Both payload shapes are planned: every field present, and only the required ones. A statement a kind builds
    // solely on an optional-field branch is invisible to a gate that plans one shape, so each shape is counted and
    // the totals are pinned exactly — a projection that disappears is a failure, not a smaller number.
    const counted: Record<string, number> = {};
    for (const shape of ['full', 'required-only'] as const) {
      let statements = 0;
      for (const spec of KINDS) {
        const full: Record<string, unknown> = { ...FIXTURES[spec.name].payload, blob: 'a'.repeat(64) };
        const payload = shape === 'full'
          ? full
          : Object.fromEntries(Object.entries(full).filter(([field]) => spec.fields[field]?.required === true));
        const e = { eventId: uuid(1), sessionId: 'sess_1', kind: spec.name, createdAt: 1_000, channel: 'cli', producer: { adapter: 'a', version: '1' }, payload, payloadJson: '{}', payloadBytes: new Uint8Array(0) } as any;
        for (const statement of planKind(spec, { db: recorder, ctx, e, p: payload, contentHash: null }).projections) {
          statements += 1;
          const { sql, params } = statement as unknown as { sql: string; params: unknown[] };
          const conjoined = sql.includes(`AND ${RAW_ROW_GATE}`) || sql.includes(`WHERE ${RAW_ROW_GATE}`);
          const weakened = sql.includes(`OR ${RAW_ROW_GATE}`) || sql.includes(`NOT ${RAW_ROW_GATE}`) || / (?:OR|NOT) \(*EXISTS \(SELECT 1 FROM events/.test(sql);
          expect({ shape, kind: spec.name, conjoined, weakened, bound: params.includes(ctx.nonce) })
            .toEqual({ shape, kind: spec.name, conjoined: true, weakened: false, bound: true });
        }
      }
      counted[shape] = statements;
    }
    expect(counted).toEqual({ full: FULL_PROJECTION_STATEMENTS, 'required-only': REQUIRED_ONLY_PROJECTION_STATEMENTS });
  });

  it('refuses to plan an ordering from a field the catalogue does not bound as a time', () => {
    // The catalogue gate keeps today's ordering fields bounded; this keeps the planner from reading an unbounded one
    // at all, so an ordering added later cannot quietly decide a merge from a value the clock rule never reached.
    const recorder = { prepare: (sql: string) => ({ sql, params: [] as unknown[], bind: (...params: unknown[]) => ({ sql, params }) }) } as any;
    const ctx: WriteContext = { projectId: 'proj_1', tokenId: 'mt_1', machineId: 'machine_1', now: 1, nonce: 'nonce-1' };
    const e = { eventId: uuid(1), sessionId: 'sess_1', kind: 'session.start', createdAt: 1_000, channel: 'cli', producer: { adapter: 'a', version: '1' }, payload: {}, payloadJson: '{}', payloadBytes: new Uint8Array(0) } as any;
    const spec = kindSpec('session.start')!;
    const unbounded = { ...spec, fields: { ...spec.fields, startedAt: { bound: { type: 'int', min: 0, max: MAX_TIME_MS }, column: 'started_at' } } } as typeof spec;
    expect(() => planKind(unbounded, { db: recorder, ctx, e, p: { agent: 'claude-code' }, contentHash: null }))
      .toThrow('ordering field session.start.startedAt must carry the time bound');
    expect(() => planKind(spec, { db: recorder, ctx, e, p: { agent: 'claude-code' }, contentHash: null })).not.toThrow();
  });

  it('reads the session identity, then every continued row\'s, before any blob, prompt, or transcript state, so a non-owner learns nothing else — on the session, the transcript, the plan, and every own-key row alike', async () => {
    const e = sqliteEnv();
    const t1 = await member(e);
    const t3 = await member(e, 'proj_1', 'machine_3');
    const absent = 'd'.repeat(64);
    await worker.fetch(memberPost(t1.token, envelope({ eventId: uuid(899) })), e.env);
    const intoForeignSession = await json(await worker.fetch(memberPost(t3.token, envelope({ eventId: uuid(900), kind: 'attachment', payload: { attachmentId: uuid(901), blob: absent } })), e.env));
    expect(intoForeignSession).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
    const seg = utf8('seg-bytes!');
    const key = await upload(e, t1.token, seg);
    const tx = `tx_${'e'.repeat(32)}`;
    await worker.fetch(memberPost(t1.token, envelope({ eventId: uuid(902), kind: 'transcript.segment', payload: { transcriptId: tx, baseOffset: 0, length: seg.byteLength, blob: key } })), e.env);
    const foreignTranscript = await json(await worker.fetch(memberPost(t3.token, envelope({ eventId: uuid(903), sessionId: 'sess_3', kind: 'transcript.segment', payload: { transcriptId: tx, baseOffset: 0, length: seg.byteLength - 1, blob: key } })), e.env));
    expect(foreignTranscript).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
    const ownTranscriptBadSize = await json(await worker.fetch(memberPost(t1.token, envelope({ eventId: uuid(904), kind: 'transcript.segment', payload: { transcriptId: tx, baseOffset: seg.byteLength, length: seg.byteLength - 1, blob: key } })), e.env));
    expect(ownTranscriptBadSize).toEqual({ persisted: false, code: 'blob_length_mismatch', reason: 'blob size does not match length', transcript: { size: seg.byteLength, segmentCount: 1 } });

    // The same order holds for every continued row a kind names, with an ABSENT blob on the request: the row's
    // identity is read first, so the non-owner is not told the blob is absent.
    const png = await upload(e, t1.token, utf8('att-bytes'), 'image/png');
    const own: [string, Record<string, unknown>][] = [
      ['plan', { planKey: uuid(905), content: 'mine' }],
      ['tool.use', { toolCallId: uuid(906), toolName: 'Read', input: {}, success: true }],
      ['response', { responseId: uuid(907), text: 'mine' }],
      ['attachment', { attachmentId: uuid(908), blob: png }],
    ];
    let n = 910;
    for (const [kind, payload] of own) expect((await json(await worker.fetch(memberPost(t1.token, envelope({ eventId: uuid(n++), kind, payload })), e.env))).persisted).toBe(true);
    const foreign: [string, Record<string, unknown>][] = [
      ['plan', { planKey: uuid(905), blob: absent }],
      ['tool.use', { toolCallId: uuid(906), toolName: 'Read', blob: absent, success: true }],
      ['response', { responseId: uuid(907), blob: absent }],
      ['attachment', { attachmentId: uuid(908), blob: absent }],
      ['transcript.segment', { transcriptId: tx, baseOffset: seg.byteLength, length: 1, blob: absent }],
    ];
    const observed: Record<string, unknown>[] = [];
    for (const [kind, payload] of foreign) observed.push({ kind, res: await json(await worker.fetch(memberPost(t3.token, envelope({ eventId: uuid(n++), sessionId: 'sess_3', kind, payload })), e.env)) });
    // A plan carries no row owner, so the probe from another machine reaches the blob check and learns the blob is absent; every owned row answers the identity first.
    expect(observed).toEqual(foreign.map(([kind]) => ({ kind, res: kind === 'plan' ? { persisted: false, code: 'blob_absent', reason: `blob not present: ${absent}` } : { persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' } })));
    const ownAbsent = await json(await worker.fetch(memberPost(t1.token, envelope({ eventId: uuid(n++), kind: 'plan', payload: { planKey: uuid(905), blob: absent } })), e.env));
    expect(ownAbsent).toEqual({ persisted: false, code: 'blob_absent', reason: `blob not present: ${absent}` });
  });

  it('names a capture-created Project after the first start that carries a usable origin path, and leaves a renamed or onboarded Project alone', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const nameOf = (id: string) => (e.sqlite.query(`SELECT name FROM projects WHERE project_id = ?`).get(id) as { name: string } | null)?.name;
    const start = async (project: string, session: string, n: number, payload: Record<string, unknown>) =>
      (await json(await worker.fetch(memberPost(t.token, envelope({ eventId: uuid(n), sessionId: session, kind: 'session.start', createdAt: n, payload }), '/events', { [PROJECT_HEADER]: project }), e.env))).persisted;

    expect(await start('proj_fresh', 'sess_a', 3000, { agent: 'a', startedAt: 100, originPath: '~/Repos/myco' })).toBe(true);
    expect(nameOf('proj_fresh')).toBe('myco');
    expect(await start('proj_fresh', 'sess_b', 3001, { agent: 'a', startedAt: 50, originPath: '/elsewhere/other' })).toBe(true);
    expect(nameOf('proj_fresh')).toBe('myco');

    expect(await start('proj_pathless', 'sess_c', 3002, { agent: 'a', startedAt: 100 })).toBe(true);
    expect(nameOf('proj_pathless')).toBe('proj_pathless');
    expect(await start('proj_pathless', 'sess_d', 3003, { agent: 'a', startedAt: 200, originPath: 'C:\\Users\\me\\work\\tool\\' })).toBe(true);
    expect(nameOf('proj_pathless')).toBe('tool');

    for (const [project, originPath] of [['proj_home', '~'], ['proj_dot', '.'], ['proj_root', '/'], ['proj_blank', '   ']] as const) {
      expect(await start(project, `sess_${project}`, 3004 + originPath.length, { agent: 'a', startedAt: 100, originPath })).toBe(true);
      expect(nameOf(project)).toBe(project);
    }

    e.sqlite.run(`INSERT INTO projects (project_id, name, created_at) VALUES ('proj_named', 'Chosen by hand', 0)`);
    expect(await start('proj_named', 'sess_e', 3100, { agent: 'a', startedAt: 100, originPath: '/repo/ignored' })).toBe(true);
    expect(nameOf('proj_named')).toBe('Chosen by hand');

    expect([basenameOf('/a/b/c'), basenameOf('a\\b\\c '), basenameOf('~/x/'), basenameOf('~'), basenameOf('..'), basenameOf(''), basenameOf(undefined), basenameOf(7), basenameOf(`/r/${'n'.repeat(201)}`), basenameOf(`/r/${'n'.repeat(200)}`)])
      .toEqual(['c', 'c', 'x', null, null, null, null, null, null, 'n'.repeat(200)]);
  });

  it('settles a tie on client time by the smaller event id, for session facts, prompts, and plans alike', async () => {
    const tied = [
      envelope({ eventId: uuid(950), createdAt: 1_000, kind: 'session.start', payload: { agent: 'claude-code', branch: 'alpha', startedAt: 1_000 } }),
      envelope({ eventId: uuid(951), createdAt: 1_000, kind: 'session.start', payload: { agent: 'codex', branch: 'beta', startedAt: 1_000 } }),
      envelope({ eventId: uuid(952), createdAt: 2_000, payload: { promptId: uuid(960), text: 'q', origin: 'user', promptKind: 'user' } }),
      envelope({ eventId: uuid(953), createdAt: 2_000, payload: { promptId: uuid(960), text: 'q', origin: 'user', promptKind: 'system' } }),
      envelope({ eventId: uuid(954), createdAt: 3_000, kind: 'plan', payload: { planKey: uuid(961), title: 'first', content: 'one', tags: ['x'] } }),
      envelope({ eventId: uuid(955), createdAt: 3_000, kind: 'plan', payload: { planKey: uuid(961), title: 'second', content: 'two', tags: ['y'] } }),
    ];
    const settled = async (order: Record<string, unknown>[]) => {
      const e = sqliteEnv();
      const t = await member(e);
      for (const ev of order) expect((await json(await worker.fetch(memberPost(t.token, ev), e.env))).persisted).toBe(true);
      return {
        session: e.sqlite.query(`SELECT agent, branch, started_at FROM sessions`).get(),
        prompt: e.sqlite.query(`SELECT prompt_kind FROM prompt_batches`).get(),
        plan: e.sqlite.query(`SELECT title, content FROM plans`).get(),
        tags: e.sqlite.query(`SELECT tag FROM tags ORDER BY tag`).all(),
      };
    };
    const forward = await settled(tied);
    expect(forward).toEqual({
      session: { agent: 'claude-code', branch: 'alpha', started_at: 1_000 },
      prompt: { prompt_kind: 'user' },
      plan: { title: 'first', content: 'one' },
      tags: [{ tag: 'x' }],
    });
    expect(await settled([...tied].reverse())).toEqual(forward);
  });

  it('settles session facts, prompt merges, and plans on the ranked winner alone under every permutation of three and of four events, so no other event fills a field the winner lacks', async () => {
    // Every column of a merged row is the ranked winner's — an absent field included — so the row is a function of the
    // set of events and never of their arrival order. Two-event replays cannot see a fill from a non-winner; three can.
    const facts = [
      envelope({ eventId: uuid(970), createdAt: 1_000, kind: 'session.start', payload: { agent: 'a', startedAt: 100 } }),
      envelope({ eventId: uuid(971), createdAt: 1_000, kind: 'session.start', payload: { agent: 'b', startedAt: 200, branch: 'x' } }),
      envelope({ eventId: uuid(972), createdAt: 1_000, kind: 'session.start', payload: { agent: 'c', startedAt: 300, branch: 'y', originPath: '/c.jsonl' } }),
      envelope({ eventId: uuid(973), createdAt: 1_000, kind: 'session.start', payload: { agent: 'd', startedAt: 150, parentSessionId: 'sess_p', parentReason: 'fork' } }),
    ];
    const prompts = [
      envelope({ eventId: uuid(980), createdAt: 100, payload: { promptId: uuid(990), text: 'q', origin: 'user', promptKind: 'a', threadLabel: 'L1' } }),
      envelope({ eventId: uuid(981), createdAt: 200, payload: { promptId: uuid(990), text: 'q', origin: 'user' } }),
      envelope({ eventId: uuid(982), createdAt: 150, payload: { promptId: uuid(990), text: 'q', origin: 'user', promptKind: 'c', parentPromptId: uuid(991) } }),
      envelope({ eventId: uuid(983), createdAt: 50, payload: { promptId: uuid(990), text: 'q', origin: 'user', promptKind: 'd', threadId: uuid(992) } }),
    ];
    const plans = [
      envelope({ eventId: uuid(1000), createdAt: 100, kind: 'plan', payload: { planKey: uuid(1010), title: 't1', content: 'c1', tags: ['a'] } }),
      envelope({ eventId: uuid(1001), createdAt: 200, kind: 'plan', payload: { planKey: uuid(1010), content: 'c2', status: 'completed', tags: [] } }),
      envelope({ eventId: uuid(1002), createdAt: 150, kind: 'plan', payload: { planKey: uuid(1010), title: 't3', content: 'c3', originPath: '/p.md', tags: ['b', 'c'] } }),
      envelope({ eventId: uuid(1003), createdAt: 50, kind: 'plan', payload: { planKey: uuid(1010), title: 't4', content: 'c4', status: 'abandoned', tags: ['d'] } }),
    ];
    const permutations = (n: number): number[][] => (n === 0 ? [[]] : permutations(n - 1).flatMap((p) => Array.from({ length: n }, (_, i) => [...p.slice(0, i), n - 1, ...p.slice(i)])));
    const settled = async (order: number[]) => {
      const e = sqliteEnv();
      const t = await member(e);
      for (const family of [facts, prompts, plans]) {
        for (const i of order) expect((await json(await worker.fetch(memberPost(t.token, family[i]), e.env))).persisted).toBe(true);
      }
      return {
        session: e.sqlite.query(`SELECT agent, branch, started_at, origin_path, parent_session_id, parent_reason, facts_event_id FROM sessions`).get(),
        prompt: e.sqlite.query(`SELECT event_id, prompt_kind, parent_prompt_id, thread_id, thread_label, created_at, updated_at FROM prompt_batches`).get(),
        plan: e.sqlite.query(`SELECT event_id, title, content, status, origin_path, created_at, updated_at FROM plans`).get(),
        tags: e.sqlite.query(`SELECT tag FROM tags ORDER BY tag`).all(),
      };
    };
    for (const n of [3, 4]) {
      const expected = {
        session: { agent: 'a', branch: null, started_at: 100, origin_path: null, parent_session_id: null, parent_reason: null, facts_event_id: uuid(970) },
        prompt: { event_id: uuid(981), prompt_kind: null, parent_prompt_id: null, thread_id: null, thread_label: null, created_at: n === 4 ? 50 : 100, updated_at: 200 },
        plan: { event_id: uuid(1001), title: null, content: 'c2', status: 'completed', origin_path: null, created_at: n === 4 ? 50 : 100, updated_at: 200 },
        tags: [],
      };
      for (const order of permutations(n)) {
        expect({ n, order, rows: await settled(order) }).toEqual({ n, order, rows: expected });
      }
    }
  });

  it('emits, for every refusal, the classifier the refusal itself carries: one fixed classifier per refusal, named here for each', async () => {
    const e = sqliteEnv();
    const t1 = await member(e);
    const t3 = await member(e, 'proj_1', 'machine_3');
    const anonymous = await issueMemberToken(e.db, { memberId: 'mem_anon', machineId: null }, Date.now());
    const seg = utf8('segment-bytes');
    const segKey = await upload(e, t1.token, seg);
    const tx = `tx_${'f'.repeat(32)}`;
    expect((await json(await worker.fetch(memberPost(t1.token, envelope({ eventId: uuid(1100), kind: 'transcript.segment', payload: { transcriptId: tx, baseOffset: 0, length: seg.byteLength, blob: segKey } })), e.env))).persisted).toBe(true);
    const absent = 'e'.repeat(64);
    const now = Date.now();
    const post = (over: Record<string, unknown>) => memberPost(t1.token, envelope({ eventId: uuid(1101), ...over }));
    const blob = (over: Record<string, string>, body: Uint8Array = seg, key = segKey) => new Request(`https://s/blobs/${key}`, { method: 'POST', headers: memberHeaders(t1.token, { 'content-type': TEXT_MEDIA_TYPE, 'content-length': String(body.byteLength), ...over }), body });
    const table: { name: string; request: () => Request; kind: 'ingest_refused' | 'blob_refused'; reason: string; classifier: string }[] = [
      { name: 'unknown kind', request: () => post({ kind: 'made.up', payload: {} }), kind: 'ingest_refused', reason: 'unknown kind made.up', classifier: 'unknown_kind' },
      { name: 'unknown envelope field', request: () => post({ machineId: 'x' }), kind: 'ingest_refused', reason: 'unknown field machineId', classifier: 'unknown_field' },
      { name: 'unknown producer field', request: () => post({ producer: { ...PRODUCER, extra: 1 } }), kind: 'ingest_refused', reason: 'unknown field producer.extra', classifier: 'unknown_field' },
      { name: 'unknown payload field', request: () => post({ payload: { promptId: uuid(2), text: 'x', origin: 'user', extra: 1 } }), kind: 'ingest_refused', reason: 'unknown field payload.extra', classifier: 'unknown_field' },
      { name: 'eventId grammar', request: () => post({ eventId: 'evt_1' }), kind: 'ingest_refused', reason: 'eventId must match the id grammar', classifier: 'id_grammar' },
      { name: 'promptId grammar', request: () => post({ payload: { promptId: '1', text: 'x', origin: 'user' } }), kind: 'ingest_refused', reason: 'promptId must match the id grammar', classifier: 'id_grammar' },
      { name: 'transcriptId grammar', request: () => post({ kind: 'transcript.segment', payload: { transcriptId: 'tx_short', baseOffset: 0, length: 1, blob: segKey } }), kind: 'ingest_refused', reason: 'transcriptId must match the transcript id grammar', classifier: 'id_grammar' },
      { name: 'createdAt ahead of the clock', request: () => post({ createdAt: now + MAX_CLOCK_SKEW_MS + 60_000 }), kind: 'ingest_refused', reason: `createdAt is more than ${MAX_CLOCK_SKEW_MS} ms ahead of the server clock`, classifier: 'clock_skew' },
      { name: 'startedAt ahead of the clock', request: () => post({ kind: 'session.start', payload: { agent: 'a', startedAt: now + MAX_CLOCK_SKEW_MS + 60_000 } }), kind: 'ingest_refused', reason: `startedAt is more than ${MAX_CLOCK_SKEW_MS} ms ahead of the server clock`, classifier: 'clock_skew' },
      { name: 'a plain bound', request: () => post({ payload: { promptId: uuid(2), origin: 'user' } }), kind: 'ingest_refused', reason: 'exactly one of text or blob is required', classifier: 'refused' },
      { name: 'body not JSON', request: () => memberPost(t1.token, '{'), kind: 'ingest_refused', reason: 'body must be JSON', classifier: 'parse' },
      { name: 'body over the cap', request: () => memberPost(t1.token, '0'.repeat(MAX_BODY_BYTES + 1)), kind: 'ingest_refused', reason: `body exceeds ${MAX_BODY_BYTES} bytes`, classifier: 'body_cap' },
      { name: 'absent blob', request: () => post({ kind: 'attachment', payload: { attachmentId: uuid(1102), blob: absent } }), kind: 'ingest_refused', reason: `blob not present: ${absent}`, classifier: 'blob_absent' },
      { name: 'foreign session', request: () => memberPost(t3.token, envelope({ eventId: uuid(1103), payload: { promptId: uuid(1104), text: 'x', origin: 'user' } })), kind: 'ingest_refused', reason: 'machine identity mismatch', classifier: 'identity_mismatch' },
      { name: 'transcript gap', request: () => post({ kind: 'transcript.segment', payload: { transcriptId: tx, baseOffset: seg.byteLength + 1, length: seg.byteLength, blob: segKey } }), kind: 'ingest_refused', reason: 'transcript offset gap', classifier: 'offset_gap' },
      { name: 'transcript overlap', request: () => post({ kind: 'transcript.segment', payload: { transcriptId: tx, baseOffset: 1, length: seg.byteLength, blob: segKey } }), kind: 'ingest_refused', reason: 'transcript offset overlap', classifier: 'offset_overlap' },
      { name: 'segment length', request: () => post({ kind: 'transcript.segment', payload: { transcriptId: tx, baseOffset: seg.byteLength, length: seg.byteLength - 1, blob: segKey } }), kind: 'ingest_refused', reason: 'blob size does not match length', classifier: 'blob_length_mismatch' },
      { name: 'machine-less token on /events', request: () => memberPost(anonymous.token, envelope({ eventId: uuid(1105) })), kind: 'ingest_refused', reason: 'token has no machine identity', classifier: 'no_machine_identity' },
      { name: 'machine-less token on /blobs', request: () => new Request(`https://s/blobs/${segKey}`, { method: 'POST', headers: memberHeaders(anonymous.token, { 'content-type': TEXT_MEDIA_TYPE, 'content-length': String(seg.byteLength) }), body: seg }), kind: 'blob_refused', reason: 'token has no machine identity', classifier: 'no_machine_identity' },
      { name: 'content-length', request: () => blob({ 'content-length': 'x' }), kind: 'blob_refused', reason: 'content-length required', classifier: 'content_length' },
      { name: 'blob cap', request: () => blob({ 'content-length': String(MAX_BLOB_BYTES + 1) }), kind: 'blob_refused', reason: `blob exceeds ${MAX_BLOB_BYTES} bytes`, classifier: 'blob_cap' },
      { name: 'media type', request: () => blob({ 'content-type': 'nonsense' }), kind: 'blob_refused', reason: 'invalid content-type', classifier: 'media_type' },
      { name: 'empty body', request: () => blob({}, new Uint8Array(0)), kind: 'blob_refused', reason: 'empty body', classifier: 'empty_body' },
      { name: 'digest mismatch', request: () => blob({}, utf8('other-bytes'), 'd'.repeat(64)), kind: 'blob_refused', reason: 'digest mismatch', classifier: 'digest_mismatch' },
      { name: 'event quota', request: () => { e.sqlite.query(`UPDATE member_credentials SET bytes_written = ? WHERE id = ?`).run(MEMBER_TOKEN_BYTE_QUOTA - 1, t1.tokenId); return post({}); }, kind: 'ingest_refused', reason: 'token write quota exceeded', classifier: 'quota' },
      { name: 'blob quota', request: () => blob({}, utf8('fresh-bytes'), 'c'.repeat(64)), kind: 'blob_refused', reason: 'token write quota exceeded', classifier: 'quota' },
    ];
    const observed: Record<string, unknown>[] = [];
    for (const row of table) {
      const lines: string[] = [];
      const orig = console.log;
      console.log = (line: string) => { lines.push(line); };
      let body: Record<string, unknown>;
      try {
        body = await json(await worker.fetch(row.request(), e.env));
      } finally { console.log = orig; }
      const events = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((ev) => ev.kind === row.kind);
      observed.push({ name: row.name, reason: body.reason, classifiers: events.map((ev) => ev.reason) });
    }
    expect(observed).toEqual(table.map((row) => ({ name: row.name, reason: row.reason, classifiers: [row.classifier] })));
  });

  it('serves every statement it executes from an index, never a scan of a project-scoped table', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const png = await upload(e, t.token, utf8('png-bytes'), 'image/png');
    const segBytes = utf8('{"line":1}\n');
    const segKey = await upload(e, t.token, segBytes);
    let n = 800;
    let offset = 0;
    // Both payload shapes are driven, not only the full fixture: a statement a kind builds on an optional-field
    // branch executes under one shape and not the other, and a gate that drives one shape never inspects it.
    for (const shape of ['full', 'required-only'] as const) {
      for (const spec of KINDS) {
        const full = { ...FIXTURES[spec.name].payload };
        if (spec.name === 'attachment') full.blob = png;
        if (spec.name === 'transcript.segment') { full.blob = segKey; full.length = segBytes.byteLength; }
        const payload = shape === 'full' ? full : Object.fromEntries(Object.entries(full).filter(([field]) => spec.fields[field]?.required === true));
        if (spec.name === 'transcript.segment') { payload.baseOffset = offset; offset += segBytes.byteLength; }
        for (const createdAt of [3_000, 3_001]) {
          await worker.fetch(memberPost(t.token, envelope({ eventId: uuid(n++), sessionId: `sess_${shape}`, kind: spec.name, createdAt, payload })), e.env);
        }
      }
    }
    // The fixtures above take the storing path only. Drive the branches they never enter — the duplicate read, the
    // orphan adoption and the reservation reconcile it forces, the expiry sweep with rows to sweep, the ceiling on an
    // adopted object, and a quota already spent on event bodies — so a scan on a branch off the happy path is still
    // inspected. A gate that sees only what one round of fixtures executed reports coverage, not cost.
    await worker.fetch(blobPost(t.token, await sha256HexOf(utf8('dup-bytes')), utf8('dup-bytes')), e.env);
    await worker.fetch(blobPost(t.token, await sha256HexOf(utf8('dup-bytes')), utf8('dup-bytes')), e.env);

    const adopted = await sha256HexOf(utf8('adopted-bytes'));
    e.bucket.objects.set(`proj_1/${adopted}`, { size: utf8('adopted-bytes').byteLength, contentType: TEXT_MEDIA_TYPE });
    e.sqlite.query(`INSERT INTO blob_reservations (reservation_id, project_id, key, token_id, size, expires_at) VALUES ('expired', 'proj_1', ?, ?, 1, 1)`).run(adopted, t.tokenId);
    await worker.fetch(new Request(`https://s/blobs/${adopted}`, {
      method: 'POST',
      headers: memberHeaders(t.token, { 'content-type': TEXT_MEDIA_TYPE, 'content-length': '1' }),
      body: 'x',
    }), e.env);

    const oversize = await sha256HexOf(utf8('oversize-bytes'));
    e.bucket.objects.set(`proj_1/${oversize}`, { size: MAX_BLOB_BYTES + 1, contentType: TEXT_MEDIA_TYPE });
    await worker.fetch(new Request(`https://s/blobs/${oversize}`, {
      method: 'POST',
      headers: memberHeaders(t.token, { 'content-type': TEXT_MEDIA_TYPE, 'content-length': '1' }),
      body: 'x',
    }), e.env);

    e.sqlite.query(`UPDATE member_credentials SET bytes_written = ? WHERE id = ?`).run(MEMBER_TOKEN_BYTE_QUOTA, t.tokenId);
    await worker.fetch(blobPost(t.token, await sha256HexOf(utf8('over-quota')), utf8('over-quota')), e.env);
    await worker.fetch(memberPost(t.token, envelope({ eventId: uuid(n++), kind: 'session.start', createdAt: 4_000, payload: FIXTURES['session.start'].payload })), e.env);

    const scoped = new Set(['events', 'sessions', 'prompt_batches', 'tool_calls', 'responses', 'plans', 'attachments', 'transcripts', 'transcript_segments', 'tags', 'blobs', 'blob_reservations']);
    const byTable = new Map<string, string>();
    const unique = new Map<string, number>();
    for (const row of e.sqlite.query(`SELECT name, tbl_name FROM sqlite_master WHERE type = 'index'`).all() as { name: string; tbl_name: string }[]) byTable.set(row.name, row.tbl_name);
    for (const table of scoped) {
      for (const idx of e.sqlite.query(`PRAGMA index_list(${table})`).all() as { name: string; unique: number }[]) {
        byTable.set(idx.name, table);
        if (idx.unique === 1) unique.set(idx.name, (e.sqlite.query(`PRAGMA index_info(${idx.name})`).all() as unknown[]).length);
      }
    }
    let checked = 0;
    const statements = new Set(e.executed);
    for (const sql of statements) {
      for (const step of e.sqlite.query(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]) {
        const scan = /^SCAN (?!CONSTANT ROW$|json_each\b)(\S+)/.exec(step.detail);
        expect({ sql, scan: scan?.[1] ?? null }).toEqual({ sql, scan: null });
        const search = /^SEARCH \w+ USING (?:COVERING )?(?:INDEX|PRIMARY KEY) ?(\S*) \(([^)]*)\)/.exec(step.detail);
        if (!search) continue;
        const table = byTable.get(search[1]) ?? null;
        if (table !== null && !scoped.has(table)) continue;
        checked += 1;
        const constraints = search[2].split(' AND ');
        const equalities = constraints.filter((c) => c.endsWith('=?')).length;
        // A lookup is narrow when the tenant leads it, when it matches every column of a unique index and so can
        // reach one row at most, or when a single credential leads it — a credential's rows are bounded by that
        // credential's own byte quota, which is a tighter bound than a project's.
        const seek = unique.get(search[1]) === equalities;
        const byCredential = constraints[0] === 'token_id=?';
        expect({ detail: step.detail, narrowed: table === null || equalities >= 2 || seek || byCredential })
          .toEqual({ detail: step.detail, narrowed: true });
      }
    }
    // `statements` is pinned exact; a dropped statement is caught here. `checked` is a floor: the planner emits a
    // library-dependent step count, and the per-step assertions hold the no-scan and narrowed guarantees.
    expect(statements.size).toBe(PLANNED_STATEMENTS);
    expect(checked).toBeGreaterThanOrEqual(MIN_INDEX_STEPS);
  });

  it('leaves every typed table unchanged for a duplicate, a conflict, and a refused event, for every kind', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const other = await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, Date.now());
    const png = await upload(e, t.token, utf8('png-bytes'), 'image/png');
    const segBytes = utf8('{"line":1}\n');
    const segKey = await upload(e, t.token, segBytes);
    const TABLES = ['sessions', 'prompt_batches', 'tool_calls', 'responses', 'plans', 'attachments', 'transcripts', 'transcript_segments', 'tags', 'blobs'];
    const snapshot = () => TABLES.map((table) => e.sqlite.query(`SELECT * FROM ${table}`).all());
    let n = 500;
    let offset = 0;
    for (const spec of KINDS) {
      const payload = { ...FIXTURES[spec.name].payload };
      if (spec.name === 'attachment') payload.blob = png;
      if (spec.name === 'transcript.segment') { payload.blob = segKey; payload.length = segBytes.byteLength; payload.baseOffset = offset; offset += segBytes.byteLength; }
      const eventId = uuid(n++);
      const stored = await json(await worker.fetch(memberPost(t.token, envelope({ eventId, kind: spec.name, createdAt: 2_000, payload })), e.env));
      expect({ kind: spec.name, persisted: stored.persisted }).toEqual({ kind: spec.name, persisted: true });
      const before = snapshot();

      const duplicate = await json(await worker.fetch(memberPost(t.token, envelope({ eventId, kind: spec.name, createdAt: 2_000, payload })), e.env));
      expect({ kind: spec.name, duplicate: duplicate.duplicate }).toEqual({ kind: spec.name, duplicate: true });
      expect({ kind: spec.name, tables: snapshot() }).toEqual({ kind: spec.name, tables: before });

      const conflict = await json(await worker.fetch(memberPost(t.token, envelope({ eventId, kind: spec.name, createdAt: 2_001, payload })), e.env));
      expect({ kind: spec.name, conflict: conflict.reason }).toEqual({ kind: spec.name, conflict: 'event id conflict' });
      expect({ kind: spec.name, tables: snapshot() }).toEqual({ kind: spec.name, tables: before });

      const refused = await json(await worker.fetch(memberPost(other.token, envelope({ eventId: uuid(n++), kind: spec.name, createdAt: 2_002, payload })), e.env));
      expect({ kind: spec.name, refused: refused.persisted, reason: refused.reason }).toEqual({ kind: spec.name, refused: false, reason: 'machine identity mismatch' });
      expect({ kind: spec.name, tables: snapshot() }).toEqual({ kind: spec.name, tables: before });
    }
  });

  it('never moves a transcript on a replay: the same event id, an older segment, and another machine all leave size and segment count alone (a stored event is read through its session\'s machine, so a foreign replay is refused, not answered duplicate)', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const other = await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, Date.now());
    const tx = `tx_${'b'.repeat(32)}`;
    const a = utf8('{"a":1}\n');
    const b = utf8('{"b":2}\n');
    const ka = await upload(e, t.token, a);
    const kb = await upload(e, t.token, b);
    const seg = (eventId: string, baseOffset: number, length: number, blob: string) =>
      envelope({ eventId, kind: 'transcript.segment', payload: { transcriptId: tx, baseOffset, length, blob } });
    const evA = seg(uuid(600), 0, a.byteLength, ka);
    const evB = seg(uuid(601), a.byteLength, b.byteLength, kb);
    expect(await json(await worker.fetch(memberPost(t.token, evA), e.env))).toEqual({ persisted: true, projected: true, transcript: { size: a.byteLength, segmentCount: 1 } });
    expect(await json(await worker.fetch(memberPost(t.token, evB), e.env))).toEqual({ persisted: true, projected: true, transcript: { size: a.byteLength + b.byteLength, segmentCount: 2 } });
    const settled = { size: a.byteLength + b.byteLength, segment_count: 2 };
    expect(e.sqlite.query(`SELECT size, segment_count FROM transcripts`).get()).toEqual(settled);

    expect((await json(await worker.fetch(memberPost(t.token, evB), e.env))).duplicate).toBe(true);
    expect(e.sqlite.query(`SELECT size, segment_count FROM transcripts`).get()).toEqual(settled);
    expect((await json(await worker.fetch(memberPost(t.token, evA), e.env))).duplicate).toBe(true);
    expect(e.sqlite.query(`SELECT size, segment_count FROM transcripts`).get()).toEqual(settled);
    const foreignReplay = await json(await worker.fetch(memberPost(other.token, evA), e.env));
    expect(foreignReplay).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
    expect(e.sqlite.query(`SELECT size, segment_count FROM transcripts`).get()).toEqual(settled);
    const foreignFresh = await json(await worker.fetch(memberPost(other.token, seg(uuid(603), a.byteLength + b.byteLength, a.byteLength, ka)), e.env));
    expect(foreignFresh).toEqual({ persisted: false, code: 'identity_mismatch', reason: 'machine identity mismatch' });
    expect(e.sqlite.query(`SELECT size, segment_count FROM transcripts`).get()).toEqual(settled);

    const c = utf8('{"c":3}\n');
    const kc = await upload(e, t.token, c);
    expect(await json(await worker.fetch(memberPost(t.token, seg(uuid(602), a.byteLength + b.byteLength, c.byteLength, kc)), e.env)))
      .toEqual({ persisted: true, projected: true, transcript: { size: a.byteLength + b.byteLength + c.byteLength, segmentCount: 3 } });
    expect((e.sqlite.query(`SELECT SUM(length) s FROM transcript_segments`).get() as any).s).toBe(a.byteLength + b.byteLength + c.byteLength);
  });

  it('times a prompt from the earliest response of its machine, and settles session facts from the earliest start, whatever order they arrive in', async () => {
    const events = [
      envelope({ eventId: uuid(700), createdAt: 1_000, kind: 'session.start', payload: { agent: 'claude-code', branch: 'main', startedAt: 1_000 } }),
      envelope({ eventId: uuid(701), createdAt: 2_000, kind: 'session.start', payload: { agent: 'codex', branch: 'other', startedAt: 2_000 } }),
      envelope({ eventId: uuid(702), createdAt: 1_500, payload: { promptId: uuid(710), text: 'q', origin: 'user' } }),
      envelope({ eventId: uuid(703), createdAt: 3_000, kind: 'response', payload: { responseId: uuid(711), promptId: uuid(710), text: 'late' } }),
      envelope({ eventId: uuid(704), createdAt: 2_500, kind: 'response', payload: { responseId: uuid(712), promptId: uuid(710), text: 'early' } }),
      envelope({ eventId: uuid(705), createdAt: 4_000, kind: 'session.end', payload: { endedAt: 4_000 } }),
      envelope({ eventId: uuid(706), createdAt: 3_500, kind: 'session.end', payload: { endedAt: 3_500 } }),
    ];
    const settled = async (order: Record<string, unknown>[]) => {
      const e = sqliteEnv();
      const t = await member(e);
      for (const ev of order) expect((await json(await worker.fetch(memberPost(t.token, ev), e.env))).persisted).toBe(true);
      return {
        session: e.sqlite.query(`SELECT agent, branch, started_at, ended_at FROM sessions`).get(),
        prompt: e.sqlite.query(`SELECT ended_at FROM prompt_batches`).get(),
      };
    };
    const forward = await settled(events);
    expect(forward).toEqual({ session: { agent: 'claude-code', branch: 'main', started_at: 1_000, ended_at: 4_000 }, prompt: { ended_at: 2_500 } });
    expect(await settled([...events].reverse())).toEqual(forward);
  });

  it('projects nothing for an unstored event and re-derives identically when the log is replayed in reverse', async () => {
    const e = sqliteEnv();
    const t = await member(e);
    const events = [
      envelope({ eventId: uuid(200), createdAt: 1_000, kind: 'session.start', payload: { agent: 'claude-code' } }),
      envelope({ eventId: uuid(201), createdAt: 1_100, payload: { promptId: uuid(210), text: 'q', origin: 'user' } }),
      envelope({ eventId: uuid(206), createdAt: 1_150, payload: { promptId: uuid(210), text: 'q', origin: 'user', promptKind: 'user' } }),
      envelope({ eventId: uuid(202), createdAt: 1_200, kind: 'tool.use', payload: { toolCallId: uuid(211), promptId: uuid(210), toolName: 'Read', input: {}, success: true } }),
      envelope({ eventId: uuid(203), createdAt: 1_300, kind: 'response', payload: { responseId: uuid(212), promptId: uuid(210), text: 'a' } }),
      envelope({ eventId: uuid(204), createdAt: 1_400, kind: 'plan', payload: { planKey: uuid(213), content: 'p', tags: ['t'] } }),
      envelope({ eventId: uuid(207), createdAt: 1_450, kind: 'plan', payload: { planKey: uuid(213), content: 'p2', status: 'completed', tags: ['u'] } }),
      envelope({ eventId: uuid(205), createdAt: 1_500, kind: 'session.end', payload: {} }),
    ];
    for (const ev of events) expect((await json(await worker.fetch(memberPost(t.token, ev), e.env))).persisted).toBe(true);
    const snapshot = (env: ReturnType<typeof sqliteEnv>) =>
      ['sessions', 'prompt_batches', 'tool_calls', 'responses', 'plans', 'tags', 'transcripts', 'transcript_segments'].map((table) => env.sqlite.query(`SELECT * FROM ${table}`).all().map((r: any) => { const { received_at, token_id, event_id, first_received_at, last_received_at, created_by_token_id, ...rest } = r; return rest; }));
    expect(e.sqlite.query(`SELECT created_at, updated_at, prompt_kind FROM prompt_batches`).get()).toEqual({ created_at: 1_100, updated_at: 1_150, prompt_kind: 'user' });
    expect(e.sqlite.query(`SELECT created_at, updated_at, content FROM plans`).get()).toEqual({ created_at: 1_400, updated_at: 1_450, content: 'p2' });
    const forward = snapshot(e);
    const e2 = sqliteEnv();
    const t2 = await member(e2);
    for (const ev of [...events].reverse()) expect((await json(await worker.fetch(memberPost(t2.token, ev), e2.env))).persisted).toBe(true);
    for (const ev of events) await worker.fetch(memberPost(t2.token, ev), e2.env);
    expect(snapshot(e2)).toEqual(forward);
    expect(e2.sqlite.query(`SELECT agent, ended_at FROM sessions`).get()).toEqual({ agent: 'claude-code', ended_at: 1_500 });
  });
});
