import { expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { bootstrapOwnership } from '@myco-server-worker/core/ownership.js';
import {
  sessions_listSessionsAcross as listSessionsAcross,
} from '@myco-server-worker/read/catalog/sessions.js';
import {
  plans_pagePlansAcross as pagePlansAcross,
} from '@myco-server-worker/read/catalog/plans.js';
import { credentialActivity } from '@myco-server-worker/read/credentials.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { encodeCursor, type Page } from '@myco-server-worker/read/scope.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, PRINCIPAL, asOwner } from './helpers/owner.js';

/** Every row of a list read one row per page, following its cursors. */
async function walk<T>(read: (cursor: string | undefined) => Promise<Page<T>>): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < 10; pages += 1) {
    const page = await read(cursor);
    rows.push(...page.rows);
    if (page.cursor === null) return rows;
    cursor = page.cursor;
  }
  throw new Error('the list did not end');
}

it('pages sessions, plans and credential activity across Projects one row at a time, each row of a shared instant and id once', async () => {
  const e = sqliteEnv();
  e.sqlite.run(`INSERT OR REPLACE INTO projects (project_id, name, created_at) VALUES ('proj_1','One',1), ('proj_2','Two',2)`);
  const { tokenId: token } = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, 1);
  for (const project of ['proj_1', 'proj_2']) {
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
      VALUES (?, 'shared', 'm1', 'tok_1', 50, 50)`, [project]);
    e.sqlite.run(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, content, content_hash, status, created_at, updated_at, token_id, received_at)
      VALUES (?, 'shared-plan', 'shared', 'ep', 'm1', '- [ ] a', 'h', 'active', 50, 50, 'tok_1', 50)`, [project]);
    e.sqlite.run(`INSERT INTO events (project_id, event_id, session_id, token_id, kind, channel, payload, envelope_hash, created_at, received_at)
      VALUES (?, 'shared-event', 'shared', ?, 'prompt', 'cli', '{}', 'h', 50, 50)`, [project, token]);
  }
  const sessions = await walk(cursor => listSessionsAcross(e.db, { all: true }, { limit: 1, fidelity: 'any', ...(cursor === undefined ? {} : { cursor }) }));
  const plans = await walk(cursor => pagePlansAcross(e.db, { all: true }, { limit: 1, ...(cursor === undefined ? {} : { cursor }) }));
  const events = await walk(cursor => credentialActivity(e.db, token, { limit: 1, ...(cursor === undefined ? {} : { cursor }) }));
  expect({
    sessions: sessions.map(row => `${row.projectId}/${row.sessionId}`),
    plans: plans.map(row => `${row.projectId}/${row.planKey}`),
    events: events.map(row => `${row.projectId}/${row.eventId}`),
  }).toEqual({
    sessions: ['proj_2/shared', 'proj_1/shared'],
    plans: ['proj_2/shared-plan', 'proj_1/shared-plan'],
    events: ['proj_2/shared-event', 'proj_1/shared-event'],
  });

  // Each route pages with the cursor it issued, and refuses any cursor without the p1: encoding, an id holding a colon included.
  await bootstrapOwnership(e.db, PRINCIPAL.id, PRINCIPAL.id, '0', Date.now());
  const get = async (path: string) => {
    const res = await worker.fetch(await asOwner(e.db, path), { ...e.env, ...OWNER_ENV });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const routes = { sessions: '/api/sessions?limit=1', plans: '/api/plans?limit=1', activity: `/api/credentials/${token}/activity?limit=1` };
  for (const [name, path] of Object.entries(routes)) {
    const first = await get(path);
    const cursor = String(first.body.cursor);
    const next = await get(`${path}&cursor=${encodeURIComponent(cursor)}`);
    expect({ name, first: first.status, prefixed: cursor.startsWith('p1:'), next: next.status }).toEqual({ name, first: 200, prefixed: true, next: 200 });
    for (const old of [encodeCursor(50, 'shared'), encodeCursor(50, 'proj_1:shared')]) {
      const refused = await get(`${path}&cursor=${encodeURIComponent(old)}`);
      expect({ name, old, status: refused.status, reason: refused.body.reason }).toEqual({
        name, old, status: 400, reason: expect.stringContaining('request the first page again without a cursor'),
      });
    }
  }
});
