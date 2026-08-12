import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase, closeDatabase } from '@myco/db/client';
import { createSchema } from '@myco/db/schema';
import { listNotifications } from '@myco/db/queries/notifications';
import { ALL_PROJECTS_SCOPE, assertGroveProjectId } from '@myco/grove/ids';
import { ensureProjectManifest } from '@myco/config/project-manifest';
import { registerBuiltinDomains } from '@myco/notifications/domains';
import { _clearNotifyDedupForTests } from '@myco/notifications/notify';
import { clearAll } from '@myco/notifications/registry';
import {
  captureOnlyNoticeMarkerPath,
  sweepCaptureOnlyNotice,
} from '@myco/notifications/capture-only-notice';
import { MycoConfigSchema } from '@myco/config/schema';

describe('capture-only notice sweep', () => {
  let tmpDir: string;
  let mycoHomeDir: string;
  let previousMycoHome: string | undefined;
  let projectId: ReturnType<typeof assertGroveProjectId>;

  const captureOnlyConfig = () =>
    MycoConfigSchema.parse({
      version: 3,
      cortex: { enabled: false, canopy: { enabled: false } },
      skills: { enabled: false },
      vault_evolution: { enabled: false },
    });

  const promotedConfig = () =>
    MycoConfigSchema.parse({
      version: 3,
      cortex: { enabled: false, canopy: { enabled: true } },
      skills: { enabled: false },
      vault_evolution: { enabled: false },
    });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-conotice-'));
    mycoHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-conotice-home-'));
    previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHomeDir;
    const manifest = ensureProjectManifest(tmpDir, { projectName: 'conotice-test' });
    projectId = assertGroveProjectId(manifest.project.id);
    const db = initDatabase(path.join(tmpDir, 'index.db'));
    createSchema(db);
    clearAll();
    registerBuiltinDomains();
    _clearNotifyDedupForTests();
  });

  afterEach(() => {
    clearAll();
    closeDatabase();
    if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousMycoHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(mycoHomeDir, { recursive: true, force: true });
  });

  function writeMarker(): string {
    const markerPath = captureOnlyNoticeMarkerPath(tmpDir);
    fs.writeFileSync(markerPath, JSON.stringify({ schema_version: 1 }) + '\n');
    return markerPath;
  }

  it('is a no-op without a marker', () => {
    expect(
      sweepCaptureOnlyNotice({
        vaultDir: tmpDir,
        projectId,
        projectName: 'conotice-test',
        config: captureOnlyConfig(),
      }),
    ).toBe('none');
    expect(listNotifications({ scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);
  });

  it('emits the drawer notice and consumes the marker on a capture-only project', () => {
    const markerPath = writeMarker();

    const result = sweepCaptureOnlyNotice({
      vaultDir: tmpDir,
      projectId,
      projectName: 'conotice-test',
      config: captureOnlyConfig(),
    });

    expect(result).toBe('notified');
    expect(fs.existsSync(markerPath)).toBe(false);
    const rows = listNotifications({ scope: ALL_PROJECTS_SCOPE });
    expect(rows).toHaveLength(1);
    expect(rows[0].domain).toBe('projects');
    expect(rows[0].type).toBe('project.capture_only');
    // summary mode: lands in the drawer, never interrupts as a banner.
    expect(rows[0].mode).toBe('summary');
    expect(rows[0].link).toBe(`/groves?capabilities=${projectId}`);
    expect(rows[0].project_id).toBe(projectId);
  });

  it('consumes the marker silently when the project was promoted before the sweep', () => {
    const markerPath = writeMarker();

    const result = sweepCaptureOnlyNotice({
      vaultDir: tmpDir,
      projectId,
      projectName: 'conotice-test',
      config: promotedConfig(),
    });

    expect(result).toBe('cleared');
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(listNotifications({ scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);
  });

  it('keeps the marker (deferred) when the notification cannot be inserted', () => {
    const markerPath = writeMarker();
    // Simulate the transient-failure window: no notifications DB available.
    closeDatabase();

    const result = sweepCaptureOnlyNotice({
      vaultDir: tmpDir,
      projectId,
      projectName: 'conotice-test',
      config: captureOnlyConfig(),
    });

    expect(result).toBe('deferred');
    expect(fs.existsSync(markerPath)).toBe(true);

    // Recovery: DB back → the next sweep delivers and consumes. Real
    // sweeps run 15 minutes apart, outside notify's 5-minute in-memory
    // dedup window; the test clears it explicitly.
    const db = initDatabase(path.join(tmpDir, 'index.db'));
    createSchema(db);
    _clearNotifyDedupForTests();
    expect(
      sweepCaptureOnlyNotice({
        vaultDir: tmpDir,
        projectId,
        projectName: 'conotice-test',
        config: captureOnlyConfig(),
      }),
    ).toBe('notified');
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it('consumes the marker silently when notifications are turned off (suppression, not failure)', () => {
    const markerPath = writeMarker();
    const config = captureOnlyConfig();
    (config.notifications as { enabled: boolean }).enabled = false;

    const result = sweepCaptureOnlyNotice({
      vaultDir: tmpDir,
      projectId,
      projectName: 'conotice-test',
      config,
    });

    expect(result).toBe('cleared');
    expect(fs.existsSync(markerPath)).toBe(false);
    expect(listNotifications({ scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);
  });

  it('fires at most once — the second sweep finds no marker', () => {
    writeMarker();
    const input = {
      vaultDir: tmpDir,
      projectId,
      projectName: 'conotice-test',
      config: captureOnlyConfig(),
    };
    expect(sweepCaptureOnlyNotice(input)).toBe('notified');
    expect(sweepCaptureOnlyNotice(input)).toBe('none');
    expect(listNotifications({ scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);
  });
});
