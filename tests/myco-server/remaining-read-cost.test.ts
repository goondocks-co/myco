import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { machineActivity } from '@myco-server-worker/read/machines.js';
import { pageProjectPlans } from '@myco-server-worker/read/plans.js';
import { listSessions } from '@myco-server-worker/read/sessions.js';
import { searchProject } from '@myco-server-worker/read/search.js';
import { retiringReceipt } from '@myco-server-worker/core/embedding/selection.js';
import { taskRunFacts } from '@myco-server-worker/core/runs.js';
import { RawResourceReader } from '@myco-server-worker/core/raw-resources.js';
import { handleTranscript } from '@myco-server-worker/api/sessions.js';
import { memoryBlobStore, sqliteEnv } from './helpers/fixtures.js';
import { measuredStore } from './helpers/read-budget.js';

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response(null); } }',
    compatibilityDate: '2026-07-01',
    d1Databases: ['DB'],
  }),
);
let measured: ReturnType<typeof measuredStore>;
beforeAll(async () => {
  const d1 = await mf.getD1Database('DB');
  for (const step of SCHEMA_STEPS) await d1.batch(step.statements.map((sql) => d1.prepare(sql)));
  measured = measuredStore(d1);
  await measured.db.prepare("INSERT INTO members(id,created_at) VALUES('owner',1)").run();
  await measured.db
    .prepare(
      "INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at) VALUES('token','owner','machine','hash',1,9999999999999,'token',1),('token-next','owner','machine','hash-next',2,9999999999999,'token',1)",
    )
    .run();
  await measured.db.prepare("INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES('machine','owner',1)").run();
  await measured.db.prepare("INSERT INTO members(id,created_at) VALUES('other',1)").run();
  await measured.db
    .prepare(
      "INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at) VALUES('foreign','other','other-machine','foreign',1,9999999999999,'foreign',1)",
    )
    .run();
  await measured.db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','agent','built-in',1,1)").run();
}, 60_000);
afterAll(() => mf.dispose());
const seq = `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?)`;
async function project(id: string) {
  await measured.db.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind(id, id).run();
}
function report(name: string, size: number) {
  console.info('READ_COST', JSON.stringify({ name, size, reads: measured.reads(), writes: measured.writes() }));
}

test('machine activity merges complete credential pages with tied times and a continuation', async () => {
  await project('machine');
  await project('machine-b');
  for (const size of [1000, 4000]) {
    await measured.db
      .prepare(
        `${seq} INSERT OR IGNORE INTO events(project_id,event_id,session_id,channel,kind,created_at,received_at,token_id,payload,envelope_hash)
      SELECT CASE WHEN x%3=0 THEN 'machine-b' ELSE 'machine' END,printf('e-%06d',x),'s','capture','session.start',x/3,x,CASE WHEN x%2=0 THEN 'token-next' ELSE 'token' END,'{}','h' FROM n`,
      )
      .bind(size)
      .run();
    measured.reset();
    const first = await machineActivity(measured.db, 'machine');
    report('machine', size);
    expect(first.rows).toHaveLength(50);
    expect(measured.reads()).toBeLessThan(300);
    const second = await machineActivity(measured.db, 'machine', { cursor: first.cursor! });
    expect(new Set([...first.rows, ...second.rows].map((r) => r.eventId)).size).toBe(100);
    const expected = Array.from({ length: size }, (_, i) => ({
      createdAt: Math.floor((i + 1) / 3),
      projectId: (i + 1) % 3 === 0 ? 'machine-b' : 'machine',
      eventId: 'e-' + String(i + 1).padStart(6, '0'),
    }));
    expected.sort((a, b) => b.createdAt - a.createdAt || b.projectId.localeCompare(a.projectId) || b.eventId.localeCompare(a.eventId));
    expect([...first.rows, ...second.rows].map((row) => row.projectId + ':' + row.eventId)).toEqual(
      expected.slice(0, 100).map((row) => row.projectId + ':' + row.eventId),
    );
  }
});

test('project plan pages seek their scoped update order with and without status', async () => {
  await project('plans');
  for (const size of [1000, 4000]) {
    await measured.db
      .prepare(
        `${seq} INSERT OR IGNORE INTO plans(project_id,plan_key,session_id,event_id,machine_id,content,content_hash,status,created_at,updated_at,token_id,received_at)
      SELECT 'plans',printf('p-%06d',x),'s','e','m','body','h',CASE WHEN x%2=0 THEN 'active' ELSE 'completed' END,1,x/3,'token',1 FROM n`,
      )
      .bind(size)
      .run();
    for (const status of [undefined, 'completed']) {
      measured.reset();
      const first = await pageProjectPlans(measured.db, { projectId: 'plans' }, { status });
      report('plans ' + status, size);
      expect(first.rows).toHaveLength(50);
      expect(measured.reads()).toBeLessThan(300);
      const next = await pageProjectPlans(measured.db, { projectId: 'plans' }, { status, cursor: first.cursor! });
      expect(new Set([...first.rows, ...next.rows].map((r) => r.planKey)).size).toBe(100);
    }
  }
});

test('late session pages seek past the newer prefix including timestamp ties', async () => {
  await project('sessions');
  for (const size of [1000, 4000]) {
    await measured.db
      .prepare(
        `${seq} INSERT OR IGNORE INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,started_at)
      SELECT 'sessions',printf('s-%06d',x),'m','token',x/3,x,x/3 FROM n`,
      )
      .bind(size)
      .run();
    measured.reset();
    const result = await listSessions(measured.db, { projectId: 'sessions' }, { cursor: '20:s-000062', fidelity: 'any' });
    report('sessions', size);
    expect(result.rows[0]?.sessionId).toBe('s-000061');
    expect(measured.reads()).toBeLessThan(300);
  }
});

test('full text intersects a common and rare term before loading candidate rows', async () => {
  await project('search');
  for (const size of [1000, 4000]) {
    await measured.db
      .prepare(
        `${seq} INSERT OR IGNORE INTO spores(project_id,id,agent_id,content,observation_type,created_at)
      SELECT 'search',printf('sp-%06d',x),'agent',CASE WHEN x=1 THEN 'common rare' ELSE 'common' END,'decision',1 FROM n`,
      )
      .bind(size)
      .run();
    measured.reset();
    const result = await searchProject(measured.db, { projectId: 'search' }, { query: 'common rare', type: 'spore', mode: 'fts' });
    report('search', size);
    expect(result.results.map((r) => r.id)).toEqual(['sp-000001']);
    expect(measured.reads()).toBeLessThan(150);
    await measured.db
      .prepare(
        `${seq} INSERT OR IGNORE INTO plans(project_id,plan_key,session_id,event_id,machine_id,title,content,content_hash,status,created_at,updated_at,token_id,received_at)
      SELECT 'search',printf('p-%06d',x),'s','e','m','common',CASE WHEN x=1 THEN 'rare' ELSE 'common' END,'h','active',1,1,'token',1 FROM n`,
      )
      .bind(size)
      .run();
    measured.reset();
    expect(
      (await searchProject(measured.db, { projectId: 'search' }, { query: 'common rare', type: 'plan', mode: 'fts' })).results.map(
        (row) => row.id,
      ),
    ).toEqual(['p-000001']);
    report('search plan', size);
    expect(measured.reads()).toBeLessThan(250);
  }
});

test('retirement consumes changed identities without reproving settled receipts', async () => {
  await project('retire');
  for (const size of [1000, 4000]) {
    await measured.db
      .prepare(
        `${seq} INSERT OR IGNORE INTO plans(project_id,plan_key,session_id,event_id,machine_id,content,content_hash,status,created_at,updated_at,token_id,received_at)
      SELECT 'retire',printf('p-%06d',x),'s','e','m','body','h','active',1,1,'token',1 FROM n`,
      )
      .bind(size)
      .run();
    await measured.db
      .prepare(
        `INSERT OR IGNORE INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
      SELECT project_id,'model',record_id,type,record_id,revision,1,1 FROM embedding_versions WHERE project_id='retire'`,
      )
      .run();
    for (let pass = 0; pass < 20; pass++) await retiringReceipt(measured.db, 'retire', ['model'], 100);
    measured.reset();
    expect(await retiringReceipt(measured.db, 'retire', ['model'], 100)).toBeNull();
    report('retirement', size);
    expect(measured.reads()).toBeLessThan(50);
    await measured.db.prepare("UPDATE plans SET content=content||' changed' WHERE project_id='retire' AND plan_key='p-000001'").run();
    expect((await retiringReceipt(measured.db, 'retire', ['model'], 100))?.record_id).toBe('p-000001');
    await measured.db.prepare("DELETE FROM embedding_receipts WHERE project_id='retire' AND record_id='p-000001'").run();
  }
});

test('schedule facts read latest entries and the rolling window independently of old history', async () => {
  await project('runs');
  for (const size of [1000, 4000]) {
    await measured.db
      .prepare(
        `${seq} INSERT OR IGNORE INTO agent_runs(id,project_id,agent_id,task,status,started_at,dispatch_spec)
      SELECT printf('run-%06d',x),'runs','agent','extract-curate','completed',x,'{"actor":"clock"}' FROM n`,
      )
      .bind(size)
      .run();
    await measured.db
      .prepare(
        `${seq} INSERT OR IGNORE INTO agent_runs(id,project_id,agent_id,task,status,started_at,dispatch_spec)
      SELECT printf('manual-%06d',x),'runs','agent','extract-curate','completed',10000+x,'{"actor":"member"}' FROM n`,
      )
      .bind(size)
      .run();
    measured.reset();
    const q = taskRunFacts(measured.db, ['extract-curate'], 10000, 'clock', 'runs');
    const facts = q.read((await q.statement.all<Record<string, unknown>>()).results);
    report('schedule', size);
    expect([...facts.values()]).toEqual([{ live: false, lastEntryAt: size, entriesSince: 0 }]);
    expect(measured.reads()).toBeLessThan(50);
  }
});

test('raw segment pages batch uploader checks and continue past private pieces', async () => {
  await project('raw');
  await measured.db.prepare("INSERT OR IGNORE INTO schema_meta(key,value) VALUES('deployment_id','local-fixture')").run();
  await measured.db
    .prepare(
      "INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,size,first_received_at,last_received_at,token_id) VALUES('raw','t','s','machine',1000,1,1,'token')",
    )
    .run();
  let statements = 0;
  const db = {
    prepare: (sql: string) => {
      statements++;
      return measured.db.prepare(sql);
    },
    batch: measured.db.batch,
  };
  await measured.db
    .prepare(
      `INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,event_id,envelope_hash,session_id,digest,size,verified_at,durable)
    VALUES('raw',printf('%064x',1),'00000000-0000-4000-8000-000000000001','bundle','wrapper','e','h','s','d',1,1,1)`,
    )
    .run();
  for (const size of [1000, 4000]) {
    await measured.db
      .prepare(
        `${seq} INSERT OR IGNORE INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
    SELECT 'raw',printf('%064x',x),1,'text/plain',CASE WHEN x=50 THEN 'foreign' ELSE 'token' END,1,'00000000-0000-4000-8000-000000000001' FROM n`,
      )
      .bind(size)
      .run();
    await measured.db
      .prepare(
        `${seq} INSERT OR IGNORE INTO transcript_segments(project_id,transcript_id,base_offset,length,blob_key,created_at,event_id,token_id,received_at)
    SELECT 'raw','t',x-1,1,printf('%064x',x),1,'segment','token',1 FROM n`,
      )
      .bind(size)
      .run();
    const reader = new RawResourceReader({ db, blobs: memoryBlobStore() }, { projectId: 'raw' }, { kind: 'member', memberId: 'owner' });
    measured.reset();
    statements = 0;
    const result = await reader.transcripts('s');
    report('raw', size);
    console.info('RAW_STATEMENTS', statements);
    expect(result.transcripts).toHaveLength(1);
    expect(result.transcripts[0]!.segments).toHaveLength(48);
    expect(result.transcripts[0]!.segmentsCursor).not.toBeNull();
    expect(statements).toBeLessThan(20);
    expect(measured.reads()).toBeLessThan(400);
    const next = await reader.transcripts('s', { transcriptId: 't', segmentCursor: result.transcripts[0]!.segmentsCursor! });
    expect(next.transcripts[0]!.segments[0]!.baseOffset).toBe(50);
  }
  const native = sqliteEnv();
  try {
    const url = new URL('https://local.invalid/api/projects/raw/sessions/s/transcript');
    const response = await handleTranscript(
      { ...native.serverEnv, db, blobs: memoryBlobStore() },
      {
        request: new Request(url),
        url,
        params: { projectId: 'raw', sessionId: 's' },
        member: { id: 'owner', label: null, role: 'member' },
        session: { aud: 'local-fixture', sub: 'fixture', login: 'fixture', iat: 1, exp: 9999999999999 },
        config: { clientId: 'fixture', clientSecret: 'fixture', sessionSecret: 'fixture'.repeat(8) },
        now: 100,
        source: 'local-fixture',
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ cursor: null, transcript: { transcriptId: 't', segmentsCursor: expect.any(String) } });
  } finally {
    native.sqlite.close();
  }
  await measured.db.prepare("UPDATE members SET revoked_at=1 WHERE id='owner'").run();
  expect(
    (
      await new RawResourceReader(
        { db, blobs: memoryBlobStore() },
        { projectId: 'raw' },
        { kind: 'member', memberId: 'owner' },
      ).transcripts('s')
    ).transcripts,
  ).toEqual([]);
});
