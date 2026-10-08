import { expect } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { seedCredential } from '../myco-server/helpers/d1.js';

const AUTHORITIES = ['member_credentials', 'enrollment_authorities', 'identity_link_authorities', 'external_grants', 'step_up_authorities'] as const;
const RUN = 'carried-run';

export function seedRecoveryAuthority(db: Database): void {
  seedCredential(db, { id: 'carried-live', expiresAt: 9999999999999 });
  db.run("INSERT INTO enrollment_authorities(id,key_hash,created_at,expires_at) VALUES('carried-enrollment','enrollment-hash',1,9999999999999)");
  db.run("INSERT INTO identity_link_authorities(id,key_hash,member_id,created_at,expires_at) VALUES('carried-link','link-hash','mem_machine_1',1,9999999999999)");
  db.run("INSERT INTO external_grants(id,key_hash,project_id,label,created_by,created_at,expires_at) VALUES('carried-grant','grant-hash','proj_1','fixture','mem_machine_1',1,9999999999999)");
  db.run("INSERT INTO step_up_authorities(id,key_hash,purpose,created_at,expires_at) VALUES('carried-stepup','stepup-hash','restore',1,9999999999999)");
  db.run("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('carried-agent','Recovery fixture','built-in',1,1)");
  db.run("INSERT INTO agent_runs(project_id,id,agent_id,status,leased_by,lease_expires_at,resumable) VALUES('proj_1',?,'carried-agent','queued','carried-live',9999999999999,1)", [RUN]);
}

export function recoveryAuthoritySnapshot(db: Database) {
  return {
    authorities: Object.fromEntries(AUTHORITIES.map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY id`).all()])),
    run: db.query('SELECT * FROM agent_runs WHERE id = ?').get(RUN),
  };
}

export function assertRecoveredAuthority(db: Database, source: ReturnType<typeof recoveryAuthoritySnapshot>, mode: 'replacement' | 'fork'): void {
  if (mode === 'replacement') {
    expect(recoveryAuthoritySnapshot(db)).toEqual(source);
    return;
  }
  for (const table of AUTHORITIES) {
    expect(source.authorities[table].length).toBeGreaterThan(0);
    expect(db.query(`SELECT count(*) AS n FROM ${table} WHERE revoked_at IS NULL`).get()).toEqual({ n: 0 });
  }
  expect(db.query('SELECT status, lease_expires_at, resumable FROM agent_runs WHERE id = ?').get(RUN))
    .toEqual({ status: 'failed', lease_expires_at: null, resumable: 0 });
}
