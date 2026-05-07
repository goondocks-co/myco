import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase, closeDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import {
  getNotification,
  listNotifications,
  countNotifications,
} from '@myco/db/queries/notifications';
import { ensureProjectManifest } from '@myco/config/project-manifest';
import { registerBuiltinDomains } from '@myco/notifications/domains';
import { notify } from '@myco/notifications/notify';
import { clearAll } from '@myco/notifications/registry';

describe('notify', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-notify-'));
    ensureProjectManifest(tmpDir, { projectName: 'notify-test' });
    const db = initDatabase(path.join(tmpDir, 'index.db'));
    createSchema(db);
    clearAll();
    registerBuiltinDomains();
  });

  afterEach(() => {
    clearAll();
    closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('respects the global summary default over registry defaults', () => {
    fs.writeFileSync(path.join(tmpDir, 'myco.yaml'), 'version: 3\nnotifications:\n  default_mode: summary\n');

    const id = notify(tmpDir, {
      domain: 'agents',
      type: 'agent.task.success',
      title: 'Task completed: skill-survey',
    });

    expect(id).toBeTruthy();
    expect(getNotification(id!)).toMatchObject({
      domain: 'agents',
      type: 'agent.task.success',
      mode: 'summary',
    });
  });

  it('still allows an explicit domain override to force banner mode', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'myco.yaml'),
      [
        'version: 3',
        'notifications:',
        '  default_mode: summary',
        '  domains:',
        '    agents:',
        '      enabled: true',
        '      mode: banner',
        '',
      ].join('\n'),
    );

    const id = notify(tmpDir, {
      domain: 'agents',
      type: 'agent.task.failure',
      title: 'Task failed: skill-survey',
    });

    expect(id).toBeTruthy();
    expect(getNotification(id!)).toMatchObject({
      domain: 'agents',
      type: 'agent.task.failure',
      mode: 'banner',
    });
  });

  // -------------------------------------------------------------------------
  // Daemon scope
  // -------------------------------------------------------------------------

  describe('daemon scope', () => {
    beforeEach(() => {
      // Tests in this block don't care about config nuance, just need
      // a valid myco.yaml so loadMergedConfig succeeds.
      fs.writeFileSync(path.join(tmpDir, 'myco.yaml'), 'version: 3\n');
    });

    it('writes a row with project_id = NULL when scope is "daemon"', () => {
      const id = notify(
        tmpDir,
        {
          domain: 'daemon',
          type: 'daemon.backup_failed',
          title: 'Backup failed for Alpha',
          message: 'disk full',
        },
        undefined,
        { scope: 'daemon' },
      );
      expect(id).toBeTruthy();
      const row = getNotification(id!);
      expect(row).toMatchObject({ domain: 'daemon', type: 'daemon.backup_failed' });
      expect(row?.project_id).toBeNull();
    });

    it('still defaults to project scope (resolves projectId from vault) when no scope is passed', () => {
      const id = notify(tmpDir, {
        domain: 'agents',
        type: 'agent.task.success',
        title: 'ok',
      });
      expect(id).toBeTruthy();
      const row = getNotification(id!);
      // The project manifest setup gives this row a non-null project_id;
      // the exact id is manifest-dependent, just confirm it's set.
      expect(row?.project_id).not.toBeNull();
    });

    it('listNotifications with include_daemon_scope returns daemon-scope rows alongside the project rows', () => {
      // Project-scope row.
      const projectId = notify(tmpDir, {
        domain: 'agents',
        type: 'agent.task.success',
        title: 'project',
      });
      const projectRow = getNotification(projectId!);
      const projectIdStr = projectRow!.project_id as string;

      // Daemon-scope row.
      const daemonId = notify(
        tmpDir,
        { domain: 'daemon', type: 'daemon.backup_failed', title: 'daemon' },
        undefined,
        { scope: 'daemon' },
      );

      // Without include_daemon_scope, only the project row is visible.
      const projectOnly = listNotifications({ project_id: projectIdStr });
      expect(projectOnly.map((r) => r.id)).toEqual([projectId!]);

      // With include_daemon_scope, both surface.
      const merged = listNotifications({
        project_id: projectIdStr,
        include_daemon_scope: true,
      });
      const ids = merged.map((r) => r.id).sort();
      expect(ids).toEqual([projectId!, daemonId!].sort());
    });

    it('countNotifications respects includeDaemonScope', () => {
      const id = notify(tmpDir, {
        domain: 'agents',
        type: 'agent.task.success',
        title: 'project',
      });
      const row = getNotification(id!);
      const projectIdStr = row!.project_id as string;
      notify(
        tmpDir,
        { domain: 'daemon', type: 'daemon.backup_failed', title: 'daemon' },
        undefined,
        { scope: 'daemon' },
      );

      expect(countNotifications('unread', projectIdStr)).toBe(1);
      expect(
        countNotifications('unread', projectIdStr, { includeDaemonScope: true }),
      ).toBe(2);
    });
  });

  it('uses the migrated settings-domain banner default over the global summary mode', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'myco.yaml'),
      [
        'version: 3',
        'config_version: 4',
        'notifications:',
        '  default_mode: summary',
        '',
      ].join('\n'),
    );

    const id = notify(tmpDir, {
      domain: 'settings',
      type: 'settings.saved',
      title: 'Settings saved',
    });

    expect(id).toBeTruthy();
    expect(getNotification(id!)).toMatchObject({
      domain: 'settings',
      type: 'settings.saved',
      mode: 'banner',
    });
  });
});
