import { expect, it } from 'bun:test';
import { carriedBytes } from '@myco-server-worker/db/identity/capture-credential.js';
import { sqliteEnv } from './helpers/fixtures.js';

it('carries a rotated credential\'s live reservations, excluding expired ones, up to a fixed number of reservations', async () => {
  const f = sqliteEnv();
  const now = 1_000;
  f.sqlite.run(`INSERT INTO members(id,label,created_at) VALUES('m','m',1)`);
  f.sqlite.run(`INSERT INTO member_credentials(id,member_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at,bytes_written) VALUES('old','m','h',1,99999,'old',1,50)`);
  const insert = f.sqlite.query(`INSERT INTO blob_reservations(reservation_id,project_id,key,token_id,size,expires_at) VALUES(?,'proj_1',?,'old',?,?)`);
  insert.run('expired', 'k', 1000, now - 1);
  for (let index = 0; index < 300; index += 1) insert.run(`live-${index}`, `k-${index}`, 10, now + 1 + index);
  const value = (f.sqlite.query(`SELECT ${carriedBytes('?1', '?2')} AS bytes`).get('old', now) as { bytes: number }).bytes;
  expect(value).toBe(50 + 256 * 10);
});
