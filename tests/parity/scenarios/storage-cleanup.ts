type PageLocator = { generation: number; owner: string; page: number; revision?: string };
import { expect } from 'bun:test';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { ageRows, expectPersisted, lit, memberHeadersFor, type ParityScenario, type ParityTarget } from '../harness.ts';

import { linkedMember } from '../clients/runs.ts';
import { putSetting, untilPublished } from '../clients/requests.ts';
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
    const responseText = `${searchWord} ${'é🦋'.repeat(2_500)}`;
    const input = { file_path: 'src/whole.ts', patch: `line é🦋\n${'whole input '.repeat(700)}` };
    const fullInput = JSON.stringify(input);
    const output = `output ${'complete '.repeat(350)}`;
    const uploader = await linkedMember(target, String(stamp));
    const uploaderToken = uploader.token;
    const uploaderHeaders = uploader.headers;
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
    const archivedEvent = await post('response', { responseId, promptId, text: responseText }, 'import');
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
    const base=`/api/projects/${target.projectId}/sessions/${sessionId}`;
    type LocatedRow = Record<string, unknown> & { locator: PageLocator };
    const contentRows = (rows: readonly LocatedRow[]) => rows.map(({ locator: _locator, ...content }) => content);
    const processedBody = (kind: string, id: string, locator: PageLocator) => {
      const params = new URLSearchParams({ session: sessionId, generation: String(locator.generation), owner: locator.owner, page: String(locator.page),
        ...(locator.revision === undefined ? {} : { revision: locator.revision }) });
      return ownerGet(`/api/projects/${target.projectId}/processed/${kind}/${id}?${params}`);
    };
    const responseRows=async()=>{
      const response=await ownerGet(`${base}/turns/${promptId}`); if (response.status === 404) return []; expect(response.status).toBe(200);
      return ((await response.json()) as {responses:(LocatedRow & {responseId:string;text:string})[]}).responses.filter(row=>row.responseId===responseId);
    };
    const toolFacts=async()=>{
      const response=await ownerGet(`${base}/turns/${promptId}/tool-calls`); if (response.status === 404) return []; expect(response.status).toBe(200);
      return ((await response.json()) as {rows:LocatedRow[]}).rows.filter(row=>row.toolCallId===toolCallId);
    };
    await untilPublished(target, responseRows, rows => rows.length === 1);
    await untilPublished(target, toolFacts, rows => rows.length === 1);
    const rawPath = `/api/projects/${target.projectId}/blobs/${rawKey}`;
    const transcriptPath = `/api/projects/${target.projectId}/sessions/${sessionId}/transcript`;
    const before = { responses: await responseRows(), tool: await toolFacts() };
    expect(before.responses).toHaveLength(1);
    expect((await rawGet(rawPath)).status).toBe(200);
    expect((await ownerGet(rawPath)).status).toBe(404);
    const [freshInput]=await toolFacts();
    expect(new TextEncoder().encode(String(freshInput!.inputPreview)).byteLength).toBeLessThanOrEqual(2048);
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
    await control(false);
    // The fixture represents a processed transcript and an old raw source while keeping real HTTP upload provenance.
    await ageRows(target, { table: 'transcript_segments', column: 'received_at', byMs: 2 * DAY_MS, match: { project_id: target.projectId, transcript_id: transcriptId } });
    for (const column of ['received_at', 'eligible_at']) await ageRows(target, { table: 'raw_archive_refs', column, byMs: 2 * DAY_MS, match: { project_id: target.projectId, source_kind: 'transcript', transcript_id: transcriptId } });
    expect((await putSetting(target, 'retention.raw_days', 1)).status).toBe(200);

    // Stored source preservation: archival clears the hot payload only after retaining the response identity.
    const eventState = async () => (await target.sql(`SELECT payload,payload_format,payload_bytes FROM events WHERE project_id=${project} AND event_id=${event}`))[0];
    let done = false;
    for (let pass = 0; pass < 16; pass += 1) {
      await wake();
      const response = await rawGet(transcriptPath);
      const state = await response.json() as { transcripts: Array<{ segments: Array<{ availability: string }> }> };
      const source = await eventState();
      done = state.transcripts.some(row => row.segments.some(segment => segment.availability === 'archived')) && source?.payload_format === 'archived' && source.payload_bytes === 0;
      if (done) break;
    }
    expect(done).toBe(true);
    const source = await eventState();
    expect(source).toMatchObject({ payload_format: 'archived', payload_bytes: 0 });
    expect(JSON.parse(String(source.payload))).toMatchObject({ responseId });
    const [toolState]=await toolFacts();
    expect(Number(toolState!.inputBytes)).toBe(new TextEncoder().encode(fullInput).byteLength);
    const fullResponse=await processedBody('tool-input',toolCallId,toolState!.locator);
    expect(fullResponse.status).toBe(200);expect(await fullResponse.text()).toBe(fullInput);
    const responses = await responseRows(), tools = await toolFacts();
    expect(contentRows(responses)).toEqual(contentRows(before.responses));
    expect(contentRows(tools)).toEqual(contentRows(before.tool));
    const responseBody = await processedBody('response',responseId,responses[0]!.locator);
    expect(responseBody.status).toBe(200);
    expect(await responseBody.text()).toBe(responseText);
    const previousInput = await processedBody('tool-input',toolCallId,before.tool[0]!.locator);
    if (previousInput.status === 409) expect(await previousInput.json()).toEqual({ error: 'stale_cursor' });
    else { expect(previousInput.status).toBe(200); expect(await previousInput.text()).toBe(fullInput); }

    const uploaderTranscript = await rawGet(transcriptPath);
    expect(uploaderTranscript.status).toBe(200);
    expect(await uploaderTranscript.json()).toMatchObject({ transcripts: [{ transcriptId, segments: [{ blobKey: rawKey, availability: 'archived' }] }] });
    expect((await ownerGet(transcriptPath)).status).toBe(404);
    expect(await (await rawGet(rawPath)).text()).toBe(rawText);
    expect((await ownerGet(rawPath)).status).toBe(404);

  },
};
