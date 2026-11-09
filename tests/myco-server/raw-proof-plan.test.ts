import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { rawMemberResourceSql } from '@myco-server-worker/db/raw/resources.js';

const OWNED = 'a'.repeat(64);
const GENERATION = '00000000-0000-4000-8000-000000000001';
const SEED = [
  "INSERT INTO projects(project_id,name,created_at) VALUES('proj_a','a',1)",
  "INSERT INTO members(id,label,created_at) VALUES('member','member',1)",
  "INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES('machine','member',1)",
  `INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
    VALUES('token','member','machine','hash',1,9999999999999,'token',1)`,
  `INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation) VALUES('proj_a','${OWNED}',1,'text/plain','token',1,'${GENERATION}')`,
  // Most of the proofs sit in the one Project, as on a hosted Deployment, and no table statistics exist.
  `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x < 24000)
    INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,event_id,envelope_hash,session_id,digest,size,verified_at,durable)
    SELECT CASE WHEN x <= 17000 THEN 'proj_a' ELSE 'proj_b' END, printf('%064x',x), '${GENERATION}', CASE WHEN x%3=0 THEN 'receipt' ELSE 'document' END,
      printf('doc-%d',x),'e','h','s','d',1,1,1 FROM n`,
];
const UPLOAD_PROOF = `SELECT ${rawMemberResourceSql('?', 'blob', '?', '?')} AS admitted`;
const BINDS = ['proj_a', OWNED, 'member'];

function expectKeySeek(plan: string[]): void {
  const proofs = plan.filter((detail) => /\bp\b/.test(detail) && detail.includes('registered_content_proofs'));
  expect(proofs.length, plan.join('\n')).toBeGreaterThan(0);
  expect(proofs.every((detail) => detail.includes('idx_registered_content_proofs_key (project_id=? AND key=?)')), plan.join('\n')).toBe(true);
}

it('the upload ownership proof seeks the proof key index on native SQLite and D1', async () => {
  const sqlite = new Database(':memory:');
  for (const step of SCHEMA_STEPS) for (const sql of step.statements) sqlite.exec(sql);
  for (const sql of SEED) sqlite.exec(sql);
  expectKeySeek((sqlite.query(`EXPLAIN QUERY PLAN ${UPLOAD_PROOF}`).all(...BINDS) as { detail: string }[]).map((row) => row.detail));
  expect(sqlite.query(UPLOAD_PROOF).get(...BINDS)).toEqual({ admitted: 1 });
  sqlite.close();

  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  try {
    const d1 = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) await d1.batch(step.statements.map((sql) => d1.prepare(sql)));
    for (const sql of SEED) await d1.prepare(sql).run();
    expectKeySeek((await d1.prepare(`EXPLAIN QUERY PLAN ${UPLOAD_PROOF}`).bind(...BINDS).all<{ detail: string }>()).results.map((row) => row.detail));
    const run = await d1.prepare(UPLOAD_PROOF).bind(...BINDS).all<{ admitted: number }>();
    expect(run.results).toEqual([{ admitted: 1 }]);
    expect(run.meta.rows_read).toBeLessThan(40);
  } finally { await mf.dispose(); }
}, 60_000);
