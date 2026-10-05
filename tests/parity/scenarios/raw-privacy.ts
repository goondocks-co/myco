import { expect } from 'bun:test';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { sha256Hex, sha256HexOf, utf8 } from '@myco-server-worker/hash.js';
import { blobFields, KINDS } from '@myco-server-worker/ingest/kinds.js';
import { expectPersisted, lit, memberHeadersFor, SESSION_SECRET, type ParityScenario, type ParityTarget } from '../harness.ts';

type RequestFetch = (request: Request) => Promise<Response>;
const TOKEN_TTL_MS = 3_600_000;
const PROJECT = 'proj_raw_privacy';
const ATTACHMENT_PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 96, 96, 96, 96, 0, 0, 0, 5, 0, 1, 165, 246, 69, 64, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);

interface Viewer { id: string; sub: string; machine: string; token: string; tokenId: string; headers: Record<string, string> }

/** The same raw-serving contract through either target's actual request pipeline. */
export async function assertRawPrivacy(target: ParityTarget, requestFetch: RequestFetch = (request) => fetch(request), secret = SESSION_SECRET): Promise<void> {
  const now = Date.now();
  const viewers: Viewer[] = [];
  await target.sql(`INSERT INTO projects (project_id, name, created_at) VALUES (${lit(PROJECT)}, 'raw privacy', ${now})`);
  for (const [label, role, sub] of [['uploader', 'member', '991001'], ['other', 'member', '991002'], ['admin', 'admin', '991003']] as const) {
    const id = `mem_raw_${label}`;
    const machine = `machine_raw_${label}`;
    const token = crypto.randomUUID().replaceAll('-', '').padEnd(43, 'x');
    const tokenId = `mt_raw_${label}`;
    await target.sql(`INSERT INTO members (id, label, created_at, role, github_id) VALUES (${lit(id)}, ${lit(label)}, ${now}, ${lit(role)}, ${lit(sub)})`);
    await target.sql(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES (${lit(machine)}, ${lit(id)}, ${now})`);
    await target.sql(`INSERT INTO member_credentials (id, member_id, machine_id, token_hash, issued_at, expires_at, bytes_written, lineage_root, lineage_started_at)
      VALUES (${lit(tokenId)}, ${lit(id)}, ${lit(machine)}, ${lit(await sha256Hex(token))}, ${now}, ${now + TOKEN_TTL_MS}, 0, ${lit(tokenId)}, ${now})`);
    const cookie = await signSession(secret, { sub, login: label, iat: now, exp: now + TOKEN_TTL_MS });
    viewers.push({ id, sub, machine, token, tokenId, headers: { cookie: `${SESSION_COOKIE}=${cookie}`, 'cf-connecting-ip': '1.2.3.4' } });
  }
  const [uploader, other, admin] = viewers;
  const readers = [
    { name: 'uploader', headers: uploader.headers, admitted: true },
    { name: 'other member', headers: other.headers, admitted: false },
    { name: 'admin', headers: admin.headers, admitted: false },
    { name: 'owner', headers: target.ownerHeaders(), admitted: false },
  ];
  const get = (path: string, headers: Record<string, string>) => requestFetch(new Request(`${target.url}${path}`, { headers }));
  const post = (path: string, headers: Record<string, string>, body: BodyInit) => requestFetch(new Request(`${target.url}${path}`, { method: 'POST', headers, body }));
  const upload = async (viewer: Viewer, body: string | Uint8Array<ArrayBuffer>, namedKey?: string, mediaType = 'text/plain') => {
    const bytes = typeof body === 'string' ? utf8(body) : body;
    const key = namedKey ?? await sha256HexOf(bytes);
    const response = await post(`/blobs/${key}`, memberHeadersFor(viewer.token, PROJECT, { 'content-type': mediaType, 'content-length': String(bytes.byteLength) }), bytes);
    return { response, key };
  };
  const session = 'raw_privacy_session';
  const event = async (kind: string, payload: Record<string, unknown>) => {
    const eventId = crypto.randomUUID();
    await expectPersisted(await post('/events', memberHeadersFor(uploader.token, PROJECT), JSON.stringify({ eventId, sessionId: session, kind, createdAt: now, channel: 'cli', producer: { adapter: 'claude-code', version: '2.0.0-test' }, payload })), kind);
    return eventId;
  };
  await event('session.start', { agent: 'claude-code', startedAt: now });
  const rawText = `${JSON.stringify({ type: 'user', promptId: crypto.randomUUID(), message: { content: 'processed prompt' }, privateEnvelope: 'retained raw bytes', timestamp: new Date(now).toISOString() })}\n`;
  const raw = await upload(uploader, rawText);
  await expectPersisted(raw.response, 'raw blob');
  const transcriptId = `tx_${crypto.randomUUID().replaceAll('-', '')}`;
  await event('transcript.segment', { transcriptId, baseOffset: 0, length: utf8(rawText).byteLength, blob: raw.key, agent: 'claude-code', originPath: '/private/uploader/transcript.jsonl' });

  const siblingId = `tx_${crypto.randomUUID().replaceAll('-', '')}`;
  const siblingText = 'other member raw transcript';
  const sibling = await upload(other, siblingText);
  await expectPersisted(sibling.response, 'sibling blob');
  await target.sql(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, segment_count, first_received_at, last_received_at, token_id, role)
    VALUES (${lit(PROJECT)}, ${lit(siblingId)}, ${lit(session)}, ${lit(other.machine)}, 'claude-code', ${siblingText.length}, 1, ${now}, ${now}, ${lit(other.tokenId)}, 'subagent')`);
  await target.sql(`INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
    VALUES (${lit(PROJECT)}, ${lit(siblingId)}, 0, ${siblingText.length}, ${lit(sibling.key)}, ${lit(crypto.randomUUID())}, ${now}, ${now}, ${lit(other.tokenId)})`);
  const transcriptPath = `/api/projects/${PROJECT}/sessions/${session}/transcript`;
  const blobPath = (key: string) => `/api/projects/${PROJECT}/blobs/${key}`;
  for (const reader of readers) {
    const response = await get(blobPath(raw.key), reader.headers);
    expect({ viewer: reader.name, status: response.status }).toEqual({ viewer: reader.name, status: reader.admitted ? 200 : 404 });
    assertPrivateCache(response);
    if (reader.admitted) expect(await response.text()).toBe(rawText);
    const enumeration = await get(transcriptPath, reader.headers);
    assertPrivateCache(enumeration);
    expect({ viewer: reader.name, status: enumeration.status }).toEqual({ viewer: reader.name, status: reader.name === 'other member' || reader.admitted ? 200 : 404 });
    if (enumeration.status === 200) {
      const body = await enumeration.json() as { transcripts: Array<{ transcriptId: string; segments: Array<{ blobKey: string }> }> };
      expect(body.transcripts.map((row) => row.transcriptId)).toEqual([reader.admitted ? transcriptId : siblingId]);
      expect(body.transcripts[0].segments.map((row) => row.blobKey)).toEqual([reader.admitted ? raw.key : sibling.key]);
    }
  }

  const hashOnly = await upload(other, 'no possession of the original bytes', raw.key);
  expect((await hashOnly.response.json() as { stored: boolean }).stored).toBe(false);
  expect((await get(blobPath(raw.key), other.headers)).status).toBe(404);
  const intruderSession = 'raw_privacy_intruder';
  await expectPersisted(await post('/events', memberHeadersFor(other.token, PROJECT), JSON.stringify({
    eventId: crypto.randomUUID(), sessionId: intruderSession, kind: 'session.start', createdAt: now, channel: 'cli',
    producer: { adapter: 'claude-code', version: '2.0.0-test' }, payload: { agent: 'claude-code', startedAt: now },
  })), 'other member session');
  const typedKinds: Record<string, { kind: string; idField: string }> = {
    prompt: { kind: 'prompt', idField: 'promptId' }, response: { kind: 'response', idField: 'responseId' }, plan: { kind: 'plan', idField: 'planKey' },
    'tool.use': { kind: 'tool-input', idField: 'toolCallId' }, 'tool.failure': { kind: 'tool-input', idField: 'toolCallId' },
    attachment: { kind: 'attachment', idField: 'attachmentId' },
  };
  for (const spec of KINDS) {
    for (const field of blobFields(spec)) {
      const fixtures: Record<string, Record<string, unknown>> = {
        prompt: { promptId: crypto.randomUUID(), origin: 'user' },
        response: { responseId: crypto.randomUUID() },
        plan: { planKey: crypto.randomUUID(), title: 'unowned spill' },
        'tool.use': { toolCallId: crypto.randomUUID(), toolName: 'Read', input: {}, success: true },
        'tool.failure': { toolCallId: crypto.randomUUID(), toolName: 'Read', input: {}, success: false, errorMessage: 'failure' },
        attachment: { attachmentId: crypto.randomUUID() },
        'transcript.segment': { transcriptId: `tx_${crypto.randomUUID().replaceAll('-', '')}`, baseOffset: 0, length: utf8(rawText).byteLength, agent: 'claude-code' },
        'compaction.pre': { trigger: 'auto' }, 'compaction.post': { trigger: 'auto' },
      };
      expect(Object.hasOwn(fixtures, spec.name)).toBe(true);
      const payload = { ...fixtures[spec.name], [field]: raw.key };
      if (spec.exactlyOne?.includes(field)) {
        for (const exclusive of spec.exactlyOne) if (exclusive !== field) delete payload[exclusive];
      }
      const eventId = crypto.randomUUID();
      const refused = await post('/events', memberHeadersFor(other.token, PROJECT), JSON.stringify({
        eventId, sessionId: intruderSession, kind: spec.name, createdAt: now, channel: 'cli',
        producer: { adapter: 'claude-code', version: '2.0.0-test' }, payload,
      }));
      expect({ kind: spec.name, field, status: refused.status, body: await refused.json() }).toMatchObject({
        kind: spec.name, field, status: 200, body: { persisted: false, code: 'blob_absent' },
      });
      expect(await target.sql(`SELECT event_id FROM events WHERE project_id = ${lit(PROJECT)} AND event_id = ${lit(eventId)}`)).toEqual([]);
      const typed = typedKinds[spec.name];
      if (typed !== undefined) {
        const kind = field === 'outputBlob' ? 'tool-output' : typed.kind;
        const response = await get(`/api/projects/${PROJECT}/processed/${kind}/${payload[typed.idField]}`, other.headers);
        expect(response.status).toBe(404);
      }
    }
  }
  const verified = await upload(other, rawText, raw.key);
  await expectPersisted(verified.response, 'verified duplicate');
  expect(await (await get(blobPath(raw.key), other.headers)).text()).toBe(rawText);
  expect(await target.sql(`SELECT owner_member_id FROM raw_resources WHERE project_id = ${lit(PROJECT)} AND kind = 'blob' AND resource_id = ${lit(raw.key)} ORDER BY owner_member_id`))
    .toEqual([other.id, uploader.id].sort().map((owner_member_id) => ({ owner_member_id })));
  const afterDuplicate = await (await get(transcriptPath, other.headers)).json() as { transcripts: Array<{ transcriptId: string }> };
  expect(afterDuplicate.transcripts.map((row) => row.transcriptId)).toEqual([siblingId]);

  const unknown = { key: await sha256Hex('unknown ownership remains preserved') };
  await target.sql(`INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation)
    VALUES (${lit(PROJECT)}, ${lit(unknown.key)}, 36, 'text/plain', 'unknown_token', ${now}, ${lit(crypto.randomUUID())})`);
  await target.sql(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, size, segment_count, first_received_at, last_received_at, token_id)
    VALUES (${lit(PROJECT)}, 'tx_00000000000000000000000000000000', ${lit(session)}, 'unknown_machine', 0, 0, ${now}, ${now}, 'unknown_token')`);
  for (const reader of readers) {
    const response = await get(blobPath(unknown.key), reader.headers);
    expect(response.status).toBe(404);
    assertPrivateCache(response);
  }

  const processed = 'shared processed body '.repeat(15_000);
  const spilled = await upload(uploader, processed);
  await expectPersisted(spilled.response, 'processed spill');
  const promptId = crypto.randomUUID();
  const responseId = crypto.randomUUID();
  const planKey = crypto.randomUUID();
  const inlinePlanKey = crypto.randomUUID();
  const toolCallId = crypto.randomUUID();
  await event('prompt', { promptId, blob: spilled.key, origin: 'user' });
  await event('response', { responseId, promptId, blob: spilled.key });
  await event('plan', { planKey, promptId, title: 'shared spilled plan', blob: spilled.key });
  await event('plan', { planKey: inlinePlanKey, promptId, content: 'shared inline plan' });
  await event('tool.use', { toolCallId, promptId, toolName: 'Read', blob: spilled.key, outputBlob: spilled.key, success: true });
  const attachments: Array<{ attachmentId: string; key: string; mediaType: string; bytes: Uint8Array<ArrayBuffer> }> = [];
  for (const [mediaType, bytes] of [
    ['image/png', ATTACHMENT_PNG],
    ['application/octet-stream', Uint8Array.from([0, 255, 128, 10, 13, 0, 42])],
  ] as const) {
    const attachmentId = crypto.randomUUID();
    const attachment = await upload(uploader, bytes, undefined, mediaType);
    await expectPersisted(attachment.response, 'attachment blob');
    await event('attachment', { attachmentId, promptId, blob: attachment.key, description: 'shared captured file' });
    attachments.push({ attachmentId, key: attachment.key, mediaType, bytes });
  }
  const turnResponse = await get(`/api/projects/${PROJECT}/sessions/${session}/turns/${promptId}`, other.headers);
  expect(turnResponse.status).toBe(200);
  const turn = await turnResponse.json() as { attachments: Array<{ attachmentId: string; blobKey: string; mediaType: string; byteSize: number }> };
  expect(turn.attachments).toHaveLength(attachments.length);
  expect(turn.attachments.map(({ attachmentId, blobKey, mediaType, byteSize }) => ({ attachmentId, blobKey, mediaType, byteSize })))
    .toEqual(expect.arrayContaining(attachments.map(({ attachmentId, key, mediaType, bytes }) => ({ attachmentId, blobKey: key, mediaType, byteSize: bytes.byteLength }))));
  for (const metadata of [{ title: 'member title edit', tags: ['shared'] }, { title: 'member status and title edit', status: 'completed' }]) {
    const saved = await post('/mcp', memberHeadersFor(other.token, PROJECT, { 'content-type': 'application/json' }), JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'myco_plans', arguments: { project: PROJECT, op: 'save', id: planKey, session_id: intruderSession, ...metadata },
      },
    }));
    expect(saved.status).toBe(200);
    const body = await saved.json() as { result: { structuredContent: { result: { ok: boolean; id: string } } } };
    expect(body.result.structuredContent.result).toMatchObject({ ok: true, id: planKey });
    expect(await (await get(`/api/projects/${PROJECT}/processed/plan/${planKey}`, other.headers)).text()).toBe(processed);
    expect((await get(blobPath(spilled.key), other.headers)).status).toBe(404);
  }
  const forgedPlan = crypto.randomUUID();
  const forged = await post('/events', memberHeadersFor(other.token, PROJECT), JSON.stringify({
    eventId: crypto.randomUUID(), sessionId: intruderSession, kind: 'plan', createdAt: now, channel: 'cli',
    producer: { adapter: 'claude-code', version: '2.0.0-test' }, payload: { planKey: forgedPlan, title: 'forged shared spill', blob: spilled.key },
  }));
  expect(await forged.json()).toMatchObject({ persisted: false, code: 'blob_absent' });
  expect((await get(`/api/projects/${PROJECT}/processed/plan/${forgedPlan}`, other.headers)).status).toBe(404);
  expect(await target.sql(`SELECT owner_member_id FROM raw_resources WHERE project_id = ${lit(PROJECT)} AND kind = 'blob' AND resource_id = ${lit(spilled.key)}`)).toEqual([{ owner_member_id: uploader.id }]);
  for (const reader of readers) {
    for (const [kind, id, expected] of [['prompt', promptId, processed], ['response', responseId, processed], ['plan', planKey, processed], ['plan', inlinePlanKey, 'shared inline plan'], ['tool-input', toolCallId, processed], ['tool-output', toolCallId, processed]] as const) {
      const response = await get(`/api/projects/${PROJECT}/processed/${kind}/${id}`, reader.headers);
      expect({ viewer: reader.name, kind, status: response.status }).toEqual({ viewer: reader.name, kind, status: 200 });
      expect(await response.text()).toBe(expected);
    }
    for (const attachment of attachments) {
      const response = await get(`/api/projects/${PROJECT}/processed/attachment/${attachment.attachmentId}`, reader.headers);
      expect({ viewer: reader.name, mediaType: attachment.mediaType, status: response.status })
        .toEqual({ viewer: reader.name, mediaType: attachment.mediaType, status: 200 });
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(attachment.bytes);
      expect(response.headers.get('content-type')).toBe(attachment.mediaType);
      expect(response.headers.get('content-length')).toBe(String(attachment.bytes.byteLength));
      expect(response.headers.get('content-disposition')).toBe(attachment.mediaType === 'image/png' ? null : `attachment; filename="${attachment.attachmentId}"`);
      expect(response.headers.get('cache-control')).toContain('no-store');
      const generic = await get(blobPath(attachment.key), reader.headers);
      expect(generic.status).toBe(reader.admitted ? 200 : 404);
      assertPrivateCache(generic);
    }
    const generic = await get(blobPath(spilled.key), reader.headers);
    expect(generic.status).toBe(reader.admitted ? 200 : 404);
    assertPrivateCache(generic);
  }

  await target.sql(`UPDATE member_credentials SET expires_at = ${now - 1}, revoked_at = ${now} WHERE id = ${lit(uploader.tokenId)}`);
  const expiredTokenRead = await get(blobPath(raw.key), uploader.headers);
  expect(expiredTokenRead.status).toBe(200);
  expect(await expiredTokenRead.text()).toBe(rawText);
  assertPrivateCache(expiredTokenRead);
  expect((await get(transcriptPath, uploader.headers)).status).toBe(200);
  await target.sql(`UPDATE members SET revoked_at = ${now} WHERE id = ${lit(uploader.id)}`);
  for (const path of [blobPath(raw.key), transcriptPath]) {
    const revoked = await get(path, uploader.headers);
    expect(revoked.status).toBe(401);
    assertPrivateCache(revoked);
  }
  for (const attachment of attachments) {
    const response = await get(`/api/projects/${PROJECT}/processed/attachment/${attachment.attachmentId}`, other.headers);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(attachment.bytes);
  }
  const changedBrowser = await get(blobPath(spilled.key), admin.headers);
  expect(changedBrowser.status).toBe(404);
  assertPrivateCache(changedBrowser);
  const ownerAfterRevocation = await get(blobPath(raw.key), target.ownerHeaders());
  expect(ownerAfterRevocation.status).toBe(404);
  assertPrivateCache(ownerAfterRevocation);
  expect(await target.sql(`SELECT owner_member_id FROM raw_resources WHERE project_id = ${lit(PROJECT)} AND kind = 'transcript' AND resource_id = ${lit(transcriptId)}`)).toEqual([{ owner_member_id: uploader.id }]);
  await target.sql(`UPDATE members SET github_id = NULL WHERE id = ${lit(uploader.id)}`);
  await target.sql(`INSERT INTO members (id, label, created_at, role, github_id) VALUES ('mem_raw_rejoined', 'new membership', ${now}, 'member', ${lit(uploader.sub)})`);
  for (const path of [blobPath(raw.key), blobPath(spilled.key), transcriptPath]) {
    const rejoined = await get(path, uploader.headers);
    expect(rejoined.status).toBe(404);
    assertPrivateCache(rejoined);
  }
}

function assertPrivateCache(response: Response): void {
  expect(response.headers.get('cache-control')).toContain('no-store');
  const vary = (response.headers.get('vary') ?? '').toLowerCase();
  expect(vary).toContain('cookie');
  expect(vary).toContain('authorization');
}

export const rawPrivacy: ParityScenario = {
  name: 'raw privacy: uploader provenance, filtered transcripts, verified dedup, shared processed bodies and browser revocation',
  dedicated: { timeoutMs: 180_000 },
  run: (target) => assertRawPrivacy(target),
};
