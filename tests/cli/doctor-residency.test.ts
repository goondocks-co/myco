/**
 * Doctor residency chip (Phase F T6). A fresh in-flight transition is
 * informational; one untouched for over 24h warns and names the Cancel remedy;
 * no transition emits no chip.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkResidencyTransitions } from '@myco/cli/doctor.js';

let teamHome: string;

function writeJournal(projectId: string, phase: string, updatedAt: string): void {
  const dir = path.join(teamHome, 'residency');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${projectId}.json`), JSON.stringify({
    direction: 'detach', phase, host_id: 'host_x', project_id: projectId,
    divert_grove_id: 'g', source_grove_id: 'g', target_grove_id: 'g2', project_name: 'demo',
    root: '/x', backup_ref: null, cursors: {}, created_at: updatedAt, updated_at: updatedAt,
  }), 'utf-8');
}

beforeEach(() => { teamHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-residency-')); });
afterEach(() => { fs.rmSync(teamHome, { recursive: true, force: true }); });

describe('checkResidencyTransitions', () => {
  test('no transition → no chip', async () => {
    expect(await checkResidencyTransitions(teamHome)).toEqual([]);
  });

  test('a fresh in-flight transition → informational (ok) chip', async () => {
    writeJournal('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'pulling', new Date().toISOString());
    const checks = await checkResidencyTransitions(teamHome);
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe('ok');
    expect(checks[0].name).toBe('Residency');
    expect(checks[0].detail).toMatch(/in flight/);
  });

  test('a transition untouched for over 24h → warn naming the Cancel remedy', async () => {
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeJournal('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'pushing', stale);
    const checks = await checkResidencyTransitions(teamHome);
    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe('warn');
    expect(checks[0].detail).toMatch(/stalled/);
    expect(checks[0].detail).toMatch(/Cancel/);
  });
});
