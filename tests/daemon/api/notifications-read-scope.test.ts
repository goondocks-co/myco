/**
 * Fix B: the notification READ/MUTATE routes — `GET /api/notifications`,
 * `GET /api/notifications/unread-count`, `PATCH /api/notifications/:id`,
 * `POST /api/notifications/dismiss-all`, `POST /api/notifications/mark-all-read`
 * — are wrapped in `tenantRoute`, the same gate the create route already uses.
 *
 * Two halves of the contract are pinned here:
 *   1. A synthesized/anchor-fallback context is rejected with 400 +
 *      `tenancy.violation` BEFORE the handler runs — never silently served the
 *      anchor's data.
 *   2. With a caller-supplied (authorized) context for project B, the read is
 *      scoped to B's rows — never the anchor's — and the daemon-scope merge
 *      (project_id IS NULL rows via ?include_daemon) is preserved.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { insertNotification } from '@myco/db/queries/notifications.js';
import {
  handleListNotifications,
  handleUnreadCount,
  handleDismissAll,
  handleMarkAllRead,
} from '@myco/daemon/api/notifications.js';
import { tenantRoute } from '@myco/daemon/api/route-helpers.js';
import type { RequestPrincipal } from '@myco/daemon/request-principal.js';
import type { RouteRequest } from '@myco/daemon/router.js';
import type { GroveProjectId } from '@myco/grove/ids.js';

const PROJECT_ANCHOR = 'proj_aaaa1111aaaa1111aaaa1111aaaa1111' as GroveProjectId;
const PROJECT_B = 'proj_bbbb2222bbbb2222bbbb2222bbbb2222' as GroveProjectId;
const GROVE_B = 'grove_bbbb2222bbbb2222bbbb2222bbbb2222';

/** Caller-supplied (authorized) principal for project B. */
function principalB(): RequestPrincipal {
  return {
    identity: { machineId: 'machine-a', userId: null },
    tenancy: {
      projectVaultDir: '/tenants/b/.myco' as RequestPrincipal['tenancy']['projectVaultDir'],
      projectId: PROJECT_B,
      groveId: GROVE_B,
      requestContext: {
        projectVaultDir: '/tenants/b/.myco',
        projectId: PROJECT_B,
        groveId: GROVE_B,
      },
    },
  };
}

/** A caller context shaped like the one `tenantRoute` would accept. */
function callerContextB(): RouteRequest['requestContext'] {
  return {
    projectRoot: '/tenants/b',
    callerRoot: null,
    projectId: PROJECT_B,
    groveId: GROVE_B,
    machineId: 'machine-a',
    sessionId: null,
    projectVaultDir: '/tenants/b/.myco',
    databasePath: '/tenants/b/.myco/vault.db',
    source: 'headers',
    tenancySource: 'caller',
  } as unknown as RouteRequest['requestContext'];
}

function makeReq(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    params: {},
    query: {},
    body: undefined,
    requestContext: callerContextB(),
    pathname: '/api/notifications',
    ...overrides,
  } as RouteRequest;
}

function recordingLogger(kinds: string[]) {
  return {
    info: () => {},
    warn: (kind: string) => { kinds.push(kind); },
    error: () => {},
    debug: () => {},
  } as never;
}

let seq = 0;
function seedNotification(projectId: GroveProjectId | null, title: string): string {
  const id = `notif-${seq++}`;
  insertNotification({
    id,
    domain: 'agent',
    type: 'task_complete',
    level: 'info',
    title,
    message: null,
    mode: 'banner',
    link: null,
    metadata: null,
    project_id: projectId,
  });
  return id;
}

describe('notification read/mutate routes — tenant-scoped via tenantRoute', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); seq = 0; });

  describe('synthesized context is rejected (400 + tenancy.violation)', () => {
    const synthesized = {
      projectRoot: '/tenants/b',
      callerRoot: null,
      projectId: PROJECT_B,
      groveId: GROVE_B,
      machineId: 'machine-a',
      sessionId: null,
      projectVaultDir: '/tenants/b/.myco',
      databasePath: '/tenants/b/.myco/vault.db',
      source: 'headers',
      tenancySource: 'synthesized',
    } as unknown as RouteRequest['requestContext'];

    const cases: Array<{ name: string; handler: Parameters<typeof tenantRoute>[1]; pathname: string }> = [
      { name: 'GET /api/notifications', handler: handleListNotifications, pathname: '/api/notifications' },
      { name: 'GET /api/notifications/unread-count', handler: handleUnreadCount, pathname: '/api/notifications/unread-count' },
      { name: 'POST /api/notifications/dismiss-all', handler: handleDismissAll, pathname: '/api/notifications/dismiss-all' },
      { name: 'POST /api/notifications/mark-all-read', handler: handleMarkAllRead, pathname: '/api/notifications/mark-all-read' },
    ];

    for (const { name, handler, pathname } of cases) {
      it(`${name} rejects synthesized with 400 + tenancy.violation`, async () => {
        const kinds: string[] = [];
        const wrapped = tenantRoute({ machineId: 'machine-a', logger: recordingLogger(kinds) }, handler);
        const res = await wrapped(makeReq({ requestContext: synthesized, pathname }));
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ error: { code: 'tenancy-violation' } });
        expect(kinds).toContain('tenancy.violation');
      });
    }
  });

  describe('with caller context for project B, reads are scoped to B (+ daemon merge)', () => {
    it('GET /api/notifications returns only B rows, never the anchor', async () => {
      seedNotification(PROJECT_ANCHOR, 'anchor row');
      seedNotification(PROJECT_B, 'B row');
      seedNotification(null, 'daemon row');

      const res = await handleListNotifications(makeReq(), principalB());

      const body = res.body as { items: Array<{ title: string }> };
      const titles = body.items.map((i) => i.title);
      expect(titles).toContain('B row');
      expect(titles).not.toContain('anchor row');
      // No include_daemon → daemon row not merged.
      expect(titles).not.toContain('daemon row');
    });

    it('GET /api/notifications?include_daemon merges daemon rows, still excludes the anchor', async () => {
      seedNotification(PROJECT_ANCHOR, 'anchor row');
      seedNotification(PROJECT_B, 'B row');
      seedNotification(null, 'daemon row');

      const res = await handleListNotifications(
        makeReq({ query: { include_daemon: '1' } }),
        principalB(),
      );

      const body = res.body as { items: Array<{ title: string }> };
      const titles = body.items.map((i) => i.title);
      expect(titles).toContain('B row');
      expect(titles).toContain('daemon row');
      expect(titles).not.toContain('anchor row');
    });

    it('GET /api/notifications/unread-count counts only B (+ daemon when include_daemon)', async () => {
      seedNotification(PROJECT_ANCHOR, 'anchor row');
      seedNotification(PROJECT_B, 'B row 1');
      seedNotification(PROJECT_B, 'B row 2');
      seedNotification(null, 'daemon row');

      const base = await handleUnreadCount(makeReq(), principalB());
      expect((base.body as { count: number }).count).toBe(2);

      const withDaemon = await handleUnreadCount(
        makeReq({ query: { include_daemon: 'true' } }),
        principalB(),
      );
      expect((withDaemon.body as { count: number }).count).toBe(3);
    });

    it('POST /api/notifications/dismiss-all only touches B rows, never the anchor', async () => {
      seedNotification(PROJECT_ANCHOR, 'anchor row');
      seedNotification(PROJECT_B, 'B row 1');
      seedNotification(PROJECT_B, 'B row 2');

      const res = await handleDismissAll(makeReq({ body: {} }), principalB());
      expect((res.body as { dismissed: number }).dismissed).toBe(2);

      // The anchor's row is untouched (still unread).
      const anchorCount = await handleUnreadCount(
        makeReq(),
        {
          ...principalB(),
          tenancy: { ...principalB().tenancy, projectId: PROJECT_ANCHOR },
        } as RequestPrincipal,
      );
      expect((anchorCount.body as { count: number }).count).toBe(1);
    });

    it('POST /api/notifications/mark-all-read only marks B rows', async () => {
      seedNotification(PROJECT_ANCHOR, 'anchor row');
      seedNotification(PROJECT_B, 'B row 1');

      const res = await handleMarkAllRead(makeReq({ body: {} }), principalB());
      expect((res.body as { marked: number }).marked).toBe(1);
    });
  });
});
