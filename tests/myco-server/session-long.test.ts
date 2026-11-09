import { encodeCard, renderCard } from '@goondocks/myco-shared/turn-card';
import { measuredContentEnv } from '@myco-server-worker/core/content-budget.js';
import { WAKE_JOB_STATEMENT_LIMIT, WAKE_JOB_BLOB_LIMIT } from '@myco-server-worker/core/tick.js';
import { readPageChunk } from '@myco-server-worker/content/document-reader.js';
import { encodePageChunk } from '@myco-server-worker/content/document.js';
import { sha256HexOf } from '@myco-server-worker/hash.js';
import { prepareDerivedStream } from '@myco-server-worker/core/registered-content.js';
import { blobObjectKeySql } from '@myco-server-worker/core/blob-objects.js';
import type { ChunkRow } from '@myco-server-worker/content/document-reader.js';
import { expect, test } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { publishDocuments } from '@myco-server-worker/ingest/publish.js';
import { locatePrompts } from '@myco-server-worker/ingest/document-locators.js';
import { ingestEvent } from '@myco-server-worker/ingest/events.js';
import { cardWriteStatement, NONE_CARD } from '@myco-server-worker/core/turn-cards.js';
import { sessionProgressStatement } from '@myco-server-worker/db/learning/progress.js';
import { commit } from '@myco-server-worker/db/index.js';
import { createBackup, backupArtifact, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { blobObjectKey } from '@myco-server-worker/core/blob-objects.js';
import { asOwner, OWNER_ENV, LINKED_SUB } from './helpers/owner.js';
import { captureDocumentTranscript, withDocumentStores } from './helpers/document-stores.js';
import { envelope, memoryBlobStore, recordingLimiter, uuid } from './helpers/fixtures.js';
import type { CatalogTurnRow } from '@myco-server-worker/read/document-catalog.js';
import { documentTurnDetail, type DocumentTurnDetail } from '@myco-server-worker/content/session-turns.js';

const line = (type: string, payload: Record<string, unknown>) => JSON.stringify({ type, payload }) + '\n';
const user = (turn: string) => line('turn_context', { turn_id: turn })
  + line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: turn }] });
const output = (id: string) => line('response_item', { type: 'function_call_output', call_id: id, output: 'ok' });
const limits = () => ({ calls: 500, deadline: Date.now() + 60_000, clock: Date.now });

test('long-session routes keep exact rollups across sealed pages, late outcomes and file filters on native and D1', async () => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore(), now = Date.now() - 3_600_000;
    let text = user('wide');
    for (let i = 0; i < 160; i += 1) {
      const name = i === 0 ? 'apply_patch' : i === 1 ? 'Read' : i < 4 ? 'mcp__myco__myco_spores' : `tool${i % 10}`;
      text += line('response_item', i === 0
        ? { type: 'custom_tool_call', call_id: `c${i}`, name, input: '*** Begin Patch\n*** Add File: edited.ts\n+ok\n*** End Patch' }
        : { type: 'function_call', call_id: `c${i}`, name, arguments: JSON.stringify({ op: 'save', path: i === 1 ? 'read.ts' : i === 150 ? 'late-read.ts' : undefined, padding: 'x'.repeat(56_000) }) });
      if (i !== 3 && i !== 159) text += output(`c${i}`);
    }
    text += line('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'closing reply past the head pages' }] });
    text += user('middle') + user('last');
    const transcript = 'tx_' + 'a'.repeat(32);
    const env = await captureDocumentTranscript(db, blobs, 'long', transcript, text, now, 0, 'codex');
    for (let pass = 0; pass < 30; pass += 1) if (!(await publishDocuments(env, now + 1_800_000, limits())).more) break;
    const prompts = (await db.prepare(`SELECT prompt_id FROM session_prompts WHERE session_id='long' ORDER BY ord`).all<{ prompt_id: string }>()).results;
    const first = prompts[0]!.prompt_id;
    const token = await db.prepare(`SELECT created_by_token_id AS id FROM sessions WHERE session_id='long'`).first<{ id: string }>();
    expect((await ingestEvent(db, { projectId: 'project', machineId: 'machine', tokenId: token!.id, bodyBytes: 1, now },
      envelope({ eventId: uuid(901), sessionId: 'long', kind: 'tool.failure', createdAt: now + 1,
        payload: { toolCallId: uuid(902), promptId: first, toolName: 'Bash', input: {}, success: false, errorMessage: 'command failed' } }), env)).persisted, target).toBe(true);
    await publishDocuments(env, now + 1_800_001, limits());
    await db.prepare(`UPDATE members SET role='admin',github_id=? WHERE id='member'`).bind(LINKED_SUB).run();
    const bindings = { MYCO_DB: db, BUCKET: blobs, ...OWNER_ENV, SOURCE_LIMIT: recordingLimiter(), TOKEN_LIMIT: recordingLimiter() };
    const base = '/api/projects/project/sessions/long';
    const get = async <T,>(path: string) => {
      const response = await worker.fetch(await asOwner(db, base + path), bindings);
      expect(response.status, target + path).toBe(200);
      return response.json() as Promise<T>;
    };
    const list = () => get<{ rows: CatalogTurnRow[] }>('/turns');
    const wide = (await list()).rows[0]!;
    expect(wide, target).toMatchObject({ toolCallCount: 161, failedTools: 3, mycoCalls: 2, headline: null,
      toolRollup: { filesEdited: 1, firstError: 'tool call has no result in the transcript', myco: [{ name: 'myco_spores:save', count: 2, failed: 1 }] } });
    expect(wide.toolRollup!.tools.length, target).toBe(9);
    expect(wide.toolRollup!.tools.reduce((n, row) => n + row.count, 0), target).toBe(161);
    expect((await db.prepare(`SELECT page FROM session_pages WHERE owner=? ORDER BY page DESC LIMIT 1`).bind(first).first<{ page: number }>())!.page, target).toBeGreaterThan(4);
    expect(await db.prepare("SELECT 1 AS sealed FROM session_pages WHERE owner=? AND sealed=1 LIMIT 1").bind(first).first(), target).not.toBeNull();
    const detail = await get<DocumentTurnDetail>('/turns/' + first);
    expect(detail.toolCounts.total, target).toBe(161);
    expect(detail.toolCounts.shown, target).toBeLessThan(161);
    expect(detail.tools, target).toMatchObject({ total: 161, failed: 3, complete: false, files: ['edited.ts'], filesNamed: 3 });
    expect(detail.responses.map(reply => reply.text), target).toEqual(['closing reply past the head pages']);
    for (const filter of ['failed', 'myco']) expect((await get<{ rows: CatalogTurnRow[] }>('/turns?filter=' + filter)).rows.map(r => r.promptId), target).toEqual([first]);
    expect((await get<{ rows: CatalogTurnRow[] }>('/turns?around=' + prompts[1]!.prompt_id + '&limit=3')).rows.map(r => r.promptId), target).toEqual(prompts.map(r => r.prompt_id));
    const around = await get<{ rows: CatalogTurnRow[]; cursor: string }>('/turns?around=' + prompts[1]!.prompt_id + '&limit=2&order=desc');
    const rest = await get<{ rows: CatalogTurnRow[] }>('/turns?around=' + prompts[1]!.prompt_id + '&limit=2&order=desc&cursor=' + encodeURIComponent(around.cursor));
    expect([...around.rows, ...rest.rows].map(row => row.promptId), target).toEqual(prompts.map(row => row.prompt_id).reverse());
    const edited = await get<{ files: unknown[]; shellEditsUnseen: boolean }>('/files?kind=edited');
    expect(edited, target).toMatchObject({ files: [{ path: 'edited.ts', calls: 1, edits: 1, lastTurn: first }], shellEditsUnseen: true });
    expect(await get('/files?kind=read'), target).toMatchObject({ files: [{ path: 'late-read.ts', calls: 1, edits: 0, lastTurn: first }, { path: 'read.ts', calls: 1, edits: 0, lastTurn: first }] });
    expect(await get(''), target).toMatchObject({ filesEdited: 1, counts: { failedTools: 3, userPrompts: 3, mycoCalls: 2 } });
    expect(await get('/activity'), target).toEqual({ rows: [], cursor: null });
    const card = { ...NONE_CARD('mechanical'), done: 'Ran the build.\nOutcome: quoted inside Done', files: ['src/a, b.ts'], outcome: 'Completed the change', decisions: [{ decision: 'ship', reason: 'ready' }] };
    const current = await db.prepare(`SELECT changes FROM turn_cards WHERE turn_key=?`).bind(first).first<{ changes: number }>();
    await commit(db, cardWriteStatement('project', 'long', { turnKey: first, changes: current!.changes }, {
      value: card, signal: 'high', reason: 'model', sharedWith: null, covered: true, runId: null, model: null,
    }, now), sessionProgressStatement('project', 'long', now));
    expect((await get<{ rows: CatalogTurnRow[] }>('/turns?filter=key')).rows[0], target).toMatchObject({ headline: 'Completed the change', signal: 'high', marks: { decisions: true, errors: false } });
    expect((await get<DocumentTurnDetail>('/turns/' + first)).card, target).toBe(encodeCard(card));
    expect(await db.prepare('SELECT card,fields FROM turn_cards WHERE project_id=? AND session_id=? AND turn_key=?').bind('project', 'long', first).first(), target).toEqual({ card: renderCard(card), fields: encodeCard(card) });
    const next = await get<{ files: unknown[]; nextCursor: string }>('/files?kind=all&limit=1');
    expect((await get<{ files: { path: string }[] }>('/files?kind=all&limit=1&cursor=' + encodeURIComponent(next.nextCursor))).files.map(row => row.path), target).toEqual(['late-read.ts']);
    const pending = (await db.prepare(`SELECT tool_call_id FROM myco_tool_calls WHERE project_id='project' AND session_id='long' AND success=0 LIMIT 1`)
      .first<{ tool_call_id: string }>())!.tool_call_id;
    expect((await ingestEvent(db, { projectId: 'project', machineId: 'machine', tokenId: token!.id, bodyBytes: 1, now },
      envelope({ eventId: uuid(903), sessionId: 'long', kind: 'tool.use', createdAt: now + 2,
        payload: { toolCallId: pending, promptId: first, toolName: 'mcp__myco__myco_spores', input: { op: 'save' }, success: true } }), env)).persisted, target).toBe(true);
    await publishDocuments(env, now + 1_800_002, limits());
    expect((await list()).rows[0], target).toMatchObject({ toolCallCount: 161, failedTools: 2, mycoCalls: 2,
      toolRollup: { myco: [{ name: 'myco_spores:save', count: 2, failed: 0 }] } });
    const rollup = (await list()).rows[0]!.toolRollup;
    await db.prepare('UPDATE turn_cards SET headline=NULL,marks=NULL WHERE project_id=? AND session_id=? AND turn_key=?').bind('project', 'long', first).run();
    await db.prepare(`DELETE FROM session_edit_paths WHERE session_id='long'`).run();
    await db.prepare(`UPDATE session_prompts SET tool_state=NULL,tool_rollup=NULL,rollup_build=NULL,failed_tools=0,myco_calls=0 WHERE session_id='long'`).run();
    await db.prepare(`UPDATE session_documents SET rollup_after=-1,rollup_page=0,myco_build=0,myco_calls=0 WHERE session_id='long'`).run();
    for (let pass = 0; pass < 10; pass += 1) if (!(await locatePrompts(env, limits())).more) break;
    expect((await list()).rows[0], target).toMatchObject({ toolRollup: rollup, failedTools: 2, mycoCalls: 2, headline: 'Completed the change' });
    expect(await get(''), target).toMatchObject({ counts: { mycoCalls: 2 } });
    for (const path of ['/turns?filter=bad', '/files?kind=bad', '/activity?type=failure', '/activity?tool=Bash']) {
      expect((await worker.fetch(await asOwner(db, base + path), bindings)).status, target).toBe(400);
    }
    for (const [index, success] of [false, true].entries()) {
      const send = (suffix: number, promptId: string | undefined, ok: boolean) => ingestEvent(db,
        { projectId: 'project', machineId: 'machine', tokenId: token!.id, bodyBytes: 1, now },
        envelope({ eventId: uuid(8400 + index * 10 + suffix), sessionId: 'long', kind: ok ? 'tool.use' : 'tool.failure', createdAt: now + suffix,
          payload: { toolCallId: uuid(8500 + index), ...(promptId === undefined ? {} : { promptId }), toolName: 'Bash', input: {}, success: ok, ...(!ok ? { errorMessage: 'owner failure' } : {}) } }), env);
      expect((await send(1, undefined, success)).persisted, target).toBe(true);
      await publishDocuments(env, now + 1_800_010, limits());
      expect((await send(2, first, !success)).persisted, target).toBe(true);
      await ingestEvent(db, { projectId: 'project', machineId: 'machine', tokenId: token!.id, bodyBytes: 1, now },
        envelope({ eventId: uuid(8550 + index), sessionId: 'long', kind: 'tool.use', createdAt: now + 3,
          payload: { toolCallId: uuid(8560 + index), promptId: first, toolName: 'Read', input: {}, success: true } }), env);
      await publishDocuments(env, now + 1_800_020, limits());
      expect((await list()).rows[0], target).toMatchObject({ toolCallCount: 162 + index, failedTools: 2, mycoCalls: 2 });
    }
    await ingestEvent(db, { projectId: 'project', machineId: 'machine', tokenId: token!.id, bodyBytes: 1, now },
      envelope({ eventId: uuid(8600), sessionId: 'long', kind: 'tool.failure', createdAt: now + 4,
        payload: { toolCallId: uuid(8601), promptId: first, toolName: 'unknown', input: { path: 'rename-a.ts' }, success: false, errorMessage: 'unknown call' } }), env);
    await publishDocuments(env, now + 1_800_030, limits());
    await db.prepare(`INSERT INTO session_paths(project_id,session_id,generation,path,tool_calls,last_at)
      SELECT 'project','long',1,value,1,1 FROM json_each(?)`).bind(JSON.stringify(Array.from({ length: 496 }, (_, i) => `path-${i}`))).run();
    expect(await get('/files'), target).toMatchObject({ capped: false });
    await ingestEvent(db, { projectId: 'project', machineId: 'machine', tokenId: token!.id, bodyBytes: 1, now },
      envelope({ eventId: uuid(8602), sessionId: 'long', kind: 'tool.use', createdAt: now + 5,
        payload: { toolCallId: uuid(8601), promptId: first, toolName: 'Read', input: { path: 'rename-b.ts' }, success: true } }), env);
    await publishDocuments(env, now + 1_800_040, limits());
    expect(await get('/files'), target).toMatchObject({ capped: false });
    expect((await db.prepare("SELECT path FROM session_paths WHERE session_id='long' AND path IN ('rename-a.ts','rename-b.ts') LIMIT 2")
      .all<{ path: string }>()).results, target).toEqual([{ path: 'rename-b.ts' }]);
    await db.prepare("INSERT INTO session_paths(project_id,session_id,generation,path,tool_calls,last_at) VALUES('project','long',1,'dropped.ts',1,1)").run();
    expect(await get('/files'), target).toMatchObject({ capped: true });
    expect((await db.prepare(`SELECT COUNT(*) n FROM session_paths WHERE session_id='long'`).first<{ n: number }>())!.n, target).toBe(500);
    let overflow = user('overflow');
    for (let i = 0; i < 501; i += 1) overflow += line('response_item', { type: 'custom_tool_call', call_id: `f${i}`, name: 'apply_patch',
      input: `*** Begin Patch\n*** Add File: overflow-${i}.ts\n+ok\n*** End Patch` }) + output(`f${i}`);
    await captureDocumentTranscript(db, blobs, 'long', 'tx_' + 'd'.repeat(32), overflow, now + 3, 0, 'codex');
    for (let pass = 0; pass < 10; pass += 1) if (!(await publishDocuments(env, now + 1_800_003, limits())).more) break;
    expect(await get(''), target).toMatchObject({ filesEdited: 502 });
  });
});

test('summary catch-up resumes on the publisher budget and preserves cards in backups', async () => {
  const artifacts = new Map<string, { text: string; blobs: ReturnType<typeof memoryBlobStore>; rows: Record<string, unknown>[]; turn: string }>();
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore(), now = Date.now() - 3_600_000;
    const patch = '*** Begin Patch\n*** Update File: old.ts\n-old\n+' + 'x'.repeat(300_000) + '\n*** Add File: late.ts\n+new\n*** End Patch';
    let text = user('old') + line('response_item', { type: 'function_call', call_id: 'edit', name: 'apply_patch', arguments: JSON.stringify({ input: patch }) }) + output('edit');
    for (let i = 0; i < 3; i += 1) text += line('response_item', { type: 'function_call', call_id: `m${i}`, name: 'mcp__myco__myco_spores',
      arguments: JSON.stringify({ op: 'get', padding: 'x'.repeat(300_000) }) });
    text += user('end');
    const env = await captureDocumentTranscript(db, blobs, 'old', 'tx_' + 'b'.repeat(32), text, now, 0, 'codex');
    for (let pass = 0; pass < 10; pass += 1) if (!(await publishDocuments(env, now + 1_800_000, limits())).more) break;
    const turn = (await db.prepare(`SELECT prompt_id FROM session_prompts WHERE session_id='old' ORDER BY ord LIMIT 1`).first<{ prompt_id: string }>())!.prompt_id;
    const chunk = (await db.prepare(`SELECT c.*,${blobObjectKeySql('c.project_id','c.blob_key',"(SELECT generation FROM blobs WHERE project_id=c.project_id AND key=c.blob_key)")} AS object_key
      FROM session_chunks c WHERE project_id='project' AND session_id='old' AND kind='page' ORDER BY chunk_no LIMIT 1`).first<ChunkRow>())!;
    const decoded = await readPageChunk(env, chunk);
    for (const page of decoded.pages) for (const record of page.records) if (record.k === 'tool') {
      delete record.files_affected; delete record.harness; record.myco_tool = null; record.myco_op = null;
    }
    const bytes = new Uint8Array(await encodePageChunk(decoded)), key = await sha256HexOf(bytes);
    const token = (await db.prepare(`SELECT created_by_token_id FROM sessions WHERE session_id='old'`).first<{created_by_token_id:string}>())!.created_by_token_id;
    await prepareDerivedStream(env,{projectId:'project',sessionId:'old',tokenId:token,sourceKind:'document',eventId:'legacy-page',resourceId:'legacy-page',envelopeHash:'legacy-page'},
      {size:bytes.length,digest:key,stream:()=>new Blob([bytes]).stream()},now,{sql:'1',params:[]});
    await db.prepare(`UPDATE session_chunks SET blob_key=?,bytes=?,source_id='legacy-page' WHERE project_id='project' AND session_id='old' AND chunk_no=?`)
      .bind(key,bytes.length,chunk.chunk_no).run();
    await db.prepare(`UPDATE session_prompts SET tool_state=NULL,tool_rollup=NULL,rollup_build=NULL,failed_tools=0,myco_calls=0 WHERE session_id='old'`).run();
    await db.prepare("DELETE FROM session_paths WHERE session_id='old'").run();
    await db.prepare(`DELETE FROM session_edit_paths WHERE session_id='old'`).run();
    await db.prepare(`UPDATE session_documents SET rollup_after=-1,rollup_page=0,rollup_record=0,myco_build=0,myco_calls=0 WHERE session_id='old'`).run();
    await db.prepare(`UPDATE turn_cards SET headline=NULL,marks=NULL,fields=NULL,card='Done: recovered\nOutcome: shipped\nErrors:\n- fixed',signal='high' WHERE turn_key=?`).bind(turn).run();
    expect(await locatePrompts(env, { calls: 500, deadline: 0, clock: () => 1 }), target).toEqual({ changed: 0, more: true });
    await locatePrompts(env, limits());
    expect((await db.prepare("SELECT rollup_record FROM session_documents WHERE session_id='old'").first<{rollup_record:number}>())!.rollup_record,target).toBeGreaterThan(0);
    for (let pass = 0; pass < 10; pass += 1) if (!(await locatePrompts(env, limits())).more) break;
    expect(await db.prepare(`SELECT files_edited,rollup_after FROM session_documents WHERE session_id='old'`).first(), target).toEqual({ files_edited: 2, rollup_after: null });
    expect(JSON.parse((await db.prepare(`SELECT tool_rollup FROM session_prompts WHERE prompt_id=?`).bind(turn).first<{ tool_rollup: string }>())!.tool_rollup), target).toMatchObject({ filesEdited: 2, myco: [{ name: 'myco_spores:get', count: 3, failed: 3 }] });
    expect((await db.prepare("SELECT path FROM session_paths WHERE session_id='old' ORDER BY path LIMIT 500").all<{path:string}>()).results,target).toEqual([{path:'late.ts'},{path:'old.ts'}]);
    expect(await db.prepare("SELECT myco_calls FROM session_documents WHERE session_id='old'").first(),target).toEqual({myco_calls:3});
    const card = await db.prepare(`SELECT headline,marks FROM turn_cards WHERE turn_key=?`).bind(turn).first<{ headline: string; marks: string }>();
    expect(card!.headline, target).toBe('shipped');
    expect(JSON.parse(card!.marks), target).toMatchObject({ errors: true });
    const missing = (await db.prepare("SELECT tool_call_id FROM myco_tool_calls WHERE project_id='project' AND session_id='old' AND success=0 LIMIT 1").first<{tool_call_id:string}>())!.tool_call_id;
    expect((await ingestEvent(db,{projectId:'project',machineId:'machine',tokenId:token,bodyBytes:1,now},
      envelope({eventId:uuid(17001),sessionId:'old',kind:'tool.use',createdAt:now+1,payload:{toolCallId:missing,promptId:turn,toolName:'unknown',input:{},success:true}}),env)).persisted,target).toBe(true);
    const bodyKeys = (await db.prepare(`SELECT ${blobObjectKeySql('project_id','blob_key',"(SELECT generation FROM blobs b WHERE b.project_id=session_chunks.project_id AND b.key=session_chunks.blob_key)")} AS key
      FROM session_chunks WHERE project_id='project' AND session_id='old' AND kind='body' AND metadata=0 LIMIT 500`).all<{key:string}>()).results.map(row=>row.key);
    const before = blobs.gets.length;
    await publishDocuments(env,now+1_800_001,limits());
    expect(blobs.gets.slice(before).some(row=>bodyKeys.includes(row.key)),target).toBe(false);
    const detail = (await documentTurnDetail(env,{projectId:'project'},'old',turn))!;
    expect(detail.tools.files,target).toEqual(['old.ts','late.ts']);
    expect(detail.tools.myco,target).toEqual([{tool:'myco_spores',op:'get',count:3,failed:2}]);
    expect(detail.tools.filesNamed,target).toBe(2);
    const backup = await createBackup(db, blobs, { producer: 'test', now: Date.now() });
    const artifact = (await backupArtifact(db, blobs, backup.id))!;
    expect(artifact.text, target).toContain('"headline":"shipped"');
    artifacts.set(target, { text: artifact.text, blobs, turn, rows: (await db.prepare('SELECT * FROM blobs').all<Record<string, unknown>>()).results });
  });
  await withDocumentStores(async (db, target) => {
    const source = artifacts.get(target)!, blobs = memoryBlobStore();
    for (const [index, row] of source.rows.entries()) {
      const generation = uuid(40000 + index), columns = Object.keys(row);
      const bytes = source.blobs.objects.get(blobObjectKey(String(row.project_id), String(row.key), row.generation as string | null))!;
      blobs.seed(blobObjectKey(String(row.project_id), String(row.key), generation), bytes);
      await db.prepare(`INSERT INTO blobs(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`)
        .bind(...columns.map(column => column === 'generation' ? generation : row[column])).run();
    }
    await restoreArtifact(db, { text: source.text, blobs, allowForeignLineage: true, authorization: { kind: 'recovery' } });
    expect(await db.prepare(`SELECT files_edited,myco_calls FROM session_documents WHERE session_id='old'`).first(), target).toEqual({ files_edited: 2, myco_calls: 3 });
    expect(await db.prepare(`SELECT headline FROM turn_cards WHERE turn_key=?`).bind(source.turn).first(), target).toEqual({ headline: 'shipped' });
    const rollup = await db.prepare(`SELECT tool_rollup FROM session_prompts WHERE prompt_id=?`).bind(source.turn).first<{ tool_rollup: string }>();
    expect(JSON.parse(rollup!.tool_rollup), target).toMatchObject({ filesEdited: 2, myco: [{ name: 'myco_spores:get', count: 3, failed: 2 }] });
  });
}, 60_000);

test('bulk publication fits one wake within its statement budget', async () => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore(), now = Date.now() - 3_600_000;
    const turns = 1500;
    let text = '';
    for (let t = 0; t < turns; t += 1) {
      text += user('short' + t);
      for (let i = 0; i < 4; i += 1) text += line('response_item', { type: 'function_call', call_id: `c${t}_${i}`, name: 'Read',
        arguments: JSON.stringify({ path: `packages/some/fairly/long/path/to/a/source/file-${t}-${i}.ts` }) }) + output(`c${t}_${i}`);
    }
    const env = await captureDocumentTranscript(db, blobs, 'bulk', 'tx_' + 'c'.repeat(32), text, now, 0, 'codex');
    const measured = measuredContentEnv(env, { statements: WAKE_JOB_STATEMENT_LIMIT, blobCalls: WAKE_JOB_BLOB_LIMIT });
    await publishDocuments(measured.env, now + 1_800_000, limits());
    expect(await db.prepare("SELECT COUNT(*) n FROM session_prompts WHERE session_id='bulk'").first(), target).toEqual({ n: turns });
    expect((await db.prepare("SELECT COUNT(*) n FROM session_chunks WHERE session_id='bulk' AND kind='page'").first<{ n: number }>())!.n, target).toBeGreaterThan(1);
    expect(measured.usage.statements, target).toBeLessThan(WAKE_JOB_STATEMENT_LIMIT);
  });
}, 180_000);

test('a growing 9000-call turn keeps bounded values', async () => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore(), now = Date.now() - 3_600_000;
    let text = user('huge');
    for (let i = 0; i < 9000; i += 1) text += line('response_item', { type: 'function_call', call_id: 'huge' + i, name: 'Read',
      arguments: JSON.stringify({ path: `some/longish/directory/layout/for/a/file/number/${i}.ts` }) });
    const huge = await captureDocumentTranscript(db, blobs, 'huge', 'tx_' + 'd'.repeat(32), text + user('end'), now, 0, 'codex');
    for (let wake = 0; wake < 30; wake += 1) if (!(await publishDocuments(huge, now + 2_000_000 + wake * 3_600_000, limits())).more) break;
    const turn = (await db.prepare("SELECT prompt_id,tools,failed_tools,length(tool_state) bytes FROM session_prompts WHERE session_id='huge' ORDER BY tools DESC LIMIT 1")
      .first<{ prompt_id: string; tools: number; failed_tools: number; bytes: number }>())!;
    expect(turn, target).toMatchObject({ tools: 9000, failed_tools: 9000 });
    expect(turn.bytes, target).toBeLessThan(256);
    const token = (await db.prepare("SELECT created_by_token_id id FROM sessions WHERE session_id='huge'").first<{ id: string }>())!.id;
    await ingestEvent(db, { projectId: 'project', machineId: 'machine', tokenId: token, bodyBytes: 1, now },
      envelope({ eventId: uuid(8100), sessionId: 'huge', kind: 'tool.use', createdAt: now + 1,
        payload: { toolCallId: uuid(8101), promptId: turn.prompt_id, toolName: 'Bash', input: {}, success: true } }), huge);
    await publishDocuments(huge, now + 9_000_000_000, limits());
    expect(await db.prepare('SELECT tools,failed_tools,files_named FROM session_prompts WHERE prompt_id=?').bind(turn.prompt_id).first(), target)
      .toEqual({ tools: 9001, failed_tools: 9000, files_named: 9000 });
  });
}, 180_000);

test('catch-up backs off broken documents and progresses past an active document', async () => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore(), now = Date.now() - 3_600_000;
    const wide = (tag: string) => user(tag) + Array.from({ length: 160 }, (_, i) =>
      line('response_item', { type: 'function_call', call_id: tag + i, name: 'Read',
        arguments: JSON.stringify({ path: tag + '.ts', padding: 'q'.repeat(60_000) }) }) + output(tag + i)).join('');
    const env = await captureDocumentTranscript(db, blobs, 'a-active', 'tx_' + 'e'.repeat(32), wide('a'), now, 0, 'codex');
    await captureDocumentTranscript(db, blobs, 'z-idle', 'tx_' + 'f'.repeat(32), wide('z'), now, 0, 'codex');
    await captureDocumentTranscript(db, blobs, 'b-broken', 'tx_' + '9'.repeat(32), user('broken') +
      line('response_item', { type: 'function_call', call_id: 'broken', name: 'apply_patch',
        arguments: JSON.stringify({ input: '*** Begin Patch\n*** Add File: broken.ts\n+' + 'x'.repeat(300_000) + '\n*** End Patch' }) }) + output('broken'), now, 0, 'codex');
    for (let pass = 0; pass < 30; pass += 1) if (!(await publishDocuments(env, now + 1_800_000, limits())).more) break;
    const chunk = (await db.prepare(`SELECT c.*,${blobObjectKeySql('c.project_id','c.blob_key',"(SELECT generation FROM blobs WHERE project_id=c.project_id AND key=c.blob_key)")} object_key
      FROM session_chunks c WHERE session_id='b-broken' AND kind='page' ORDER BY chunk_no LIMIT 1`).first<ChunkRow>())!;
    const decoded = await readPageChunk(env, chunk);
    for (const page of decoded.pages) for (const record of page.records) if (record.k === 'tool') { delete record.harness; delete record.files_affected; }
    const bytes = new Uint8Array(await encodePageChunk(decoded)), key = await sha256HexOf(bytes);
    const token = (await db.prepare("SELECT created_by_token_id id FROM sessions WHERE session_id='a-active'").first<{ id: string }>())!.id;
    await prepareDerivedStream(env, { projectId: 'project', sessionId: 'b-broken', tokenId: token, sourceKind: 'document',
      eventId: 'broken-page', resourceId: 'broken-page', envelopeHash: 'broken-page' },
      { size: bytes.length, digest: key, stream: () => new Blob([bytes]).stream() }, now, { sql: '1', params: [] });
    await db.prepare("UPDATE session_chunks SET blob_key=?,bytes=?,source_id='broken-page' WHERE session_id='b-broken' AND chunk_no=?").bind(key, bytes.length, chunk.chunk_no).run();
    const missing = (await db.prepare("SELECT blob_key FROM session_chunks WHERE session_id='b-broken' AND kind='body' LIMIT 1").first<{ blob_key: string }>())!.blob_key;
    for (const key of blobs.objects.keys()) if (key.includes(missing)) blobs.objects.delete(key);
    await db.prepare('UPDATE session_prompts SET tool_state=NULL,tool_rollup=NULL,rollup_build=NULL').run();
    await db.prepare('UPDATE session_documents SET rollup_after=-1,rollup_page=0,rollup_record=0,myco_build=0,paths_build=NULL').run();
    await db.prepare("UPDATE turn_cards SET state='pending',settle_at=0,due_at=NULL WHERE session_id='z-idle'").run();
    const prompt = (await db.prepare("SELECT prompt_id FROM session_prompts WHERE session_id='a-active' LIMIT 1").first<{ prompt_id: string }>())!.prompt_id;
    for (let cycle = 0; cycle < 12; cycle += 1) {
      await locatePrompts(env, limits());
      await ingestEvent(db, { projectId: 'project', machineId: 'machine', tokenId: token, bodyBytes: 1, now },
        envelope({ eventId: uuid(8200 + cycle), sessionId: 'a-active', kind: 'tool.use', createdAt: now + cycle,
          payload: { toolCallId: uuid(8300 + cycle), promptId: prompt, toolName: 'Bash', input: {}, success: true } }), env);
      await publishDocuments(env, now + 1_900_000 + cycle * 60_000, limits());
      if (cycle === 0) expect(await db.prepare("SELECT rollup_after FROM session_documents WHERE session_id='z-idle'").first(), target)
        .not.toEqual({ rollup_after: -1 });
    }
    expect(await db.prepare("SELECT rollup_after FROM session_documents WHERE session_id='z-idle'").first(), target).toEqual({ rollup_after: null });
    expect(await db.prepare("SELECT rollup_after FROM session_documents WHERE session_id='a-active'").first(), target).toEqual({ rollup_after: null });
    const broken = (await db.prepare("SELECT rollup_due,rollup_failure FROM session_documents WHERE session_id='b-broken'").first<{ rollup_due: number; rollup_failure: string }>())!;
    expect(broken.rollup_failure, target).toBe('document_object_missing');
    expect(broken.rollup_due, target).toBeGreaterThan(Date.now());
    expect(await db.prepare("SELECT 1 settled FROM turn_cards WHERE session_id='z-idle' AND settle_at IS NULL LIMIT 1").first(), target).not.toBeNull();
    const pageKey = (await db.prepare(`SELECT ${blobObjectKeySql('c.project_id','c.blob_key',"(SELECT generation FROM blobs WHERE project_id=c.project_id AND key=c.blob_key)")} key
      FROM session_chunks c WHERE session_id='b-broken' AND kind='page' ORDER BY chunk_no LIMIT 1`).first<{ key: string }>())!.key;
    blobs.objects.delete(pageKey);
    await db.prepare("UPDATE turn_cards SET state='pending',settle_at=0 WHERE session_id='b-broken'").run();
    await publishDocuments(env, now + 3_000_000, limits());
    expect((await db.prepare("SELECT settle_at FROM turn_cards WHERE session_id='b-broken' LIMIT 1").first<{ settle_at: number }>())!.settle_at, target)
      .toBeGreaterThan(now + 3_000_000);

  });
}, 120_000);

test('active four-chunk catch-up completes in the pass that reads its tail', async () => {
  await withDocumentStores(async (db, target) => {
    const blobs = memoryBlobStore(), now = Date.now() - 3_600_000;
    let text = user('active tail');
    for (let i = 0; i < 62; i += 1) text += line('response_item', { type: 'function_call', call_id: 'tail' + i, name: 'Read',
      arguments: JSON.stringify({ path: 'tail.ts', padding: 'q'.repeat(60_000) }) }) + output('tail' + i);
    const env = await captureDocumentTranscript(db, blobs, 'tail', 'tx_' + '7'.repeat(32), text, now, 0, 'codex');
    for (let pass = 0; pass < 10; pass += 1) if (!(await publishDocuments(env, now + 1_800_000, limits())).more) break;
    expect(await db.prepare("SELECT COUNT(*) n FROM session_chunks WHERE session_id='tail' AND kind='page'").first(), target).toEqual({ n: 4 });
    await db.prepare("UPDATE session_documents SET rollup_after=-1,rollup_page=0,rollup_record=0,myco_build=0,paths_build=NULL WHERE session_id='tail'").run();
    await db.prepare("UPDATE session_prompts SET tool_state=NULL,tool_rollup=NULL,rollup_build=NULL WHERE session_id='tail'").run();
    const prompt = (await db.prepare("SELECT prompt_id FROM session_prompts WHERE session_id='tail' LIMIT 1").first<{ prompt_id: string }>())!.prompt_id;
    const token = (await db.prepare("SELECT created_by_token_id id FROM sessions WHERE session_id='tail'").first<{ id: string }>())!.id;
    for (let wake = 0; wake < 2; wake += 1) {
      await ingestEvent(db, { projectId: 'project', machineId: 'machine', tokenId: token, bodyBytes: 1, now },
        envelope({ eventId: uuid(22000 + wake), sessionId: 'tail', kind: 'tool.use', createdAt: now + wake,
          payload: { toolCallId: uuid(23000 + wake), promptId: prompt, toolName: 'Bash', input: {}, success: true } }), env);
      await publishDocuments(env, now + 2_000_000 + wake * 60_000, limits());
      expect(await db.prepare("SELECT rollup_after,rollup_epoch FROM session_documents WHERE session_id='tail'").first(), target)
        .toEqual({ rollup_after: null, rollup_epoch: 0 });
    }
  });
});
