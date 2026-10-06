import { expect } from 'bun:test';
import { sha256Hex, sha256HexOf } from '@myco-server-worker/hash.js';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { rawMemberResourceSql } from '@myco-server-worker/core/raw-resources.js';
import { expectPersisted, lit, MEMBER_ID, memberHeadersFor, SESSION_SECRET, type ParityScenario, type ParityTarget } from '../harness.ts';

const DAY_MS = 86_400_000;

/** The production HTTP entries and their own stores retain the same observable content after archival. */
export const storageCleanupParity: ParityScenario = {
  name: 'storage cleanup: exact archives, bounded tool preview, raw uploader authority and unchanged reads',
  dedicated: { timeoutMs: 360_000 },
  async run(target: ParityTarget) {
    const stamp = Date.now();
    const sessionId = `storage-parity-${crypto.randomUUID()}`;
    const responseId = crypto.randomUUID();
    const toolCallId = crypto.randomUUID();
    const promptId = crypto.randomUUID();
    const transcriptId = `tx_${crypto.randomUUID().replaceAll('-', '')}`;
    const searchWord = `storageparity${stamp}`;
    const responseText = `${searchWord} ${'é🦋'.repeat(5_000)}`;
    const input = { file_path: 'src/whole.ts', patch: `line é🦋\n${'whole input '.repeat(700)}` };
    const fullInput = JSON.stringify(input);
    const output = `output ${'complete '.repeat(350)}`;
    const uploaderId = `mem_cleanup_${crypto.randomUUID().replaceAll('-', '')}`;
    const uploaderMachine = `machine_cleanup_${crypto.randomUUID().replaceAll('-', '')}`;
    const uploaderTokenId = `mt_cleanup_${crypto.randomUUID().replaceAll('-', '')}`;
    const uploaderToken = crypto.randomUUID().replaceAll('-', '').padEnd(43, 'x');
    const uploaderSub = String(stamp + Math.floor(Math.random() * 1000));
    await target.sql(`INSERT INTO members(id,label,created_at,role,github_id)
      VALUES(${lit(uploaderId)},'cleanup uploader',${stamp},'member',${lit(uploaderSub)})`);
    await target.sql(`INSERT INTO machine_claims(machine_id,member_id,claimed_at)
      VALUES(${lit(uploaderMachine)},${lit(uploaderId)},${stamp})`);
    await target.sql(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,bytes_written,lineage_root,lineage_started_at)
      VALUES(${lit(uploaderTokenId)},${lit(uploaderId)},${lit(uploaderMachine)},${lit(await sha256Hex(uploaderToken))},
      ${stamp},${stamp + 3_600_000},0,${lit(uploaderTokenId)},${stamp})`);
    const uploaderCookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET,
      { sub: uploaderSub, login: 'cleanup-uploader', iat: stamp, exp: stamp + 3_600_000 })}`;
    const uploaderHeaders = { cookie: uploaderCookie, 'cf-connecting-ip': '1.2.3.4' };
    const captureHeaders = (extra: Record<string, string> = {}) => memberHeadersFor(uploaderToken, target.projectId, extra);
    const post = async (kind: string, payload: Record<string, unknown>, channel = 'cli') => {
      const eventId = crypto.randomUUID();
      const response = await fetch(`${target.url}/events`, {
        method: 'POST', headers: captureHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ eventId, sessionId, kind, createdAt: stamp, channel,
          producer: { adapter: 'claude-code', version: 'parity' }, payload }),
      });
      await expectPersisted(response, kind);
      return eventId;
    };
    const ownerGet = (path: string) => fetch(`${target.url}${path}`, { headers: target.ownerHeaders() });
    const rawGet = (path: string) => fetch(`${target.url}${path}`, { headers: uploaderHeaders });
    const wake = async () => {
      const response = await fetch(`${target.url}/api/wake`, { method: 'POST',
        headers: { ...target.ownerHeaders(), origin: target.url } });
      expect(response.status).toBe(200);
      const body = await response.json() as { jobs: Array<{ name: string; failed: string | null }> };
      for (const job of body.jobs.filter((item) => ['storage-content-cleanup', 'transcript-retention'].includes(item.name))) {
        expect(job.failed, job.name).toBeNull();
      }
    };
    await post('session.start', { agent: 'claude-code', startedAt: stamp });
    await post('prompt', { promptId, text: 'exercise complete tool input', origin: 'user' });
    const archivedEvent = await post('response', { responseId, text: responseText }, 'import');
    await post('tool.use', { toolCallId, promptId, toolName: 'Edit', input, output, success: true });
    const rawText = `${JSON.stringify({ type: 'system', message: { content: 'raw uploader only' }, timestamp: new Date(stamp).toISOString() })}\n`;
    const rawBytes = new TextEncoder().encode(rawText);
    const rawKey = await sha256HexOf(rawBytes);
    await expectPersisted(await fetch(`${target.url}/blobs/${rawKey}`, {
      method: 'POST', headers: captureHeaders({ 'content-type': 'text/plain', 'content-length': String(rawBytes.byteLength) }), body: rawBytes,
    }), 'raw transcript bytes');
    await post('transcript.segment', { transcriptId, baseOffset: 0, length: rawBytes.byteLength, blob: rawKey, agent: 'claude-code' });

    const project = lit(target.projectId);
    const event = lit(archivedEvent);
    const tool = lit(toolCallId);
    const transcript = lit(transcriptId);
    const responseRows = () => target.sql(`SELECT response_id,text,blob_key FROM responses WHERE project_id=${project} AND response_id=${lit(responseId)}`);
    const toolFacts = () => target.sql(`SELECT tool_name,output_preview,output_blob_key,success,error_message,files_affected FROM tool_calls WHERE project_id=${project} AND tool_call_id=${tool}`);
    const counts = () => target.sql(`SELECT
      (SELECT COUNT(*) FROM events WHERE project_id=${project} AND session_id=${lit(sessionId)}) AS events,
      (SELECT COUNT(*) FROM prompt_batches WHERE project_id=${project} AND session_id=${lit(sessionId)}) AS prompts,
      (SELECT COUNT(*) FROM responses WHERE project_id=${project} AND session_id=${lit(sessionId)}) AS responses,
      (SELECT COUNT(*) FROM tool_calls WHERE project_id=${project} AND session_id=${lit(sessionId)}) AS tools`);
    const search = async () => {
      const response = await ownerGet(`/api/projects/${target.projectId}/search?q=${searchWord}`);
      expect(response.status).toBe(200);
      const body = await response.json() as { results: Array<{ id: string }> };
      return body.results.map((row) => row.id).sort();
    };
    const inputPath = `/api/projects/${target.projectId}/processed/tool-input/${toolCallId}`;
    const outputPath = `/api/projects/${target.projectId}/processed/tool-output/${toolCallId}`;
    const rawPath = `/api/projects/${target.projectId}/blobs/${rawKey}`;
    const transcriptPath = `/api/projects/${target.projectId}/sessions/${sessionId}/transcript`;
    const before = { responses: await responseRows(), tool: await toolFacts(), counts: await counts(), search: await search() };
    expect(before.responses).toHaveLength(1);
    expect(before.search).toContain(responseId);
    expect(await (await ownerGet(inputPath)).text()).toBe(fullInput);
    expect(await (await ownerGet(outputPath)).text()).toBe(output);
    expect((await rawGet(rawPath)).status).toBe(200);
    expect((await ownerGet(rawPath)).status).toBe(404);
    const [freshInput]=await target.sql(`SELECT input FROM tool_calls WHERE project_id=${project} AND tool_call_id=${tool}`);
    expect(new TextEncoder().encode(String(freshInput.input)).byteLength).toBeLessThanOrEqual(2048);
    await target.sql(`DELETE FROM processed_resources WHERE project_id=${project} AND kind='tool-input' AND resource_id=${tool}`);
    await target.sql(`UPDATE tool_calls SET input=${lit(fullInput)},input_blob_key=NULL,input_bytes=NULL
      WHERE project_id=${project} AND tool_call_id=${tool}`);
    expect(await (await ownerGet(inputPath)).text()).toBe(fullInput);

    // The fixture represents a processed transcript and an old raw source while keeping real HTTP upload provenance.
    const aged = stamp - 2 * DAY_MS;
    await target.sql(`UPDATE transcripts SET parsed_offset=${rawBytes.byteLength},parser_context='{}',parse_error=NULL
      WHERE project_id=${project} AND transcript_id=${transcript}`);
    await target.sql(`UPDATE transcript_segments SET received_at=${aged} WHERE project_id=${project} AND transcript_id=${transcript}`);
    await target.sql(`UPDATE raw_archive_refs SET received_at=${aged},eligible_at=${aged} WHERE project_id=${project}
      AND source_kind='transcript' AND transcript_id=${transcript}`);
    await target.sql(`UPDATE raw_archive_refs SET received_at=${aged},eligible_at=${aged} WHERE project_id=${project}
      AND source_kind='event' AND source_id=${event}`);
    await target.sql(`INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('retention.raw_days','1',${stamp},'parity')
      ON CONFLICT(leaf) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by`);

    let done = false;
    for (let pass = 0; pass < 16; pass += 1) {
      await wake();
      const [eventState] = await target.sql(`SELECT payload_format,payload,payload_bytes FROM events WHERE project_id=${project} AND event_id=${event}`);
      const [toolState] = await target.sql(`SELECT input,input_bytes,input_blob_key FROM tool_calls WHERE project_id=${project} AND tool_call_id=${tool}`);
      const [rawState] = await target.sql(`SELECT disposition FROM raw_archive_refs WHERE project_id=${project}
        AND source_kind='transcript' AND transcript_id=${transcript}`);
      done = eventState?.payload_format === 'archived' && toolState?.input_blob_key !== null && rawState?.disposition === 'archived';
      if (done) break;
    }
    expect(done).toBe(true);
    const [eventState] = await target.sql(`SELECT payload,payload_format,payload_bytes FROM events WHERE project_id=${project} AND event_id=${event}`);
    expect(eventState).toEqual({ payload: '{}', payload_format: 'archived', payload_bytes: 0 });
    const [eventRef] = await target.sql(`SELECT archive_key,receipt_key,digest,size FROM event_content_refs WHERE project_id=${project} AND event_id=${event}`);
    expect(eventRef).toMatchObject({ archive_key: eventRef.digest, size: new TextEncoder().encode(JSON.stringify({ responseId, text: responseText })).byteLength });
    expect(typeof eventRef.receipt_key).toBe('string');
    const [toolState] = await target.sql(`SELECT input,input_bytes,input_blob_key FROM tool_calls WHERE project_id=${project} AND tool_call_id=${tool}`);
    expect(Number(toolState.input_bytes)).toBe(new TextEncoder().encode(fullInput).byteLength);
    expect(new TextEncoder().encode(String(toolState.input)).byteLength).toBeLessThanOrEqual(2048);
    expect(typeof toolState.input_blob_key).toBe('string');
    expect(await (await ownerGet(inputPath)).text()).toBe(fullInput);
    expect(await (await ownerGet(outputPath)).text()).toBe(output);
    expect(await responseRows()).toEqual(before.responses);
    expect(await toolFacts()).toEqual(before.tool);
    expect(await counts()).toEqual(before.counts);
    expect(await search()).toEqual(before.search);

    const [rawRef] = await target.sql(`SELECT disposition,archive_key,receipt_key,length FROM raw_archive_refs WHERE project_id=${project}
      AND source_kind='transcript' AND transcript_id=${transcript}`);
    expect(rawRef).toMatchObject({ disposition: 'archived', archive_key: rawKey, length: rawBytes.byteLength });
    expect(typeof rawRef.receipt_key).toBe('string');
    expect(await target.sql(`SELECT 1 AS present FROM transcript_segments WHERE project_id=${project} AND transcript_id=${transcript}`)).toEqual([]);
    const uploaderTranscript = await rawGet(transcriptPath);
    expect(uploaderTranscript.status).toBe(200);
    expect(await uploaderTranscript.json()).toMatchObject({ transcripts: [{ transcriptId, segments: [{ blobKey: rawKey, availability: 'archived' }] }] });
    expect((await ownerGet(transcriptPath)).status).toBe(404);
    expect(await (await rawGet(rawPath)).text()).toBe(rawText);
    expect((await ownerGet(rawPath)).status).toBe(404);

    // Raw event content has no HTTP route; the same capability predicate remains uploader-scoped after clearing.
    const admitted = rawMemberResourceSql(project, 'event', event, lit(uploaderId));
    const denied = rawMemberResourceSql(project, 'event', event, lit(MEMBER_ID));
    expect(await target.sql(`SELECT ${admitted} AS admitted,${denied} AS denied`)).toEqual([{ admitted: 1, denied: 0 }]);
  },
};
