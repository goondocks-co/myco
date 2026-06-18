/**
 * Regression test for the update-in-progress sentinel.
 *
 * The sentinel gates the three call sites that can fire
 * `scheduleShutdown` during an update so a single update produces at
 * most ONE daemon restart cycle. Trace from prod 2026-05-19 showed
 * three restart cycles in 62 seconds (`/api/update/apply` plus two
 * downstream triggers: the version-sync path in `handleUpdateStatus`
 * and the installUpdate path in `self-reconcile`).
 *
 * These tests exercise the sentinel module's contract end-to-end
 * (write → inFlight gates → stale-window clears → manifest clear).
 * The route-handler integration is exercised by the unit tests on
 * `createUpdateHandlers` (existing) plus the new
 * `update_in_progress` response code added in this change.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as updateInProgress from '@myco/upgrade/in-progress.js';

describe('update-in-progress sentinel', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-uip-'));
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('write + read roundtrip preserves targetVersion, startedAt, initiator', () => {
    const startedAt = Date.now();
    updateInProgress.write(stateDir, {
      targetVersion: '0.27.15',
      startedAt,
      initiator: 'api/update/apply',
    });

    const value = updateInProgress.read(stateDir);
    expect(value).not.toBeNull();
    expect(value!.targetVersion).toBe('0.27.15');
    expect(value!.startedAt).toBe(startedAt);
    expect(value!.initiator).toBe('api/update/apply');
  });

  it('read returns null when sentinel is absent', () => {
    expect(updateInProgress.read(stateDir)).toBeNull();
  });

  it('inFlight returns the sentinel when fresh', () => {
    updateInProgress.write(stateDir, {
      targetVersion: '0.27.15',
      startedAt: Date.now(),
      initiator: 'api/update/apply',
    });
    const value = updateInProgress.inFlight(stateDir);
    expect(value).not.toBeNull();
    expect(value!.targetVersion).toBe('0.27.15');
  });

  it('inFlight returns null AND clears the sentinel when stale (>10 minutes)', () => {
    const elevenMinutesAgo = Date.now() - 11 * 60 * 1000;
    updateInProgress.write(stateDir, {
      targetVersion: '0.27.15',
      startedAt: elevenMinutesAgo,
      initiator: 'self-reconcile',
    });

    const value = updateInProgress.inFlight(stateDir);
    expect(value).toBeNull();

    // Side effect: the stale sentinel was deleted so future updates aren't blocked.
    expect(updateInProgress.read(stateDir)).toBeNull();
  });

  it('clear removes the sentinel file', () => {
    updateInProgress.write(stateDir, {
      targetVersion: '0.27.15',
      startedAt: Date.now(),
      initiator: 'api/update/apply',
    });
    expect(updateInProgress.read(stateDir)).not.toBeNull();

    updateInProgress.clear(stateDir);
    expect(updateInProgress.read(stateDir)).toBeNull();
  });

  it('read returns null for malformed sentinel content', () => {
    fs.writeFileSync(updateInProgress.sentinelPath(stateDir), '{ not valid json');
    expect(updateInProgress.read(stateDir)).toBeNull();
  });

  it('read returns null for sentinel missing required fields', () => {
    fs.writeFileSync(updateInProgress.sentinelPath(stateDir), JSON.stringify({ targetVersion: '0.27.15' }));
    expect(updateInProgress.read(stateDir)).toBeNull();
  });

  it('read returns null for sentinel with unknown initiator', () => {
    fs.writeFileSync(updateInProgress.sentinelPath(stateDir), JSON.stringify({
      targetVersion: '0.27.15',
      startedAt: Date.now(),
      initiator: 'someone-else',
    }));
    expect(updateInProgress.read(stateDir)).toBeNull();
  });

  it('clear on an absent sentinel is a no-op (does not throw)', () => {
    expect(() => updateInProgress.clear(stateDir)).not.toThrow();
  });
});
