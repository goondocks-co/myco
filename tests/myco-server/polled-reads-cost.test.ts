/** The polled reads cost D1 the same as history grows: Needs you behind a former machine's expired credentials; a Project's statistics, the session lists, the Open filter, Live now and Today behind ended sessions. */
import { expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { MEMBER_TOKEN_TTL_MS } from '@myco-server-worker/constants.js';
import { provisionedHarnessAttention, recordProvisionedHarnessReport } from '@myco-server-worker/core/harness-health.js';
import { sessionQuietBefore } from '@myco-server-worker/core/session-quiet.js';
import { listUncaptured } from '@myco-server-worker/db/sessions/uncaptured-roots.js';
import { projectStatistics } from '@myco-server-worker/db/sessions/statistics.js';
import { sessions_listSessionSummaries as list, sessions_listSessionSummariesAcross as across } from '@myco-server-worker/read/catalog/sessions.js';
import { issueMemberToken } from './helpers/member-token.js';
import { d1TwoScale, eachUnit, expectTwoScale } from './helpers/two-scale.js';

const NOW = 1_790_000_000_000, MINUTE = 60_000, DAY = 24 * 60 * MINUTE;
const LIVE = ['live-a', 'live-b', 'live-c'];

async function setup(db: RelationalStore) {
  await db.prepare(`INSERT INTO projects(project_id,name,created_at) VALUES('proj_1','p',1),('proj_2','q',1)`).run();
  await db.prepare(`INSERT INTO members(id,label,created_at) VALUES('mem_a','Ada',1)`).run();
  await db.prepare(`INSERT INTO machine_claims(machine_id,member_id,claimed_at,label) VALUES('m_live','mem_a',1,'studio'),('m_former','mem_a',1,'old laptop')`).run();
  await issueMemberToken(db, { memberId: 'mem_a', machineId: 'm_live' }, NOW - MINUTE);
  for (const machine of ['m_live', 'm_former']) {
    await recordProvisionedHarnessReport(db, machine, { harnesses: [{ id: 'codex', provisioned: true, state: 'trust_required', action: 'Approve Codex.' }] }, NOW - MINUTE);
    await db.prepare(`INSERT INTO uncaptured_roots(machine_id,root_key,member_id,label,reason,misses,held,first_seen_at,last_seen_at) VALUES(?1,'root','mem_a','repo','no_remote',1,'held',1,?2)`).bind(machine, NOW).run();
  }
  for (const [i, id] of LIVE.entries()) await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,started_at)
    VALUES('proj_1',?1,'m_live','mt_0',?2,?3,?2)`).bind(id, NOW - (i + 1) * 60 * MINUTE, NOW - (i + 1) * MINUTE).run();
}

/** Each unit is an expired credential of the former machine, and a session that ended long ago in the Project and in another one. */
async function grow(db: RelationalStore, from: number, to: number) {
  await eachUnit(db, from, to, `INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
    SELECT 'old-'||i,'mem_a','m_former','hash-'||i,?3-i,?3-i+?4,'old-'||i,?3-i FROM n`, NOW - 30 * DAY, MEMBER_TOKEN_TTL_MS);
  await eachUnit(db, from, to, `INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,started_at,ended_at)
    SELECT 'proj_1','old-'||i,'m_live','mt_0',?3-i*?4,?3-i*?4,?3-i*?4,?3-i*?4+1 FROM n`, NOW - 30 * DAY, MINUTE);
  await eachUnit(db, from, to, `INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,started_at,ended_at)
    SELECT 'proj_2','older-'||i,'m_live','mt_0',?3-i*?4,?3-i*?4,?3-i*?4,?3-i*?4+1 FROM n`, NOW - 90 * DAY, MINUTE);
  await eachUnit(db, from, to, `INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,started_at,latest_activity_at,ended_at)
    SELECT 'proj_1','late-'||i,'m_live','mt_0',?3,?4,?3,?3,?3 FROM n`, NOW - 2 * DAY, NOW);
}

const ids = (page: { rows: readonly { sessionId: string }[] }) => page.rows.map((row) => row.sessionId);

it('Needs you, the session list, its Open filter, Live now and Today cost D1 the same behind ended and late-delivered history', async () => {
  expectTwoScale(await d1TwoScale({ sizes: [300, 3_000], setup, grow, cases: [
    { name: 'needs you from machines in contact', run: async (db) => {
      expect((await provisionedHarnessAttention(db, NOW)).map((fact) => fact.machineId)).toEqual(['m_live']);
      expect((await listUncaptured(db, { all: true }, NOW)).rows.map((row) => row.machineId)).toEqual(['m_live']);
    } },
    { name: 'project statistics', run: async (db) => expect(await projectStatistics(db, 'proj_1', NOW)).toMatchObject({ state: 'ready', openSessions: LIVE.length }) },
    { name: 'a Project session list first page', run: async (db) => {
      expect(ids(await list(db, { projectId: 'proj_1' }, { quietBefore: await sessionQuietBefore({ db }, NOW) }, NOW)).slice(0, 3)).toEqual(LIVE);
    } },
    { name: 'the across-Project session list first page, behind another Project of older history', run: async (db) => {
      expect(ids(await across(db, { all: true }, { quietBefore: await sessionQuietBefore({ db }, NOW) }, NOW)).slice(0, 3)).toEqual(LIVE);
    } },
    { name: 'open sessions, live now and today', run: async (db) => {
      const quietBefore = await sessionQuietBefore({ db }, NOW);
      expect(ids(await list(db, { projectId: 'proj_1' }, { state: 'open', quietBefore }, NOW))).toEqual(LIVE);
      expect(ids(await across(db, { all: true }, { state: 'open', window: 'activity', quietBefore }, NOW))).toEqual(LIVE);
      expect(ids(await across(db, { all: true }, { window: 'activity', since: NOW - DAY, until: NOW + DAY, quietBefore }, NOW))).toEqual(LIVE);
    } },
  ] }));
}, 300_000);
