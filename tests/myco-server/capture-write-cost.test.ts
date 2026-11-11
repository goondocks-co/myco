/**
 * Capture writes whose admissions are switched on by what the event names (an uploaded blob, a continued row, a referenced
 * prompt, a delivery's prompt scheme) cost D1 the same as the Project's history grows.
 */
import { expect, it } from 'bun:test';
import { HOOK_NAMED_SCHEMES } from '@goondocks/myco-shared/prompt-identity';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { commit } from '@myco-server-worker/db/index.js';
import { handleBlob } from '@myco-server-worker/ingest/blobs.js';
import { planEventWrite } from '@myco-server-worker/ingest/events.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { memoryBlobStore, recordingLimiter } from './helpers/fixtures.js';
import { d1TwoScale, eachUnit, expectTwoScale } from './helpers/two-scale.js';

const PROJECT = 'proj_capture_cost';
const BLOB = await sha256Hex('x');
const CONTEXT = { projectId: PROJECT, machineId: 'machine', tokenId: 'credential', bodyBytes: 100, now: 2_000 };
/** Rows a request may read at the large size beyond the small one: random ids land in different places among a Project's rows. */
const BOUNDED_EXTRA = 10;

it('D1 capture of tool calls, attachments, segments, plans and deliveries costs the same as the Project\'s history grows', async () => {
  const blobs = memoryBlobStore();
  const sessionOf = (scale: number) => `capture-${scale}`;
  const event = async (db: RelationalStore, scale: number, kind: string, payload: Record<string, unknown>, expected: Record<string, unknown>) => {
    const planned = await planEventWrite(db, CONTEXT, {
      eventId: crypto.randomUUID(), sessionId: sessionOf(scale), kind, createdAt: 1_000, channel: 'cli', producer: { adapter: 'claude-code', version: '1' }, payload,
    }, { db, blobs });
    if (!planned.ok) throw new Error(JSON.stringify(planned));
    expect(planned.write.interpret(await commit(db, ...planned.write.statements))).toEqual(expected);
  };
  const projected = { persisted: true, projected: true };
  expectTwoScale(await d1TwoScale({
    sizes: [1_000, 5_000],
    setup: async (db) => {
      await db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?, ?, 1)').bind(PROJECT, PROJECT).run();
      await db.prepare("INSERT INTO members(id,label,created_at) VALUES('member','member',1)").run();
      await db.prepare("INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES('machine','member',1)").run();
      await db.prepare(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
        VALUES('credential','member','machine','hash',1,99999999,'credential',1)`).run();
      const env = serverEnvFromBindings({ MYCO_DB: db, BUCKET: blobs, SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() });
      const uploaded = await handleBlob(env, new Request(`http://127.0.0.1/blobs/${BLOB}`, { method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'x' }),
        { ...CONTEXT, now: 1, clock: () => 1, contentLength: 1, params: { key: BLOB } });
      expect(await uploaded.json()).toMatchObject({ stored: true });
    },
    grow: async (db, from, to) => {
      await eachUnit(db, from, to, `INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
        SELECT ?3,printf('seed-%06d',i),'machine','credential',1,1 FROM n`, PROJECT);
      await eachUnit(db, from, to, `INSERT INTO session_prompts(project_id,prompt_id,session_id,generation,turn_key,created_at,ord,origin)
        SELECT ?3,printf('prompt-%06d',i),printf('seed-%06d',i),1,printf('prompt-%06d',i),i,i,'user' FROM n`, PROJECT);
      await eachUnit(db, from, to, `INSERT INTO events(project_id,event_id,session_id,token_id,kind,channel,payload,envelope_hash,created_at,received_at,raw_revision)
        SELECT ?3,printf('seed-event-%06d',i),printf('seed-%06d',i),'credential','tool.use','cli',json_object('toolCallId',printf('tool-%06d',i)),'hash',1,1,1 FROM n`, PROJECT);
      await eachUnit(db, from, to, `INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
        SELECT ?3,printf('%064d',i),1,'text/plain','credential',1,'00000000-0000-4000-8000-000000000001' FROM n`, PROJECT);
      await eachUnit(db, from, to, `INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,size,first_received_at,last_received_at,token_id)
        SELECT ?3,printf('tx_%032d',i),printf('seed-%06d',i),'machine',1,1,1,'credential' FROM n`, PROJECT);
      await eachUnit(db, from, to, `INSERT INTO attachments(project_id,attachment_id,session_id,event_id,blob_key,media_type,byte_size,created_at,token_id,received_at)
        SELECT ?3,printf('attachment-%06d',i),printf('seed-%06d',i),printf('seed-event-%06d',i),printf('%064d',i),'text/plain',1,1,'credential',1 FROM n`, PROJECT);
      await eachUnit(db, from, to, `INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,content,content_hash,status,created_at,updated_at,token_id,received_at)
        SELECT ?3,printf('plan-%06d',i),printf('seed-%06d',i),printf('seed-event-%06d',i),'machine','body','hash','active',1,1,'credential',1 FROM n`, PROJECT);
    },
    cases: [
      { name: 'session.start', run: (db, { scale }) => event(db, scale, 'session.start', { agent: 'claude-code' }, projected) },
      { name: 'tool call naming its prompt, input in an uploaded blob', extra: BOUNDED_EXTRA, run: (db, { scale }) =>
        event(db, scale, 'tool.use', { toolCallId: crypto.randomUUID(), promptId: crypto.randomUUID(), toolName: 'Read', blob: BLOB, success: true }, projected) },
      { name: 'attachment of an uploaded blob', extra: BOUNDED_EXTRA, run: (db, { scale }) =>
        event(db, scale, 'attachment', { attachmentId: crypto.randomUUID(), blob: BLOB }, projected) },
      { name: 'transcript segment', extra: BOUNDED_EXTRA, run: (db, { scale }) =>
        event(db, scale, 'transcript.segment', { transcriptId: `tx_${'abc'[scale + 1]!.repeat(32)}`, baseOffset: 0, length: 1, blob: BLOB, agent: 'claude-code' },
          { ...projected, transcript: { size: 1, segmentCount: 1 } }) },
      { name: 'plan with its body in an uploaded blob', extra: BOUNDED_EXTRA, run: (db, { scale }) =>
        event(db, scale, 'plan', { planKey: crypto.randomUUID(), blob: BLOB, title: 'Plan' }, projected) },
      { name: 'delivery naming its prompt under a scheme', extra: BOUNDED_EXTRA, run: (db, { scale }) =>
        event(db, scale, 'context.delivered', { receiptId: crypto.randomUUID(), answerId: crypto.randomUUID(), renderedIn: crypto.randomUUID(),
          renderedScheme: HOOK_NAMED_SCHEMES[0] }, { persisted: true }) },
    ],
    warm: true,
  }));
}, 180_000);
