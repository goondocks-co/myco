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
      { aud: target.deploymentId, sub: uploaderSub, login: 'cleanup-uploader', iat: stamp, exp: stamp + 3_600_000 })}`;
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
      expect(response.status, response.status === 200 ? 'cleanup wake' : await response.text()).toBe(200);
      const body = await response.json() as { jobs: Array<{ name: string; failed: string | null }> };
      for (const job of body.jobs.filter((item) => ['storage-content-cleanup', 'transcript-retention', 'object-release-drain'].includes(item.name))) {
        expect(job.failed, job.name).toBeNull();
      }
    };
    await post('session.start', { agent: 'claude-code', startedAt: stamp });
    await post('prompt', { promptId, text: 'exercise complete tool input', origin: 'user' });
    const archivedEvent = await post('response', { responseId, text: responseText }, 'import');
    await post('tool.use', { toolCallId, promptId, toolName: 'Edit', input, output, success: true });
    const conflict=await fetch(`${target.url}/events`,{
      method:'POST',headers:captureHeaders({'content-type':'application/json'}),
      body:JSON.stringify({eventId:crypto.randomUUID(),sessionId,kind:'tool.use',createdAt:stamp,channel:'cli',
        producer:{adapter:'claude-code',version:'parity'},payload:{toolCallId,toolName:'Edit',
          input:{patch:'different input'.repeat(400)},success:true}}),
    });
    expect(conflict.status).toBe(200);
    expect(await conflict.json()).toMatchObject({persisted:true,projected:false,code:'projection_conflict'});
    expect(await target.sql(`SELECT COUNT(*) AS n FROM archive_bundles
      WHERE project_id=${lit(target.projectId)} AND session_id=${lit(sessionId)}`)).toEqual([{n:1}]);
    expect(await target.sql(`SELECT COUNT(*) AS n FROM prepared_archive_bundles
      WHERE project_id=${lit(target.projectId)}`)).toEqual([{n:0}]);
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
    await target.sql(`UPDATE tool_calls SET input=${lit(fullInput)},input_blob_key=NULL,input_bytes=NULL,input_bundle_id=NULL,input_bundle_entry=NULL
      WHERE project_id=${project} AND tool_call_id=${tool}`);
    expect(await (await ownerGet(inputPath)).text()).toBe(fullInput);

    const control=async(paused:boolean)=>{
      const response=await fetch(`${target.url}/api/storage-cleanup`,{method:'PATCH',
        headers:{...target.ownerHeaders(),origin:target.url,'content-type':'application/json'},body:JSON.stringify({paused})});
      expect(response.status).toBe(200);return response.json() as Promise<{state:Record<string,unknown>}>;
    };
    for(const method of ['GET','PATCH']){
      const response=await fetch(`${target.url}/api/storage-cleanup`,{method,
        headers:{...uploaderHeaders,origin:target.url},...(method==='PATCH'?{body:'{"paused":true}'}:{})});
      expect(response.status).toBe(403);
    }
    const pausedState=(await control(true)).state;
    await post('response',{responseId:crypto.randomUUID(),text:'capture remains admitted during pause'});
    await wake();
    const pausedResponse=await ownerGet('/api/storage-cleanup');expect(pausedResponse.status).toBe(200);
    const afterPause=await pausedResponse.json() as {state:Record<string,unknown>};
    for(const field of ['phase','cursor_project','cursor_id','cursor_session','cursor_created','cursor_rowid','converted_rows'])
      expect(afterPause.state[field]).toEqual(pausedState[field]);
    // Sparse inline inputs share the original uploader and session evidence.
    const [toolIdentity]=await target.sql(`SELECT event_id FROM tool_calls WHERE project_id=${project} AND tool_call_id=${tool}`);
    const fixtureRows:string[]=[];
    for(let n=0;n<160;n++){
      const id=crypto.randomUUID();
      fixtureRows.push(`(${project},${lit(id)},${lit(sessionId)},${lit(String(toolIdentity.event_id))},
          'Read',${lit(n%10===0?fullInput:'small')},1,${stamp+n+1},${lit(uploaderTokenId)},${stamp})`);
    }
    for(let start=0;start<fixtureRows.length;start+=40)await target.sql(`INSERT INTO tool_calls
      (project_id,tool_call_id,session_id,event_id,tool_name,input,success,created_at,token_id,received_at)
      VALUES ${fixtureRows.slice(start,start+40).join(',')}`);
    before.counts=await counts();
    await control(false);

    // The fixture represents a processed transcript and an old raw source while keeping real HTTP upload provenance.
    const aged = stamp - 2 * DAY_MS;
    await target.sql(`UPDATE transcripts SET parsed_offset=${rawBytes.byteLength},parser_context='{}',parse_error=NULL
      WHERE project_id=${project} AND transcript_id=${transcript}`);
    await target.sql(`UPDATE transcript_segments SET received_at=${aged} WHERE project_id=${project} AND transcript_id=${transcript}`);
    await target.sql(`UPDATE raw_archive_refs SET received_at=${aged},eligible_at=${aged} WHERE project_id=${project}
      AND source_kind='transcript' AND transcript_id=${transcript}`);

    await target.sql(`INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('retention.raw_days','1',${stamp},'parity')
      ON CONFLICT(leaf) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at,updated_by=excluded.updated_by`);

    let done = false;
    for (let pass = 0; pass < 16; pass += 1) {
      await wake();
      const [eventState] = await target.sql(`SELECT payload_format,payload,payload_bytes FROM events WHERE project_id=${project} AND event_id=${event}`);
      const [toolState] = await target.sql(`SELECT input,input_bytes,input_bundle_id FROM tool_calls WHERE project_id=${project} AND tool_call_id=${tool}`);
      const [rawState] = await target.sql(`SELECT disposition FROM raw_archive_refs WHERE project_id=${project}
        AND source_kind='transcript' AND transcript_id=${transcript}`);
      done = eventState?.payload_format === 'archived' && toolState?.input_bundle_id !== null && rawState?.disposition === 'archived';
      if (done) break;
    }
    expect(done).toBe(true);
    const [eventState] = await target.sql(`SELECT payload,payload_format,payload_bytes FROM events WHERE project_id=${project} AND event_id=${event}`);
    expect(eventState).toEqual({ payload: '{}', payload_format: 'archived', payload_bytes: 0 });
    const [eventRef] = await target.sql(`SELECT a.archive_key,a.receipt_key,a.digest,a.size FROM archive_bundles a JOIN events e ON e.bundle_id=a.id WHERE e.project_id=${project} AND e.event_id=${event}`);
    expect(eventRef.archive_key).toBe(eventRef.digest);
    expect(Number(eventRef.size)).toBeGreaterThan(new TextEncoder().encode(JSON.stringify({responseId,text:responseText})).byteLength);
    expect(typeof eventRef.receipt_key).toBe('string');
    const [toolState] = await target.sql(`SELECT input,input_bytes,input_bundle_id FROM tool_calls WHERE project_id=${project} AND tool_call_id=${tool}`);
    expect(Number(toolState.input_bytes)).toBe(new TextEncoder().encode(fullInput).byteLength);
    expect(new TextEncoder().encode(String(toolState.input)).byteLength).toBeLessThanOrEqual(2048);
    expect(Number.isSafeInteger(toolState.input_bundle_id)).toBe(true);
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

    const abandonedBytes=new TextEncoder().encode(JSON.stringify({ abandoned: crypto.randomUUID() }));
    const abandonedKey=await sha256HexOf(abandonedBytes);
    await expectPersisted(await fetch(`${target.url}/blobs/${abandonedKey}`, {
      method:'POST',headers:captureHeaders({ 'content-type':'application/json',
        'content-length':String(abandonedBytes.byteLength) }),body:abandonedBytes,
    }), 'abandoned archive body');
    const [registered]=await target.sql(`SELECT generation,size FROM blobs WHERE project_id=${project} AND key=${lit(abandonedKey)}`);
    const [identity]=await target.sql(`SELECT envelope_hash FROM events WHERE project_id=${project} AND event_id=${event}`);
    const preparationId=crypto.randomUUID();
    await target.sql(`INSERT INTO prepared_archive_bundles(preparation_id,project_id,archive_key,expires_at)
      VALUES(${lit(preparationId)},${project},${lit(abandonedKey)},${stamp-1})`);
    await target.sql(`INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,
      event_id,envelope_hash,session_id,digest,size,verified_at,durable) VALUES
      (${project},${lit(abandonedKey)},${lit(String(registered.generation))},'bundle',${lit(abandonedKey)},
      ${event},${lit(String(identity.envelope_hash))},${lit(sessionId)},${lit(abandonedKey)},${Number(registered.size)},${stamp},1)`);
    let released=false;
    for(let pass=0;pass<8;pass++) {
      await target.clockWake();
      released=(await target.sql(`SELECT 1 AS held FROM prepared_archive_bundles WHERE preparation_id=${lit(preparationId)}`)).length===0
        &&(await target.sql(`SELECT 1 AS held FROM blobs WHERE project_id=${project} AND key=${lit(abandonedKey)}`)).length===0
        &&(await target.sql(`SELECT 1 AS held FROM object_releases WHERE physical LIKE '%${abandonedKey}%'`)).length===0;
      if(released)break;
    }
    expect(released).toBe(true);
    expect(await (await ownerGet(inputPath)).text()).toBe(fullInput);
    expect(await target.sql(`SELECT archive_key FROM archive_bundles WHERE project_id=${project} AND archive_key=${lit(String(eventRef.archive_key))}`))
      .toEqual([{archive_key:eventRef.archive_key}]);
  },
};
