import { describe, it, expect } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken, MEMBER_TOKEN_MAX_LINEAGE_MS, MEMBER_TOKEN_REFRESH_WINDOW_MS, MEMBER_TOKEN_TTL_MS } from '@myco-server-worker/auth/tokens.js';
import { MAX_BLOB_BYTES, MAX_CLOCK_SKEW_MS, MEMBER_TOKEN_BYTE_QUOTA, PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { MAX_BODY_BYTES } from '@myco-server-worker/ingest/body.js';
import { sha256HexOf, utf8 } from '@myco-server-worker/hash.js';
import { CLASSIFIERS, UNAVAILABLE, type Classifier } from '@myco-server-worker/telemetry.js';
import { ENROLLMENT_TTL_MS, issueEnrollmentAuthority, revokeEnrollmentAuthority } from '@myco-server-worker/auth/enrollment.js';
import { blobPost, envelope, memberHeaders, memberPost, sqliteEnv, uuid } from './helpers/fixtures.js';

const json = async (res: Response) => res.json() as Promise<Record<string, unknown>>;

/** A migrated environment with a member of machine_1, a second member of machine_2 in the same project, and a member without a machine identity. */
async function rig() {
  const e = sqliteEnv();
  const now = Date.now();
  const t1 = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);
  const t2 = await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, now);
  const anonymous = await issueMemberToken(e.db, { memberId: 'mem_anon', machineId: null }, now);
  /** A member of machine_1 whose refresh window is open now. */
  const windowed = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now - (MEMBER_TOKEN_TTL_MS - MEMBER_TOKEN_REFRESH_WINDOW_MS / 2));
  const fetch = (req: Request) => worker.fetch(req, e.env);
  const post = (token: string, over: Record<string, unknown>) => fetch(memberPost(token, envelope(over)));
  const upload = async (bytes: Uint8Array) => {
    const key = await sha256HexOf(bytes);
    expect((await json(await fetch(blobPost(t1.token, key, bytes)))).stored).toBe(true);
    return key;
  };
  /** A transcript segment of `tx` by machine_1. */
  const segment = (n: number, baseOffset: number, blob: string, length: number) =>
    post(t1.token, { eventId: uuid(900 + n), kind: 'transcript.segment', payload: { transcriptId: `tx_${'b'.repeat(32)}`, baseOffset, length, blob } });
  /** Two segments uploaded and the first one stored at offset 0. */
  const transcript = async () => {
    const a = utf8('first-line\n');
    const b = utf8('second\n');
    const ka = await upload(a);
    const kb = await upload(b);
    expect((await json(await segment(0, 0, ka, a.byteLength))).persisted).toBe(true);
    return { a, b, ka, kb };
  };
  /** A join presenting `key`, from a machine of its own so no join can collide with another. */
  const join = (key: string, machineId = 'machine_join') =>
    fetch(new Request('https://s/members/join', { method: 'POST', headers: { 'cf-connecting-ip': '1.2.3.4', 'content-type': 'application/json' }, body: JSON.stringify({ key, machineId }) }));
  return { e, t1, t2, anonymous, windowed, now, fetch, post, upload, segment, transcript, join };
}
type Rig = Awaited<ReturnType<typeof rig>>;

const bytes = utf8('code-bytes');

/** One request per classifier that the deployed entry answers with that code. */
const DRIVERS: Record<Classifier, (r: Rig) => Promise<Response>> = {
  refused: (r) => r.post(r.t1.token, { createdAt: -1 }),
  parse: (r) => r.fetch(memberPost(r.t1.token, 'not json')),
  quota: async (r) => {
    r.e.sqlite.query(`UPDATE member_credentials SET bytes_written = ? WHERE id = ?`).run(MEMBER_TOKEN_BYTE_QUOTA, r.t1.tokenId);
    return r.post(r.t1.token, {});
  },
  body_cap: (r) => r.fetch(memberPost(r.t1.token, 'x'.repeat(MAX_BODY_BYTES + 1))),
  blob_cap: (r) => r.fetch(new Request(`https://s/blobs/${'a'.repeat(64)}`, { method: 'POST', headers: memberHeaders(r.t1.token, { 'content-type': 'text/plain', 'content-length': String(MAX_BLOB_BYTES + 1) }), body: new Uint8Array(8) })),
  content_length: (r) => {
    const body = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array([1])); c.close(); } });
    return r.fetch(new Request(`https://s/blobs/${'a'.repeat(64)}`, { method: 'POST', body, headers: memberHeaders(r.t1.token, { 'content-type': 'text/plain' }), duplex: 'half' } as any));
  },
  media_type: async (r) => r.fetch(blobPost(r.t1.token, await sha256HexOf(bytes), bytes, 'nonsense')),
  digest_mismatch: (r) => r.fetch(blobPost(r.t1.token, 'c'.repeat(64), bytes)),
  empty_body: async (r) => r.fetch(blobPost(r.t1.token, await sha256HexOf(new Uint8Array(0)), new Uint8Array(0))),
  blob_absent: (r) => r.post(r.t1.token, { payload: { promptId: uuid(2), blob: 'd'.repeat(64), origin: 'user' } }),
  offset_gap: async (r) => { const t = await r.transcript(); return r.segment(1, t.a.byteLength + 5, t.kb, t.b.byteLength); },
  offset_overlap: async (r) => { const t = await r.transcript(); return r.segment(2, 0, t.kb, t.b.byteLength); },
  blob_length_mismatch: async (r) => { const t = await r.transcript(); return r.segment(3, t.a.byteLength, t.kb, t.b.byteLength + 1); },
  identity_mismatch: async (r) => {
    expect((await json(await r.post(r.t1.token, {}))).persisted).toBe(true);
    return r.post(r.t2.token, { eventId: uuid(3), payload: { promptId: uuid(4), text: 'theirs', origin: 'user' } });
  },
  no_machine_identity: (r) => r.post(r.anonymous.token, {}),
  no_project: (r) => r.fetch(memberPost(r.t1.token, envelope({}), '/events', { [PROJECT_HEADER]: '' })),
  enrollment_unknown: (r) => r.join('u'.repeat(43)),
  enrollment_used: async (r) => {
    const key = await issueEnrollmentAuthority(r.e.db, r.now);
    expect((await json(await r.join(key.key, 'machine_used'))).joined).toBe(true);
    return r.join(key.key, 'machine_used2');
  },
  enrollment_expired: async (r) => {
    const key = await issueEnrollmentAuthority(r.e.db, r.now - ENROLLMENT_TTL_MS * 2);
    return r.join(key.key, 'machine_expired');
  },
  enrollment_revoked: async (r) => {
    const key = await issueEnrollmentAuthority(r.e.db, r.now);
    expect(await revokeEnrollmentAuthority(r.e.db, key.id, r.now)).toEqual({ revoked: true });
    return r.join(key.key, 'machine_revoked');
  },
  unknown_kind: (r) => r.post(r.t1.token, { kind: 'made.up', payload: {} }),
  unknown_field: (r) => r.post(r.t1.token, { extra: 1 }),
  id_grammar: (r) => r.post(r.t1.token, { eventId: 'not-a-uuid' }),
  clock_skew: (r) => r.post(r.t1.token, { createdAt: Date.now() + MAX_CLOCK_SKEW_MS + 60_000 }),
  event_id_conflict: async (r) => {
    expect((await json(await r.post(r.t1.token, {}))).persisted).toBe(true);
    return r.post(r.t1.token, { payload: { promptId: uuid(2), text: 'other', origin: 'user' } });
  },
  projection_conflict: async (r) => {
    expect((await json(await r.post(r.t1.token, {}))).persisted).toBe(true);
    return r.post(r.t1.token, { eventId: uuid(5), createdAt: 2_000, payload: { promptId: uuid(2), text: 'rewritten', origin: 'user' } });
  },
  refresh_too_early: (r) => r.fetch(memberPost(r.t1.token, '{}', '/tokens/refresh')),
  lineage_expired: (r) => {
    r.e.sqlite.query(`UPDATE member_credentials SET lineage_started_at = expires_at - ? WHERE id = ?`).run(MEMBER_TOKEN_MAX_LINEAGE_MS, r.windowed.tokenId);
    return r.fetch(memberPost(r.windowed.token, '{}', '/tokens/refresh'));
  },
};

describe('refusal codes', () => {
  it('answers every classifier in CLASSIFIERS as the wire code of a refusal through the deployed entry, and no other code; telemetry names the same classifier', async () => {
    expect(Object.keys(DRIVERS).sort()).toEqual([...CLASSIFIERS].sort());
    expect(new Set(CLASSIFIERS).size).toBe(CLASSIFIERS.length);
    const observed: Record<string, unknown>[] = [];
    for (const classifier of CLASSIFIERS) {
      const r = await rig();
      const lines: string[] = [];
      const orig = console.log;
      console.log = (s: string) => { lines.push(s); };
      let res: Response;
      try {
        res = await DRIVERS[classifier](r);
      } finally { console.log = orig; }
      const body = await json(res);
      // Each member route answers under its own key, and the join route under `joined`;
      // a refusal is that key false, never an absent key or a bare error object.
      const refusing = body.persisted === false || body.stored === false || body.refreshed === false || body.projected === false || body.joined === false;
      observed.push({ classifier, status: res.status, code: body.code, refusing, reason: typeof body.reason === 'string' && body.reason.length > 0 });
      const last = JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
      if ('reason' in last) expect({ classifier, telemetry: last.reason }).toEqual({ classifier, telemetry: classifier });
    }
    expect(observed).toEqual(CLASSIFIERS.map((classifier) => ({ classifier, status: 200, code: classifier, refusing: true, reason: true })));
  });

  it('answers a server-side failure on every member route with 503 and the unavailable code, which is not a classifier', async () => {
    expect(CLASSIFIERS).not.toContain(UNAVAILABLE);
    const r = await rig();
    r.e.sqlite.query(`DROP TABLE events`).run();
    const events = await r.post(r.t1.token, {});
    expect({ status: events.status, body: await json(events) }).toEqual({ status: 503, body: { persisted: false, code: UNAVAILABLE, reason: UNAVAILABLE } });
    r.e.sqlite.query(`DROP TABLE blob_reservations`).run();
    const blobs = await r.fetch(blobPost(r.t1.token, await sha256HexOf(bytes), bytes));
    expect({ status: blobs.status, body: await json(blobs) }).toEqual({ status: 503, body: { stored: false, code: UNAVAILABLE, reason: UNAVAILABLE } });
  });
});
