import { expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { bootstrapOwnership } from '@myco-server-worker/core/raw-claims.js';
import { listSessionsAcross } from '@myco-server-worker/read/sessions.js';
import { pagePlansAcross } from '@myco-server-worker/read/plans.js';
import { credentialActivity } from '@myco-server-worker/read/credentials.js';
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
  for (const project of ['proj_1', 'proj_2']) {
    e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
      VALUES (?, 'shared', 'm1', 'tok_1', 50, 50)`, [project]);
    e.sqlite.run(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, content, content_hash, status, created_at, updated_at, token_id, received_at)
      VALUES (?, 'shared-plan', 'shared', 'ep', 'm1', '- [ ] a', 'h', 'active', 50, 50, 'tok_1', 50)`, [project]);
    e.sqlite.run(`INSERT INTO events (project_id, event_id, session_id, token_id, kind, channel, payload, envelope_hash, created_at, received_at)
      VALUES (?, 'shared-event', 'shared', 'tok_1', 'prompt', 'cli', '{}', 'h', 50, 50)`, [project]);
  }
  const sessions = await walk(cursor => listSessionsAcross(e.db, { all: true }, { limit: 1, fidelity: 'any', ...(cursor === undefined ? {} : { cursor }) }));
  const plans = await walk(cursor => pagePlansAcross(e.db, { all: true }, { limit: 1, ...(cursor === undefined ? {} : { cursor }) }));
  const events = await walk(cursor => credentialActivity(e.db, 'tok_1', { limit: 1, ...(cursor === undefined ? {} : { cursor }) }));
  expect({
    sessions: sessions.map(row => `${row.projectId}/${row.sessionId}`),
    plans: plans.map(row => `${row.projectId}/${row.planKey}`),
    events: events.map(row => `${row.projectId}/${row.eventId}`),
  }).toEqual({
    sessions: ['proj_2/shared', 'proj_1/shared'],
    plans: ['proj_2/shared-plan', 'proj_1/shared-plan'],
    events: ['proj_2/shared-event', 'proj_1/shared-event'],
  });

  // A cursor from before lists across Projects carried the Project is refused with the next call to make.
  await bootstrapOwnership(e.db, PRINCIPAL.id, PRINCIPAL.id, '0', Date.now());
  const old = encodeURIComponent(encodeCursor(50, 'shared'));
  for (const path of [`/api/sessions?cursor=${old}`, `/api/plans?cursor=${old}`]) {
    const res = await worker.fetch(await asOwner(e.db, path), { ...e.env, ...OWNER_ENV });
    expect({ path, status: res.status, reason: (await res.json() as { reason: string }).reason }).toEqual({
      path, status: 400, reason: expect.stringContaining('request the first page again without a cursor'),
    });
  }
});
