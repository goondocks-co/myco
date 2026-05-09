import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import {
  countNotifications,
  dismissAllNotifications,
  getNotification,
  insertNotification,
  listNotifications,
  markAllRead,
  updateNotificationStatus,
} from '@myco/db/queries/notifications.js';
import { ALL_PROJECTS_SCOPE, projectScope, type GroveProjectId } from '@myco/grove/ids.js';

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
});
