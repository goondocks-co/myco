import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'bun:test';
import { createRunnerUpdateController, withRunnerUpdateState, readRunnerUpdateState } from '@myco/runner/update.js';

it('persists the update report with its order, retries it unchanged, and observes afresh after resync', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-report-'));
  try {
    const options = { home, serverUrl: 'http://fixture.invalid', binaryPath: path.join(home, 'myco'), currentVersion: '2.0.0-alpha.1', log: () => {},
      serviceSpec: { binaryPath: path.join(home, 'myco'), home, pathEnv: '', logDir: home, env: { MYCO_HOME: home },
        unit: { label: 'fixture', unitName: 'fixture', description: 'fixture', args: ['runner', 'run'], logName: 'fixture', restartDelaySeconds: 1 } },
      deps: { now: () => 10 } };
    const first = createRunnerUpdateController(options).contactPayload();
    expect(first.observedOrder).toBeGreaterThan(0);
    const restarted = createRunnerUpdateController(options);
    expect(restarted.contactPayload()).toEqual(first);
    withRunnerUpdateState(home, state => { state.lastCheckAt = 1; state.latestVersion = '2.0.0-alpha.2'; });
    const next = restarted.contactPayload();
    expect(next.observedOrder).toBeGreaterThan(first.observedOrder!);
    expect(next.lastCheckAt).toBe(1);
    restarted.onContact({ updateRecorded: false, observedOrder: 100 });
    withRunnerUpdateState(home, state => { state.latestVersion = '2.0.0-alpha.3'; });
    const resynced = createRunnerUpdateController(options).contactPayload();
    expect(resynced.observedOrder).toBe(101);
    expect(resynced.latestVersion).toBe('2.0.0-alpha.3');
    expect(readRunnerUpdateState(home).reports?.[options.serverUrl]).toEqual(resynced);
    expect(restarted.contactPayload()).toEqual(resynced);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
