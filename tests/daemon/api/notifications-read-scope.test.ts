/**
 * The notification banner is a GLOBAL, no-context-required poll: the UI hits
 * `GET /api/notifications?...&include_daemon=1` and
 * `GET /api/notifications/unread-count` on EVERY page — including global pages
 * (`/settings`, `/logs`, `/groves`) that carry no selected-project context. So
 * the READ/MUTATE notification routes are deliberately NOT wrapped in
 * `tenantRoute`: a synthesized (no caller project/grove) context must SUCCEED,
 * not 400. It is leak-safe — the global daemon bootstraps a PHANTOM home
 * (Phase 5, `_unbound-bootstrap`, no project anchor), so a synthesized read
 * scopes to the phantom project and returns empty project rows plus, when
 * `?include_daemon` is set, the daemon-scope (`project_id IS NULL`) rows.
 *
 * Two halves of the contract are pinned here:
 *   1. A synthesized/no-project context READS SUCCESSFULLY (no `tenancy.violation`,
 *      no 400). It returns only daemon-scope rows under `?include_daemon` and
 *      no project rows — never another tenant's data.
 *   2. With a caller-supplied context for project B, the read is scoped to B's
 *      rows — never the anchor's — and the daemon-scope merge (project_id IS
 *      NULL rows via ?include_daemon) is preserved.
 *
 * The CREATE route (`POST /api/notifications`) stays wrapped in `tenantRoute`;
 * its synthesized→400 contract lives in `notifications-create-scope.test.ts`.
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
import type { RouteRequest } from '@myco/daemon/router.js';
import type { GroveProjectId } from '@myco/grove/ids.js';

const PROJECT_ANCHOR = 'proj_aaaa1111aaaa1111aaaa1111aaaa1111' as GroveProjectId;
const PROJECT_B = 'proj_bbbb2222bbbb2222bbbb2222bbbb2222' as GroveProjectId;
const GROVE_B = 'grove_bbbb2222bbbb2222bbbb2222bbbb2222';

/** A caller-supplied (authorized) context for project B. */
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

/**
 * A synthesized (no caller project/grove) context — the daemon's phantom-home
 * fallback for a global page with no selected project. The notification banner
 * polls land here. `groveId: null` makes `projectScopeFromRequestContext`
 * resolve to the global (NULL project_id) scope.
 */
function synthesizedContext(): RouteRequest['requestContext'] {
  return {
    projectRoot: '/phantom',
    callerRoot: null,
    projectId: null,
    groveId: null,
    machineId: 'machine-a',
    sessionId: null,
    projectVaultDir: '/phantom/.myco',
    databasePath: '/phantom/.myco/vault.db',
    source: 'fallback',
    tenancySource: 'synthesized',
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

describe('notification read/mutate routes — global, no-context poll (unwrapped, leak-safe)', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); seq = 0; });

  describe('synthesized / no-project context reads SUCCEED (the global banner poll)', () => {
    it('GET /api/notifications with no selected project returns daemon-scope rows, never a tenant’s', async () => {
      seedNotification(PROJECT_ANCHOR, 'anchor row');
      seedNotification(PROJECT_B, 'B row');
      seedNotification(null, 'daemon row');

      const res = await handleListNotifications(makeReq({ requestContext: synthesizedContext() }));

      expect(res.status ?? 200).toBe(200);
      const body = res.body as { items: Array<{ title: string }> };
      const titles = body.items.map((i) => i.title);
      // No project context → global/phantom scope → only the daemon-scope
      // (project_id IS NULL) rows surface, which is exactly what the global
      // banner polls for. No tenant project rows are ever exposed.
      expect(titles).toContain('daemon row');
      expect(titles).not.toContain('anchor row');
      expect(titles).not.toContain('B row');
    });

    it('GET /api/notifications?include_daemon surfaces only daemon-scope rows, never a tenant’s', async () => {
      seedNotification(PROJECT_ANCHOR, 'anchor row');
      seedNotification(PROJECT_B, 'B row');
      seedNotification(null, 'daemon row');

      const res = await handleListNotifications(
        makeReq({ requestContext: synthesizedContext(), query: { include_daemon: '1' } }),
      );

      expect(res.status ?? 200).toBe(200);
      const body = res.body as { items: Array<{ title: string }> };
      const titles = body.items.map((i) => i.title);
      // The global banner sees the daemon-scope rows it polls for...
      expect(titles).toContain('daemon row');
      // ...and never any tenant's project rows.
      expect(titles).not.toContain('anchor row');
      expect(titles).not.toContain('B row');
    });

    it('GET /api/notifications/unread-count with no project counts daemon rows, never a tenant’s', async () => {
      seedNotification(PROJECT_ANCHOR, 'anchor row');
      seedNotification(PROJECT_B, 'B row');
      seedNotification(null, 'daemon row 1');
      seedNotification(null, 'daemon row 2');

      // Global/phantom scope counts daemon-scope rows (the banner badge) and
      // never another tenant's — true with or without include_daemon, since
      // global scope already targets project_id IS NULL.
      const base = await handleUnreadCount(makeReq({ requestContext: synthesizedContext() }));
      expect(base.status ?? 200).toBe(200);
      expect((base.body as { count: number }).count).toBe(2);

      const withDaemon = await handleUnreadCount(
        makeReq({ requestContext: synthesizedContext(), query: { include_daemon: 'true' } }),
      );
      expect(withDaemon.status ?? 200).toBe(200);
      expect((withDaemon.body as { count: number }).count).toBe(2);
    });

    it('POST /api/notifications/dismiss-all with no project never touches a tenant’s rows', async () => {
      seedNotification(PROJECT_ANCHOR, 'anchor row');
      seedNotification(PROJECT_B, 'B row');

      const res = await handleDismissAll(makeReq({ requestContext: synthesizedContext(), body: {} }));
      expect(res.status ?? 200).toBe(200);
      // Global/phantom scope owns no project rows, so nothing is dismissed.
      expect((res.body as { dismissed: number }).dismissed).toBe(0);

      // Both tenant rows remain unread.
      const bCount = await handleUnreadCount(makeReq());
      expect((bCount.body as { count: number }).count).toBe(1);
    });

    it('POST /api/notifications/mark-all-read with no project never touches a tenant’s rows', async () => {
      seedNotification(PROJECT_ANCHOR, 'anchor row');
      seedNotification(PROJECT_B, 'B row');

      const res = await handleMarkAllRead(makeReq({ requestContext: synthesizedContext(), body: {} }));
      expect(res.status ?? 200).toBe(200);
      expect((res.body as { marked: number }).marked).toBe(0);
    });
  });

  describe('with caller context for project B, reads are scoped to B (+ daemon merge)', () => {
    it('GET /api/notifications returns only B rows, never the anchor', async () => {
      seedNotification(PROJECT_ANCHOR, 'anchor row');
      seedNotification(PROJECT_B, 'B row');
      seedNotification(null, 'daemon row');

      const res = await handleListNotifications(makeReq());

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

      const res = await handleListNotifications(makeReq({ query: { include_daemon: '1' } }));

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

      const base = await handleUnreadCount(makeReq());
      expect((base.body as { count: number }).count).toBe(2);

      const withDaemon = await handleUnreadCount(makeReq({ query: { include_daemon: 'true' } }));
      expect((withDaemon.body as { count: number }).count).toBe(3);
    });

    it('POST /api/notifications/dismiss-all only touches B rows, never the anchor', async () => {
      seedNotification(PROJECT_ANCHOR, 'anchor row');
      seedNotification(PROJECT_B, 'B row 1');
      seedNotification(PROJECT_B, 'B row 2');

      const res = await handleDismissAll(makeReq({ body: {} }));
      expect((res.body as { dismissed: number }).dismissed).toBe(2);

      // The anchor's row is untouched (still unread) — read it back with an
      // anchor-scoped caller context.
      const anchorCtx = {
        ...callerContextB(),
        projectId: PROJECT_ANCHOR,
      } as RouteRequest['requestContext'];
      const anchorCount = await handleUnreadCount(makeReq({ requestContext: anchorCtx }));
      expect((anchorCount.body as { count: number }).count).toBe(1);
    });

    it('POST /api/notifications/mark-all-read only marks B rows', async () => {
      seedNotification(PROJECT_ANCHOR, 'anchor row');
      seedNotification(PROJECT_B, 'B row 1');

      const res = await handleMarkAllRead(makeReq({ body: {} }));
      expect((res.body as { marked: number }).marked).toBe(1);
    });
  });
});
