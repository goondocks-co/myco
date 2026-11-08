import { expect, test } from 'bun:test';
import { listSessions, listSessionsAcross } from '@myco-server-worker/read/sessions.js';
import { pagePlansAcross } from '@myco-server-worker/read/plans.js';
import { MAX_LIKE_BYTES } from '@myco-server-worker/db/index.js';
import { withDocumentStores } from './helpers/document-stores.js';

const ASCII = 'n'.repeat(MAX_LIKE_BYTES - 2);
const ESCAPED = '_'.repeat((MAX_LIKE_BYTES - 2) / 2);

test('the session lists and the plan list across Projects match a text whose escaped pattern fills the LIKE limit and refuse one past it, on both stores', async () => {
  await withDocumentStores(async (db, name) => {
    for (const [i, title] of [ASCII, ESCAPED].entries()) {
      await db.prepare(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, title)
        VALUES ('project', ?, 'machine', 'token', 1, 1, ?)`).bind(`s${i}`, `x${title}y`).run();
      await db.prepare(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, content, content_hash, status, created_at, updated_at, token_id, received_at, title)
        VALUES ('project', ?, ?, 'e', 'machine', '- [ ] a', 'h', 'active', 1, 1, 'token', 1, ?)`).bind(`p${i}`, `s${i}`, `x${title}y`).run();
    }
    const lists = {
      sessions: (q: string) => listSessions(db, { projectId: 'project' }, { q, fidelity: 'any' }).then(page => page.rows.map(row => row.sessionId)),
      sessionsAcross: (q: string) => listSessionsAcross(db, { all: true }, { q, fidelity: 'any' }).then(page => page.rows.map(row => row.sessionId)),
      plansAcross: (q: string) => pagePlansAcross(db, { all: true }, { q }).then(page => page.rows.map(row => row.planKey)),
    };
    for (const [list, read] of Object.entries(lists)) {
      const id = list.startsWith('sessions') ? 's' : 'p';
      expect({ name, list, ascii: await read(ASCII), escaped: await read(ESCAPED) })
        .toEqual({ name, list, ascii: [`${id}0`], escaped: [`${id}1`] });
      for (const over of ['é'.repeat(MAX_LIKE_BYTES / 2), '%'.repeat(MAX_LIKE_BYTES / 2)]) {
        await expect(read(over), `${name} ${list}`).rejects.toThrow(`${MAX_LIKE_BYTES + 2} UTF-8 bytes; maximum is ${MAX_LIKE_BYTES}`);
      }
    }
  });
});
