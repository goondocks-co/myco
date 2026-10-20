import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'bun:test';
import { createRunnerUpdateController, withRunnerUpdateState, readRunnerUpdateState, type RunnerUpdateOptions } from '@myco/runner/update.js';

import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { deploymentKeyFor } from '@myco/member/registry.js';

function optionsFor(home: string): RunnerUpdateOptions {
  return { home, serverUrl: 'http://fixture.invalid', binaryPath: path.join(home, 'myco'), currentVersion: '2.0.0-alpha.1', log: () => {},
    serviceSpec: { binaryPath: path.join(home, 'myco'), home, pathEnv: '', logDir: home, env: { MYCO_HOME: home },
      unit: { label: 'fixture', unitName: 'fixture', description: 'fixture', args: ['runner', 'run'], logName: 'fixture', restartDelaySeconds: 1 } },
    deps: { now: () => 10 } };
}

it('persists the update report with its order, retries it unchanged, and observes afresh after resync', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-report-'));
  try {
    const options = optionsFor(home);
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


it('keeps unchanged contacts and status reads free of counter and journal writes', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-noop-'));
  try {
    let writes = 0;
    const options = optionsFor(home);
    options.deps!.statePublisher = (file, text, flags) => { writes++; atomicWriteFileSync(file, text, flags); };
    const controller = createRunnerUpdateController(options);
    expect(controller.statusPayload().observedOrder).toBeUndefined();
    expect((await controller.check()).observedOrder).toBeUndefined();
    expect(fs.existsSync(path.join(home, 'report-order'))).toBe(false);
    expect(writes).toBe(0);
    const first = controller.contactPayload();
    const counter = path.join(home, 'report-order', deploymentKeyFor(options.serverUrl) + '.json');
    const before = fs.readFileSync(counter, 'utf8');
    expect(writes).toBe(1);
    for (let i = 0; i < 6; i++) {
      expect(createRunnerUpdateController(options).contactPayload()).toEqual(first);
      controller.onContact({ updateRecorded: true, observedOrder: first.observedOrder, updateRequest: null });
      expect(controller.statusPayload().observedOrder).toBeUndefined();
      expect(fs.readFileSync(counter, 'utf8')).toBe(before);
      expect(writes).toBe(1);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

it('refuses a corrupt counter visibly without delaying updates and resyncs a fresh observation after repair', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-counter-'));
  try {
    const options = optionsFor(home);
    const lines: string[] = [];
    options.log = line => lines.push(line);
    const counter = path.join(home, 'report-order', deploymentKeyFor(options.serverUrl) + '.json');
    fs.mkdirSync(path.dirname(counter), { recursive: true });
    fs.writeFileSync(counter, '');
    const controller = createRunnerUpdateController(options);
    for (let i = 0; i < 3; i++) {
      expect(controller.contactPayload().observedOrder).toBeUndefined();
      expect(readRunnerUpdateState(home)).toMatchObject({ nextCheckAt: 0, failures: 0 });
      expect(readRunnerUpdateState(home).lastResults).toBeUndefined();
      expect(fs.readFileSync(counter, 'utf8')).toBe('');
    }
    expect(lines).toContain('report_order_unavailable: update report refused; repair the reporting counter before retrying');
    controller.onContact({ updateRecorded: false, observedOrder: 100, updateRequest: null });
    withRunnerUpdateState(home, state => { state.lastCheckAt = 8; state.latestVersion = '2.0.0-alpha.2'; });
    fs.writeFileSync(counter, '5');
    const repaired = controller.contactPayload();
    expect(repaired).toMatchObject({ observedOrder: 101, lastCheckAt: 8, latestVersion: '2.0.0-alpha.2' });
    expect(readRunnerUpdateState(home).reportFloors?.[options.serverUrl]).toBeUndefined();
    expect(readRunnerUpdateState(home).nextCheckAt).toBe(0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});


it('leaves corrupt journals untouched on status reads and publishes a complete recovery record on the recovery path', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-readonly-'));
  try {
    const file = path.join(home, 'runner', 'update.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{unreadable pending handoff');
    const controller = createRunnerUpdateController(optionsFor(home));
    expect(() => controller.statusPayload()).toThrow();
    await expect(controller.check()).rejects.toThrow();
    expect(fs.readdirSync(path.dirname(file))).toEqual(['update.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe('{unreadable pending handoff');
    const recovered = readRunnerUpdateState(home);
    expect(recovered.metadataFailure?.reason).toContain('metadata is unreadable');
    expect(fs.existsSync(file)).toBe(true);
    expect(readRunnerUpdateState(home)).toEqual(recovered);
    expect(controller.statusPayload().lastResult?.reason).toContain('metadata is unreadable');
    expect(fs.readdirSync(path.dirname(file)).filter(name => name.startsWith('update.json.quarantine-'))).toHaveLength(1);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
