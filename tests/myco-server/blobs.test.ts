import { registerBlob } from './helpers/d1.js';
import { describe, it, expect } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { createServer } from '@myco-server-worker/pipeline.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { BLOB_RESERVATION_TTL_MS, MAX_BLOB_BYTES, MEMBER_TOKEN_BYTE_QUOTA, PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { classifyR2BlobFailure } from '@myco-server-worker/platform/cloudflare/env.js';
import { classifyBlobStore } from '@myco-server-worker/telemetry.js';
import { canonicalMediaType, MAX_MEDIA_TYPE_CHARS } from '@myco-server-worker/ingest/blobs.js';
import { sha256HexOf, utf8 } from '@myco-server-worker/hash.js';
import { blobPost, bytesWritten, count, envelope, journaled, memberHeaders, memberPost, noOutboundFetch, registeredObject, sqliteEnv } from './helpers/fixtures.js';
import { drainObjectReleases } from '@myco-server-worker/core/object-release.js';
import { GENERATION_GRAMMAR } from '@myco-server-worker/core/blob-objects.js';

const json = async (res: Response) => res.json() as Promise<Record<string, unknown>>;
const bytes = utf8('hello blob');
const keyOf = (b: Uint8Array<ArrayBuffer>) => sha256HexOf(b);
const blobRow = (e: ReturnType<typeof sqliteEnv>, key: string) => e.sqlite.query(`SELECT size, media_type, token_id FROM blobs WHERE key = ?`).get(key);
/** Leaves `remaining` bytes of the token's quota unspent by recording a stored blob of the rest, charging the token for it as the store path would. */
const fillQuota = (e: ReturnType<typeof sqliteEnv>, tokenId: string, remaining: number) => {
  const size = MEMBER_TOKEN_BYTE_QUOTA - remaining;
  registerBlob(e.sqlite, { projectId: 'proj_1', key: 'f'.repeat(64), size, mediaType: 'text/plain; charset=utf-8', tokenId, receivedAt: 0 });
  e.sqlite.query(`UPDATE member_credentials SET bytes_written = ? WHERE id = ?`).run(size, tokenId);
};
const reservations = (e: ReturnType<typeof sqliteEnv>) => count(e.sqlite, 'blob_reservations');
/** Leaves `remaining` bytes unspent by event traffic alone: the counter the quota CHECK enforces moves with no blobs row behind it. */
const fillQuotaFromEvents = (e: ReturnType<typeof sqliteEnv>, tokenId: string, remaining: number) =>
  e.sqlite.query(`UPDATE member_credentials SET bytes_written = ? WHERE id = ?`).run(MEMBER_TOKEN_BYTE_QUOTA - remaining, tokenId);
const storedSum = (e: ReturnType<typeof sqliteEnv>, tokenId: string) =>
  (e.sqlite.query(`SELECT COALESCE(SUM(size),0) s FROM blobs WHERE token_id = ?`).get(tokenId) as { s: number }).s;

let racedKey = '';
/** Runs the only store deleter until its journal is empty. */
const drain = async (e: ReturnType<typeof sqliteEnv>) => { while (count(e.sqlite, 'object_releases') > 0) await drainObjectReleases(e.serverEnv, Date.now()); };
/** A request declaring `declared` bytes whose body carries `body`. */
const declaring = (token: string, key: string, body: Uint8Array<ArrayBuffer>, declared: number) => new Request(`https://s/blobs/${key}`, {
  method: 'POST',
  headers: memberHeaders(token, { 'content-type': 'text/plain; charset=utf-8', 'content-length': String(declared) }),
  body,
});

describe('blob route', () => {
  it('canonicalizes media types and refuses anything outside the RFC 7231 grammar', () => {
    expect(canonicalMediaType('text/plain; charset=utf-8')).toBe('text/plain; charset=utf-8');
    expect(canonicalMediaType('Text/Plain;charset=UTF-8')).toBe('text/plain; charset=utf-8');
    expect(canonicalMediaType('image/png')).toBe('image/png');
    expect(canonicalMediaType('text/plain')).toBe('text/plain; charset=utf-8');
    expect(canonicalMediaType('application/vnd.api+json; version="2"')).toBe('application/vnd.api+json; version=2');
    expect(canonicalMediaType('application/vnd.api+json; profile="a b"')).toBe('application/vnd.api+json; profile=a b');
    // A quoted value carrying a separator is refused: a canonical form must not re-parse as more parameters than it had.
    for (const bad of [null, '', 'text', 'text/', '/plain', 'text/plain; charset', 'text/plain; =x', 'text plain', `text/${'a'.repeat(MAX_MEDIA_TYPE_CHARS)}`, 'text/plain; charset=utf-8; a=b; c=<', 'text/plain; name="a;b"', 'text/plain; charset=utf-8; name="x=y"', 'text/plain; name="a\r\nb"']) {
      expect({ bad, canonical: canonicalMediaType(bad) }).toEqual({ bad, canonical: null });
    }
  });

  it('stores bytes under their own generation, records the row with the stored size and that generation, and charges the token', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const key = await keyOf(bytes);
    const res = await worker.fetch(blobPost(t.token, key, bytes, 'Text/Plain; charset=UTF-8'), e.env);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ stored: true, duplicate: false, key, size: bytes.byteLength, mediaType: 'text/plain; charset=utf-8' });
    expect(blobRow(e, key)).toEqual({ size: bytes.byteLength, media_type: 'text/plain; charset=utf-8', token_id: t.tokenId });
    const { generation } = e.sqlite.query(`SELECT generation FROM blobs WHERE key = ?`).get(key) as { generation: string };
    expect(generation).toMatch(GENERATION_GRAMMAR);
    expect(registeredObject(e.sqlite, 'proj_1', key)).toBe(`proj_1/${key}~${generation}`);
    expect(e.bucket.puts).toEqual([`proj_1/${key}~${generation}`]);
    expect(e.bucket.objects.get(`proj_1/${key}~${generation}`)).toEqual({ size: bytes.byteLength, contentType: 'text/plain; charset=utf-8', bytes });
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(bytes.byteLength);
    expect(journaled(e.sqlite)).toEqual([]);
  });

  it('reserves the quota before any store write: at quota no object is written and nothing is charged', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    fillQuota(e, t.tokenId, bytes.byteLength - 1);
    const key = await keyOf(bytes);
    const res = await worker.fetch(blobPost(t.token, key, bytes), e.env);
    expect(await json(res)).toEqual({ stored: false, code: 'quota', reason: 'token write quota exceeded' });
    expect(e.bucket.puts).toEqual([]);
    expect(count(e.sqlite, 'blobs')).toBe(1);
    expect(reservations(e)).toBe(0);
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(storedSum(e, t.tokenId));
  });

  it('refuses a blob against a quota already spent on event bodies, before any byte reaches the store', async () => {
    // Admission must read the column the CHECK enforces. `bytes_written` counts event bodies as well as blobs, so a
    // token at the ceiling from event traffic alone has no blobs row to sum: an admission over `blobs.size` admits it.
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    expect(await json(await worker.fetch(memberPost(t.token, envelope()), e.env))).toMatchObject({ persisted: true });
    expect(bytesWritten(e.sqlite, t.tokenId)).toBeGreaterThan(0);
    expect(storedSum(e, t.tokenId)).toBe(0);

    fillQuotaFromEvents(e, t.tokenId, bytes.byteLength - 1);
    const key = await keyOf(bytes);
    const res = await worker.fetch(blobPost(t.token, key, bytes), e.env);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ stored: false, code: 'quota', reason: 'token write quota exceeded' });
    expect(e.bucket.puts).toEqual([]);
    expect(count(e.sqlite, 'blobs')).toBe(0);
    expect(reservations(e)).toBe(0);
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(MEMBER_TOKEN_BYTE_QUOTA - bytes.byteLength + 1);
  });

  it('answers a quota violation raised by the charge itself terminally, never as a retryable failure', async () => {
    // Between admission and the batch the token can be charged by another request; the CHECK then rejects this one's
    // charge. The caller must be told its own request will never succeed, not handed a 503 it is expected to retry.
    const e = sqliteEnv({
      onSql: (sql, sqlite) => {
        if (/^INSERT INTO blobs\b/.test(sql)) sqlite.query(`UPDATE member_credentials SET bytes_written = ?`).run(MEMBER_TOKEN_BYTE_QUOTA);
      },
    });
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const key = await keyOf(bytes);
    const res = await worker.fetch(blobPost(t.token, key, bytes), e.env);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ stored: false, code: 'quota', reason: 'token write quota exceeded' });
    expect(count(e.sqlite, 'blobs')).toBe(0);
    expect(reservations(e)).toBe(0);
  });

  it('never takes bytes it did not put: an object already under the content\'s name is left alone, and the upload stores and charges its own', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const key = await keyOf(bytes);
    e.bucket.seed(`proj_1/${key}`, { size: bytes.byteLength, contentType: 'text/plain; charset=utf-8', bytes });
    const res = await worker.fetch(declaring(t.token, key, bytes, 1), e.env);
    expect(await json(res)).toEqual({ stored: true, duplicate: false, key, size: bytes.byteLength, mediaType: 'text/plain; charset=utf-8' });
    const object = registeredObject(e.sqlite, 'proj_1', key)!;
    expect(object).not.toBe(`proj_1/${key}`);
    expect(e.bucket.puts).toEqual([object]);
    expect(e.bucket.heads).toEqual([]);
    // The size charged is the size the store recorded for this upload's own bytes, not the length it declared.
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(bytes.byteLength);
    expect((blobRow(e, key) as { size: number }).size).toBe(bytesWritten(e.sqlite, t.tokenId));
    expect(e.bucket.objects.has(`proj_1/${key}`)).toBe(true);
    expect(journaled(e.sqlite)).toEqual([]);
  });

  it('answers a duplicate and journals its own bytes when another writer registers the content first, releasing the reconciled reservation uncharged', async () => {
    let raced = false;
    const e = sqliteEnv({
      onSql: (sql, sqlite) => {
        if (!/^INSERT INTO blobs\b/.test(sql) || raced) return;
        raced = true;
        registerBlob(sqlite, { projectId: 'proj_1', key: racedKey, size: bytes.byteLength, mediaType: 'text/plain; charset=utf-8', tokenId: 'other', receivedAt: 0 });
      },
    });
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const key = await keyOf(bytes);
    racedKey = key;
    const res = await worker.fetch(declaring(t.token, key, bytes, 1), e.env);
    expect(await json(res)).toEqual({ stored: true, duplicate: true, key, size: bytes.byteLength, mediaType: 'text/plain; charset=utf-8' });
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(0);
    expect(reservations(e)).toBe(0);
    const own = e.bucket.puts[0]!;
    expect(journaled(e.sqlite)).toEqual([own]);
    await drain(e);
    expect(e.bucket.deletes).toEqual([own]);
    expect(blobRow(e, key)).toEqual({ size: bytes.byteLength, media_type: 'text/plain; charset=utf-8', token_id: 'other' });
  });

  it('refuses at reconcile when the size the store recorded would carry the token past its quota, charging nothing and journaling its own bytes', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const key = await keyOf(bytes);
    fillQuota(e, t.tokenId, bytes.byteLength - 1);
    const res = await worker.fetch(declaring(t.token, key, bytes, 1), e.env);
    expect(await json(res)).toEqual({ stored: false, code: 'quota', reason: 'token write quota exceeded' });
    expect(count(e.sqlite, 'blobs')).toBe(1);
    expect(reservations(e)).toBe(0);
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(storedSum(e, t.tokenId));
    expect(journaled(e.sqlite)).toEqual(e.bucket.puts);
    await drain(e);
    expect(e.bucket.objects.size).toBe(0);
  });

  it('admits exactly one of two in-flight uploads at the quota edge', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    fillQuota(e, t.tokenId, bytes.byteLength);
    const other = utf8('other blob');
    const [a, b] = await Promise.all([
      worker.fetch(blobPost(t.token, await keyOf(bytes), bytes), e.env),
      worker.fetch(blobPost(t.token, await keyOf(other), other), e.env),
    ]);
    const outcomes = [await json(a), await json(b)].map((r) => r.stored);
    expect(outcomes.filter(Boolean).length).toBe(1);
    expect(e.bucket.puts.length).toBe(1);
    expect(reservations(e)).toBe(0);
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(MEMBER_TOKEN_BYTE_QUOTA);
  });

  it('holds an event against a live reservation: an event posted while an upload is in flight is refused at admission when the two would not both fit, the upload lands, and no object is left without a row', async () => {
    // Two writers move one counter. The event's admission counts the reservation the upload holds, so the upload
    // never streams into the store only to be refused at its row.
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const event = envelope();
    const eventBytes = utf8(JSON.stringify(event)).byteLength;
    fillQuotaFromEvents(e, t.tokenId, bytes.byteLength + eventBytes - 1);
    const key = await keyOf(bytes);
    // Held behind a property: the answer lands inside the store's own call, and
    // a bare binding reads as its initializer at every site after it.
    const interleaved: { answer: Record<string, unknown> | null } = { answer: null };
    const put = e.bucket.put.bind(e.bucket);
    e.bucket.put = async (objectKey, value, options) => {
      if (interleaved.answer === null) interleaved.answer = await json(await worker.fetch(memberPost(t.token, event), e.env));
      return put(objectKey, value, options);
    };
    const upload = await json(await worker.fetch(blobPost(t.token, key, bytes), e.env));
    expect(interleaved.answer).toEqual({ persisted: false, code: 'quota', reason: 'token write quota exceeded' });
    expect(upload).toEqual({ stored: true, duplicate: false, key, size: bytes.byteLength, mediaType: 'text/plain; charset=utf-8' });
    expect(count(e.sqlite, 'events')).toBe(0);
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(MEMBER_TOKEN_BYTE_QUOTA - eventBytes + 1);
    expect(reservations(e)).toBe(0);
    const rowed = new Set([registeredObject(e.sqlite, 'proj_1', key)]);
    expect([...e.bucket.objects.keys()].filter((k) => !rowed.has(k))).toEqual([]);
    expect(await json(await worker.fetch(memberPost(t.token, event), e.env))).toEqual({ persisted: false, code: 'quota', reason: 'token write quota exceeded' });
  });

  it('holds a second upload in flight to the size the first stored, not the length it declared: the second is refused at admission, before any byte reaches the store', async () => {
    // A reservation is moved to the size the store recorded before the row lands, so a concurrent upload at the
    // edge is admitted against what this one will charge.
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const other = utf8('other blob');
    fillQuotaFromEvents(e, t.tokenId, bytes.byteLength + other.byteLength - 1);
    const key = await keyOf(bytes);
    // Held behind a property: the answer lands inside the statement double, and
    // a bare binding reads as its initializer at every site after it.
    const inflight: { answer: Record<string, unknown> | null } = { answer: null };
    let fired = false;
    const db = e.env.MYCO_DB;
    e.env.MYCO_DB = {
      ...db,
      prepare: (sql: string) => {
        const statement = db.prepare(sql);
        if (!/^UPDATE blob_reservations SET size/.test(sql) || fired) return statement;
        return {
          ...statement,
          bind: (...params: unknown[]) => {
            const bound = statement.bind(...params);
            return { ...bound, run: async () => { const moved = await bound.run(); if (!fired) { fired = true; inflight.answer = await json(await worker.fetch(blobPost(t.token, await keyOf(other), other), e.env)); } return moved; } };
          },
        };
      },
    };
    const first = await json(await worker.fetch(declaring(t.token, key, bytes, 1), e.env));
    expect(inflight.answer).toEqual({ stored: false, code: 'quota', reason: 'token write quota exceeded' });
    expect(first).toEqual({ stored: true, duplicate: false, key, size: bytes.byteLength, mediaType: 'text/plain; charset=utf-8' });
    expect(e.bucket.puts).toEqual([registeredObject(e.sqlite, 'proj_1', key)!]);
    expect(count(e.sqlite, 'blobs')).toBe(1);
    expect(reservations(e)).toBe(0);
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(MEMBER_TOKEN_BYTE_QUOTA - other.byteLength + 1);
  });

  it('refuses an upload that outlives its reservation when the room was taken while the body streamed, and journals the object it put so the drain deletes it', async () => {
    // The reconcile is the late admission point: a request whose reservation expired mid-stream is re-admitted there
    // against the room that remains, and a refusal journals the object this request put — a terminal refusal never
    // leaves an object that neither a row nor the journal names.
    const e = sqliteEnv();
    let now = 10_000;
    const server = createServer({ now: () => now, sourceOf: () => '1.2.3.4', fetchImpl: noOutboundFetch });
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);
    const key = await keyOf(bytes);
    const event = envelope();
    const eventBytes = utf8(JSON.stringify(event)).byteLength;
    fillQuotaFromEvents(e, t.tokenId, bytes.byteLength + eventBytes - 1);
    // Held behind a property: the answer lands inside the double the route calls,
    // and a bare binding reads as its initializer at every site after it.
    const during: { answer: Record<string, unknown> | null } = { answer: null };
    const putReal = e.bucket.put.bind(e.bucket);
    e.bucket.put = async (k, v, o) => {
      now += BLOB_RESERVATION_TTL_MS + 1;
      during.answer = await json(await server.handleRequest(memberPost(t.token, event), e.serverEnv));
      return putReal(k, v, o);
    };
    const res = await json(await server.handleRequest(blobPost(t.token, key, bytes), e.serverEnv));
    expect(during.answer).toEqual({ persisted: true, projected: true });
    expect(res).toEqual({ stored: false, code: 'quota', reason: 'token write quota exceeded' });
    expect(journaled(e.sqlite)).toEqual(e.bucket.puts);
    await drain(e);
    expect(e.bucket.deletes).toEqual(e.bucket.puts);
    expect(e.bucket.objects.size).toBe(0);
    expect(count(e.sqlite, 'blobs')).toBe(0);
    expect(reservations(e)).toBe(0);
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(MEMBER_TOKEN_BYTE_QUOTA - bytes.byteLength + 1);
  });

  it('holds a reconciled reservation for a fresh TTL: an event arriving after the original expiry is refused against it, and the upload lands', async () => {
    const e = sqliteEnv();
    let now = 10_000;
    const server = createServer({ now: () => now, sourceOf: () => '1.2.3.4', fetchImpl: noOutboundFetch });
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);
    const key = await keyOf(bytes);
    const event = envelope();
    const eventBytes = utf8(JSON.stringify(event)).byteLength;
    fillQuotaFromEvents(e, t.tokenId, bytes.byteLength + eventBytes - 1);
    const putReal = e.bucket.put.bind(e.bucket);
    e.bucket.put = async (k, v, o) => { now += BLOB_RESERVATION_TTL_MS + 1; return putReal(k, v, o); };
    // Held behind a property: the answer lands inside the double the route calls,
    // and a bare binding reads as its initializer at every site after it.
    const during: { answer: Record<string, unknown> | null } = { answer: null };
    let fired = false;
    const db = e.env.MYCO_DB;
    e.env.MYCO_DB = {
      ...db,
      prepare: (sql: string) => {
        const statement = db.prepare(sql);
        if (!/^UPDATE blob_reservations SET size/.test(sql) || fired) return statement;
        return {
          ...statement,
          bind: (...params: unknown[]) => {
            const bound = statement.bind(...params);
            return { ...bound, run: async () => { const moved = await bound.run(); if (!fired) { fired = true; during.answer = await json(await server.handleRequest(memberPost(t.token, event), e.serverEnv)); } return moved; } };
          },
        };
      },
    };
    const res = await json(await server.handleRequest(blobPost(t.token, key, bytes), e.serverEnv));
    expect(during.answer).toEqual({ persisted: false, code: 'quota', reason: 'token write quota exceeded' });
    expect(res).toEqual({ stored: true, duplicate: false, key, size: bytes.byteLength, mediaType: 'text/plain; charset=utf-8' });
    expect(count(e.sqlite, 'events')).toBe(0);
    expect(count(e.sqlite, 'blobs')).toBe(1);
    expect(reservations(e)).toBe(0);
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(MEMBER_TOKEN_BYTE_QUOTA - eventBytes + 1);
  });

  it('refuses as retryable, and never registers, an upload paused past its authority after its bytes landed: the drain consumed the authority and deleted exactly those bytes, and the retry stores a fresh generation', async () => {
    const e = sqliteEnv();
    let now = 10_000;
    const server = createServer({ now: () => now, sourceOf: () => '1.2.3.4', fetchImpl: noOutboundFetch });
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);
    const key = await keyOf(bytes);
    const put = e.bucket.put.bind(e.bucket);
    let paused = false;
    e.bucket.put = async (objectKey, value, options) => {
      const stored = await put(objectKey, value, options);
      if (!paused) {
        paused = true;
        now += BLOB_RESERVATION_TTL_MS + 1;
        await drainObjectReleases(e.serverEnv, now);
      }
      return stored;
    };
    const first = await server.handleRequest(blobPost(t.token, key, bytes), e.serverEnv);
    expect(first.status).toBe(503);
    expect(await json(first)).toEqual({ stored: false, code: 'unavailable', reason: 'unavailable' });
    const abandoned = e.bucket.puts[0]!;
    expect(e.bucket.deletes).toEqual([abandoned]);
    expect([count(e.sqlite, 'blobs'), reservations(e), bytesWritten(e.sqlite, t.tokenId)]).toEqual([0, 0, 0]);
    expect(journaled(e.sqlite)).toEqual([]);

    expect(await json(await server.handleRequest(blobPost(t.token, key, bytes), e.serverEnv)))
      .toEqual({ stored: true, duplicate: false, key, size: bytes.byteLength, mediaType: 'text/plain; charset=utf-8' });
    const registered = registeredObject(e.sqlite, 'proj_1', key)!;
    expect(registered).not.toBe(abandoned);
    expect(e.bucket.objects.has(registered)).toBe(true);
  });

  it('refuses as retryable an upload whose reconciled authority expires and is consumed before its registration commits, leaving no row without its bytes', async () => {
    const e = sqliteEnv();
    let now = 10_000;
    const server = createServer({ now: () => now, sourceOf: () => '1.2.3.4', fetchImpl: noOutboundFetch });
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);
    const key = await keyOf(bytes);
    let fired = false;
    const db = e.env.MYCO_DB;
    e.env.MYCO_DB = {
      ...db,
      prepare: (sql: string) => {
        const statement = db.prepare(sql);
        if (!/^UPDATE blob_reservations SET size/.test(sql) || fired) return statement;
        return {
          ...statement,
          bind: (...params: unknown[]) => {
            const bound = statement.bind(...params);
            return { ...bound, run: async () => {
              const moved = await bound.run();
              fired = true;
              now += BLOB_RESERVATION_TTL_MS + 1;
              await drainObjectReleases(e.serverEnv, now);
              return moved;
            } };
          },
        };
      },
    };
    const res = await server.handleRequest(blobPost(t.token, key, bytes), e.serverEnv);
    expect(res.status).toBe(503);
    expect(e.bucket.deletes).toEqual(e.bucket.puts);
    expect([count(e.sqlite, 'blobs'), reservations(e), bytesWritten(e.sqlite, t.tokenId)]).toEqual([0, 0, 0]);
  });

  it('keeps a completed upload through a whole acknowledged deletion of another upload of the same content: each deletes only its own generation', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const other = await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, Date.now());
    fillQuota(e, other.tokenId, 1);
    const key = await keyOf(bytes);
    const put = e.bucket.put.bind(e.bucket);
    const refused: { answer: Record<string, unknown> | null } = { answer: null };
    e.bucket.put = async (objectKey, value, options) => {
      const stored = await put(objectKey, value, options);
      if (refused.answer === null) {
        // This upload's bytes have landed and it has not registered. Another upload of the same bytes stores its own
        // copy, is refused at reconcile, and its clean-up is deleted and acknowledged before this one resumes.
        refused.answer = await json(await worker.fetch(declaring(other.token, key, bytes, 1), e.env));
        await drain(e);
      }
      return stored;
    };
    const res = await json(await worker.fetch(blobPost(t.token, key, bytes), e.env));
    expect(refused.answer).toEqual({ stored: false, code: 'quota', reason: 'token write quota exceeded' });
    expect(res).toEqual({ stored: true, duplicate: false, key, size: bytes.byteLength, mediaType: 'text/plain; charset=utf-8' });
    const [own, theirs] = e.bucket.puts;
    expect(e.bucket.deletes).toEqual([theirs!]);
    expect(registeredObject(e.sqlite, 'proj_1', key)).toBe(own!);
    expect(e.bucket.objects.get(own!)?.bytes).toEqual(bytes);
  });

  it('keeps what another writer registered while this refused upload was in flight: the refusal journals only its own generation', async () => {
    let raced = false;
    let tokenId = '';
    const e = sqliteEnv({
      onSql: (sql, sqlite) => {
        if (!/^UPDATE blob_reservations SET size/.test(sql) || raced) return;
        raced = true;
        registerBlob(sqlite, { projectId: 'proj_1', key: racedKey, size: bytes.byteLength, mediaType: 'text/plain; charset=utf-8', tokenId: 'other', receivedAt: 0 });
        sqlite.query(`UPDATE member_credentials SET bytes_written = ? WHERE id = ?`).run(MEMBER_TOKEN_BYTE_QUOTA, tokenId);
      },
    });
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    tokenId = t.tokenId;
    const key = await keyOf(bytes);
    racedKey = key;
    const res = await json(await worker.fetch(blobPost(t.token, key, bytes), e.env));
    expect(res).toEqual({ stored: false, code: 'quota', reason: 'token write quota exceeded' });
    const own = e.bucket.puts[0]!;
    expect(own).not.toBe(registeredObject(e.sqlite, 'proj_1', key));
    expect(journaled(e.sqlite)).toEqual([own]);
    await drain(e);
    expect(e.bucket.deletes).toEqual([own]);
    expect(blobRow(e, key)).toEqual({ size: bytes.byteLength, media_type: 'text/plain; charset=utf-8', token_id: 'other' });
    expect(reservations(e)).toBe(0);
  });

  it('leaves no permanent charge on any fault between reserving and recording, and never counts an expired reservation', async () => {
    // Every fault between the reservation and the row must leave the token's quota exactly where it started.
    // The reservation is a row, not a counter, so a request that dies before recording cannot subtract what it
    // never added; a reservation that outlives its request stops counting when it expires.
    const faults: { name: string; boom: (sql: string) => boolean; bucket?: boolean }[] = [
      { name: 'reserve throws', boom: (sql) => sql.startsWith('INSERT INTO blob_reservations') },
      { name: 'put throws', boom: () => false, bucket: true },
      { name: 'row throws', boom: (sql) => sql.startsWith('INSERT INTO blobs') },
      { name: 'release throws', boom: (sql) => /^DELETE FROM blob_reservations WHERE reservation_id = \?/.test(sql) },
      // The sweep is keyed on the credential, matching what the quota counts.
      { name: 'expiry sweep throws', boom: (sql) => /^DELETE FROM blob_reservations WHERE reservation_id IN \(SELECT reservation_id FROM blob_reservations WHERE token_id/.test(sql) },
    ];
    for (const fault of faults) {
      const e = sqliteEnv({ onSql: (sql) => { if (fault.boom(sql)) throw new Error('D1_ERROR: induced'); } });
      const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
      if (fault.bucket) e.bucket.put = () => { throw new Error('induced store failure'); };
      const before = bytesWritten(e.sqlite, t.tokenId);
      const res = await worker.fetch(blobPost(t.token, await keyOf(bytes), bytes), e.env);
      expect({ fault: fault.name, ok: res.status === 200 || res.status === 503 }).toEqual({ fault: fault.name, ok: true });
      expect({ fault: fault.name, charged: bytesWritten(e.sqlite, t.tokenId) }).toEqual({ fault: fault.name, charged: before });
      expect({ fault: fault.name, charged: bytesWritten(e.sqlite, t.tokenId) }).toEqual({ fault: fault.name, charged: storedSum(e, t.tokenId) });
    }

    // A reservation left behind by a request that never returned holds the quota only until it expires.
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    e.sqlite.query(`INSERT INTO blob_reservations (reservation_id, project_id, key, token_id, size, expires_at) VALUES ('abandoned', 'proj_1', ?, ?, ?, ?)`)
      .run('a'.repeat(64), t.tokenId, MEMBER_TOKEN_BYTE_QUOTA, Date.now() - 1);
    const res = await worker.fetch(blobPost(t.token, await keyOf(bytes), bytes), e.env);
    expect(await json(res)).toEqual({ stored: true, duplicate: false, key: await keyOf(bytes), size: bytes.byteLength, mediaType: 'text/plain; charset=utf-8' });
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(storedSum(e, t.tokenId));
  });

  it('consumes every expired reservation of the token as it reserves, journaling the bytes of each, and keeps the live ones', async () => {
    // A request that dies between reserving and recording leaves its row behind. The row stops counting at its expiry,
    // and the next reservation consumes it, so the table is bounded by the requests in flight, not by the faults seen.
    // Its bytes may have landed under its generation, so they are journaled for the drain in the same transaction.
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const other = await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, Date.now());
    const dead = [1, 2, 3].map(() => crypto.randomUUID());
    const seed = (id: string, tokenId: string, expiresAt: number) =>
      e.sqlite.query(`INSERT INTO blob_reservations (reservation_id, project_id, key, token_id, size, expires_at) VALUES (?, 'proj_1', ?, ?, 1, ?)`)
        .run(id, 'a'.repeat(64), tokenId, expiresAt);
    dead.forEach((id, n) => seed(id, t.tokenId, Date.now() - n - 1));
    seed('live', t.tokenId, Date.now() + BLOB_RESERVATION_TTL_MS);
    seed('other-dead', other.tokenId, Date.now() - 1);
    expect(reservations(e)).toBe(5);

    const res = await worker.fetch(blobPost(t.token, await keyOf(bytes), bytes), e.env);
    expect((await json(res)).stored).toBe(true);
    expect(e.sqlite.query(`SELECT reservation_id FROM blob_reservations ORDER BY reservation_id`).all())
      .toEqual([{ reservation_id: 'live' }, { reservation_id: 'other-dead' }]);
    expect(journaled(e.sqlite)).toEqual(dead.map((id) => `proj_1/${'a'.repeat(64)}~${id}`).sort());
  });

  it('holds stored bytes to the blob ceiling, so a store that answers with more than the route admits charges nothing and journals the bytes', async () => {
    // The route caps the length the caller declares. The store measures what it stored, and the same ceiling
    // decides whether it may be registered.
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const key = await keyOf(bytes);
    const put = e.bucket.put.bind(e.bucket);
    e.bucket.put = async (objectKey, value, options) => { await put(objectKey, value, options); return { size: MAX_BLOB_BYTES + 1 }; };
    const res = await worker.fetch(blobPost(t.token, key, bytes), e.env);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ stored: false, code: 'blob_cap', reason: `blob exceeds ${MAX_BLOB_BYTES} bytes` });
    expect(count(e.sqlite, 'blobs')).toBe(0);
    expect(reservations(e)).toBe(0);
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(0);
    expect(journaled(e.sqlite)).toEqual(e.bucket.puts);
  });

  it('answers a repeated upload as a duplicate from the blobs row, uncharged, without writing and without consulting the store', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const t3 = await issueMemberToken(e.db, { memberId: 'mem_machine_3', machineId: 'machine_3' }, Date.now());
    const key = await keyOf(bytes);
    await worker.fetch(blobPost(t.token, key, bytes), e.env);
    const again = await worker.fetch(blobPost(t3.token, key, bytes, 'image/png'), e.env);
    expect(await json(again)).toEqual({ stored: true, duplicate: true, key, size: bytes.byteLength, mediaType: 'text/plain; charset=utf-8' });
    expect(e.bucket.puts).toEqual([registeredObject(e.sqlite, 'proj_1', key)!]);
    expect(e.bucket.heads).toEqual([]);
    expect(journaled(e.sqlite)).toEqual([]);
    expect(bytesWritten(e.sqlite, t3.tokenId)).toBe(0);
    expect(blobRow(e, key)).toEqual({ size: bytes.byteLength, media_type: 'text/plain; charset=utf-8', token_id: t.tokenId });
  });


  it('releases the reservation when the row cannot be written, so a failing upload never consumes the quota', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const key = await keyOf(bytes);
    e.sqlite.query(`DROP TABLE blobs`).run();
    const res = await worker.fetch(blobPost(t.token, key, bytes), e.env);
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ stored: false, code: 'unavailable', reason: 'unavailable' });
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(0);
  });

  it('refuses a digest mismatch terminally, writing no object and no row and releasing the reservation', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const wrongKey = await keyOf(utf8('not these bytes'));
    const res = await worker.fetch(blobPost(t.token, wrongKey, bytes), e.env);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ stored: false, code: 'digest_mismatch', reason: 'digest mismatch' });
    expect(e.bucket.objects.size).toBe(0);
    expect(count(e.sqlite, 'blobs')).toBe(0);
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(0);
    e.bucket.failNextPut = 'put: The SHA-256 checksum you specified did not match what we received. (10037)';
    const key = await keyOf(bytes);
    expect(await json(await worker.fetch(blobPost(t.token, key, bytes), e.env))).toEqual({ stored: false, code: 'digest_mismatch', reason: 'digest mismatch' });
    e.bucket.failNextPut = 'R2 put failed (10037)';
    expect(await json(await worker.fetch(blobPost(t.token, key, bytes), e.env))).toEqual({ stored: false, code: 'digest_mismatch', reason: 'digest mismatch' });
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(0);
    // The R2 error code is Cloudflare's to recognise, not the shared classifier's:
    // shared code matches the digest TEXT, the adapter matches the CODE.
    expect(classifyBlobStore(new Error('anything (10037)'))).toBe('other');
    expect(classifyBlobStore(new Error('anything (10037)'), classifyR2BlobFailure)).toBe('digest');
    expect(classifyBlobStore(new Error('put: length of the provided value does not match the declared length'))).toBe('other');
  });

  it('answers any other store failure with 503, journals the generation a put that threw may still have written, and the retry stores under a fresh one', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const key = await keyOf(bytes);
    e.bucket.failNextPut = 'R2 is having a moment';
    const res = await worker.fetch(blobPost(t.token, key, bytes), e.env);
    expect(res.status).toBe(503);
    expect(await json(res)).toEqual({ stored: false, code: 'unavailable', reason: 'unavailable' });
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(0);
    expect(journaled(e.sqlite)).toEqual([e.bucket.puts[0]!]);
    expect(reservations(e)).toBe(0);
    expect(await json(await worker.fetch(blobPost(t.token, key, bytes), e.env))).toEqual({ stored: true, duplicate: false, key, size: bytes.byteLength, mediaType: 'text/plain; charset=utf-8' });
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(bytes.byteLength);
    expect(registeredObject(e.sqlite, 'proj_1', key)).toBe(e.bucket.puts[1]);
    expect(e.bucket.puts[1]).not.toBe(e.bucket.puts[0]);
  });

  it('answers a duplicate upload with the stored media type, so a member presenting another type learns which one the row carries; a bare text/plain is text/plain; charset=utf-8', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const key = await keyOf(bytes);
    expect(await json(await worker.fetch(blobPost(t.token, key, bytes, 'text/plain'), e.env))).toEqual({ stored: true, duplicate: false, key, size: bytes.byteLength, mediaType: 'text/plain; charset=utf-8' });
    expect(await json(await worker.fetch(blobPost(t.token, key, bytes, 'application/octet-stream'), e.env))).toEqual({ stored: true, duplicate: true, key, size: bytes.byteLength, mediaType: 'text/plain; charset=utf-8' });
    expect((e.sqlite.query(`SELECT media_type FROM blobs`).get() as any).media_type).toBe('text/plain; charset=utf-8');
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(bytes.byteLength);
  });

  it('refuses an empty body before reserving', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const empty = new Uint8Array(0);
    expect(await json(await worker.fetch(blobPost(t.token, await keyOf(empty), empty), e.env))).toEqual({ stored: false, code: 'empty_body', reason: 'empty body' });
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(0);
    expect(e.bucket.puts).toEqual([]);
  });

  it('refuses an invalid content-type before reserving, and requires content-length and the cap before the body', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const key = await keyOf(bytes);
    expect(await json(await worker.fetch(blobPost(t.token, key, bytes, 'nonsense'), e.env))).toEqual({ stored: false, code: 'media_type', reason: 'invalid content-type' });
    expect(bytesWritten(e.sqlite, t.tokenId)).toBe(0);
    const noType = new Request(`https://s/blobs/${key}`, { method: 'POST', headers: memberHeaders(t.token, { 'content-length': String(bytes.byteLength) }), body: bytes });
    noType.headers.delete('content-type');
    expect(await json(await worker.fetch(noType, e.env))).toEqual({ stored: false, code: 'media_type', reason: 'invalid content-type' });
    const big = new Request(`https://s/blobs/${key}`, { method: 'POST', headers: memberHeaders(t.token, { 'content-type': 'text/plain', 'content-length': String(MAX_BLOB_BYTES + 1) }), body: bytes });
    expect(await json(await worker.fetch(big, e.env))).toEqual({ stored: false, code: 'blob_cap', reason: `blob exceeds ${MAX_BLOB_BYTES} bytes` });
    expect(e.bucket.puts).toEqual([]);
  });

  it('scopes blobs by project: the same bytes uploaded under two projects are two rows and two objects', async () => {
    const e = sqliteEnv();
    const t1 = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const t2 = await issueMemberToken(e.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, Date.now());
    const key = await keyOf(bytes);
    // The Project comes from the request, not the credential: the second upload has to
    // name proj_2 explicitly, or both land in the same Project and the second is a duplicate.
    expect((await json(await worker.fetch(blobPost(t1.token, key, bytes), e.env))).duplicate).toBe(false);
    expect((await json(await worker.fetch(blobPost(t2.token, key, bytes, undefined, { [PROJECT_HEADER]: 'proj_2' }), e.env))).duplicate).toBe(false);
    expect(count(e.sqlite, 'blobs')).toBe(2);
    expect([...e.bucket.objects.keys()].sort()).toEqual([registeredObject(e.sqlite, 'proj_1', key)!, registeredObject(e.sqlite, 'proj_2', key)!].sort());
    expect([...e.bucket.objects.keys()].map((k) => k.split('~')[0]).sort()).toEqual([`proj_1/${key}`, `proj_2/${key}`]);
  });

  it('accepts a body at the cap and rejects a path that is not a lowercase hex digest', async () => {
    const e = sqliteEnv();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const big = new Uint8Array(1024);
    const key = await keyOf(big);
    expect((await json(await worker.fetch(blobPost(t.token, key, big, 'application/octet-stream'), e.env))).stored).toBe(true);
    for (const path of [`/blobs/${key.toUpperCase()}`, `/blobs/${key.slice(1)}`, '/blobs/']) {
      const res = await worker.fetch(new Request(`https://s${path}`, { method: 'POST', headers: memberHeaders(t.token, { 'content-type': 'text/plain', 'content-length': '1' }), body: new Uint8Array(1) }), e.env);
      expect({ path, status: res.status }).toEqual({ path, status: 401 });
    }
  });
});
