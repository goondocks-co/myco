import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import {
  countNotifications,
  dismissAllNotifications,
  getNotification,
  insertNotification,
  listNotifications,
  markAllRead,
  pruneOldNotifications,
  updateNotificationStatus,
} from '@myco/db/queries/notifications.js';
import { epochSeconds } from '@myco/constants.js';
import { ALL_PROJECTS_SCOPE, GLOBAL_SCOPE, projectScope, type GroveProjectId } from '@myco/grove/ids.js';
import { getDatabase } from '@myco/db/client.js';

const PROJECT_A = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as GroveProjectId;
const PROJECT_B = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as GroveProjectId;

function seedNotification(id: string, projectId: GroveProjectId): void {
  insertNotification({
    id,
    project_id: projectId,
    domain: 'agents',
    type: 'agent.task.success',
    level: 'info',
    title: id,
    message: null,
    mode: 'summary',
    link: null,
    metadata: null,
  });
}

function ageNotification(id: string, status: 'unread' | 'read' | 'dismissed', secondsAgo: number): void {
  getDatabase().prepare(
    `UPDATE notifications SET status = ?, created_at = ? WHERE id = ?`,
  ).run(status, epochSeconds() - secondsAgo, id);
}

describe('notification query project scope', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('scopes reads and mutations by project_id', () => {
    seedNotification('notif-a', PROJECT_A);
    seedNotification('notif-b', PROJECT_B);

    expect(listNotifications({ scope: projectScope(PROJECT_A) }).map((row) => row.id)).toEqual(['notif-a']);
    expect(countNotifications('unread', projectScope(PROJECT_A))).toBe(1);
    expect(getNotification('notif-b', projectScope(PROJECT_A))).toBeUndefined();

    expect(updateNotificationStatus('notif-b', 'read', projectScope(PROJECT_A))).toBe(false);
    expect(updateNotificationStatus('notif-a', 'read', projectScope(PROJECT_A))).toBe(true);
    expect(getNotification('notif-a', projectScope(PROJECT_A))?.status).toBe('read');
    expect(getNotification('notif-b', projectScope(PROJECT_B))?.status).toBe('unread');

    expect(markAllRead(undefined, projectScope(PROJECT_B))).toBe(1);
    expect(getNotification('notif-b', projectScope(PROJECT_B))?.status).toBe('read');

    expect(dismissAllNotifications(undefined, projectScope(PROJECT_A))).toBe(1);
    expect(getNotification('notif-a', projectScope(PROJECT_A))?.status).toBe('dismissed');
    expect(getNotification('notif-b', projectScope(PROJECT_B))?.status).toBe('read');
  });

  it('prunes old acknowledged notifications without deleting unread rows', () => {
    seedNotification('old-read', PROJECT_A);
    seedNotification('old-dismissed', PROJECT_A);
    seedNotification('old-unread', PROJECT_A);
    seedNotification('new-read', PROJECT_A);
    ageNotification('old-read', 'read', 90_000);
    ageNotification('old-dismissed', 'dismissed', 90_000);
    ageNotification('old-unread', 'unread', 90_000);
    ageNotification('new-read', 'read', 60);

    expect(pruneOldNotifications(86_400, projectScope(PROJECT_A))).toBe(2);

    expect(getNotification('old-read', projectScope(PROJECT_A))).toBeUndefined();
    expect(getNotification('old-dismissed', projectScope(PROJECT_A))).toBeUndefined();
    expect(getNotification('old-unread', projectScope(PROJECT_A))?.status).toBe('unread');
    expect(getNotification('new-read', projectScope(PROJECT_A))?.status).toBe('read');
  });

  it('prunes within the requested project scope only', () => {
    seedNotification('old-a', PROJECT_A);
    seedNotification('old-b', PROJECT_B);
    ageNotification('old-a', 'dismissed', 90_000);
    ageNotification('old-b', 'dismissed', 90_000);

    expect(pruneOldNotifications(86_400, projectScope(PROJECT_A))).toBe(1);

    expect(getNotification('old-a', projectScope(PROJECT_A))).toBeUndefined();
    expect(getNotification('old-b', projectScope(PROJECT_B))?.status).toBe('dismissed');
  });

  it('supports explicit global and all-project pruning scopes', () => {
    seedNotification('old-project', PROJECT_A);
    insertNotification({
      id: 'old-global',
      project_id: null,
      domain: 'daemon',
      type: 'daemon.test',
      level: 'info',
      title: 'old-global',
      message: null,
      mode: 'summary',
      link: null,
      metadata: null,
    });
    ageNotification('old-project', 'dismissed', 90_000);
    ageNotification('old-global', 'dismissed', 90_000);

    expect(pruneOldNotifications(86_400, GLOBAL_SCOPE)).toBe(1);
    expect(getNotification('old-global', GLOBAL_SCOPE)).toBeUndefined();
    expect(getNotification('old-project', projectScope(PROJECT_A))?.status).toBe('dismissed');

    expect(pruneOldNotifications(86_400, ALL_PROJECTS_SCOPE)).toBe(1);
    expect(getNotification('old-project', projectScope(PROJECT_A))).toBeUndefined();
  });
});
