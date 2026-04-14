import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase, closeDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { getNotification } from '@myco/db/queries/notifications';
import { registerBuiltinDomains } from '@myco/notifications/domains';
import { notify } from '@myco/notifications/notify';
import { clearAll } from '@myco/notifications/registry';

describe('notify', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-notify-'));
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
});
