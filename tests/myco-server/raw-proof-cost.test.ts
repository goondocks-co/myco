import { expect, it } from 'bun:test';
import { rawMemberResourceSql } from '@myco-server-worker/db/raw/resources.js';
import { d1TwoScale, eachUnit, expectTwoScale } from './helpers/two-scale.js';

const OWNED = 'a'.repeat(64);
const GENERATION = '00000000-0000-4000-8000-000000000001';
const UPLOAD_PROOF = `SELECT ${rawMemberResourceSql('?', 'blob', '?', '?')} AS admitted`;

it('the upload ownership proof costs the same as a Project\'s registered proofs grow', async () => {
  expectTwoScale(await d1TwoScale({
    sizes: [2_000, 24_000],
    setup: async (db) => {
      for (const sql of [
        "INSERT INTO projects(project_id,name,created_at) VALUES('proj_a','a',1)",
        "INSERT INTO members(id,label,created_at) VALUES('member','member',1)",
        "INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES('machine','member',1)",
        `INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
          VALUES('token','member','machine','hash',1,9999999999999,'token',1)`,
        `INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation) VALUES('proj_a','${OWNED}',1,'text/plain','token',1,'${GENERATION}')`,
      ]) await db.prepare(sql).run();
    },
    // Most of the proofs sit in the one Project, as on a hosted Deployment.
    grow: (db, from, to) => eachUnit(db, from, to, `INSERT INTO registered_content_proofs(project_id,key,generation,source_kind,source_id,event_id,envelope_hash,session_id,digest,size,verified_at,durable)
      SELECT CASE WHEN i % 4 = 3 THEN 'proj_b' ELSE 'proj_a' END, printf('%064x',i + 1), ?3, CASE WHEN i%3=0 THEN 'receipt' ELSE 'document' END,
        printf('doc-%d',i),'e','h','s','d',1,1,1 FROM n`, GENERATION),
    cases: [{
      name: 'upload ownership proof',
      run: async (db) => expect(await db.prepare(UPLOAD_PROOF).bind('proj_a', OWNED, 'member').first()).toEqual({ admitted: 1 }),
    }],
  }));
}, 120_000);
