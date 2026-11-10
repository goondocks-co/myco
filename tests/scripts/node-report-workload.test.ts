import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactGroups, driftSummary, durationDrift, fileSuiteMilliseconds, phaseGroup } from '../../scripts/node-report-workload.mjs';

const sample = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/runner/node-report-sample');

test('a phase report records file-suite time inside the phase wall time', () => {
  const log = fs.readFileSync(path.join(sample, 'phase.log'), 'utf8');
  const xml = fs.readFileSync(path.join(sample, 'phase.junit.xml'), 'utf8');
  expect(fileSuiteMilliseconds(xml)).toEqual({ 'tests/example-a.test.ts': 250, 'tests/example-b.test.ts': 750 });
  const group = phaseGroup(log, xml);
  expect(group.label).toBe('node env isolated 1');
  expect(group.milliseconds).toBe(1500);
  expect(group.files).toEqual({ 'tests/example-a.test.ts': 250, 'tests/example-b.test.ts': 750 });
  const wall = durationDrift([group], { 'tests/example-a.test.ts': 100, 'tests/example-b.test.ts': 2000 }, 225_000);
  expect(wall.files.map(file => file.file)).toEqual(['tests/example-a.test.ts']);
  expect(wall.groups).toEqual([]);
  const slow = durationDrift([{ ...group, milliseconds: 300_000, files: { 'tests/example-a.test.ts': 300_000 } }], { 'tests/example-a.test.ts': 300_000 }, 225_000);
  expect(slow.groups.map(item => item.label)).toEqual(['node env isolated 1']);
  expect(driftSummary(slow)).toContain('npm run refresh:node-durations');
  expect(driftSummary(wall)).toContain('tests/example-a.test.ts');
  expect(driftSummary(durationDrift([group], { 'tests/example-a.test.ts': 10_000, 'tests/example-b.test.ts': 10_000 }, 225_000))).toContain('No file ran over');
});

test('a killed phase with no JUnit is named and does not fail the read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-drift-'));
  try {
    const run = path.join(root, 'run-killed');
    fs.mkdirSync(run);
    fs.writeFileSync(path.join(run, 'node-env.log'), '[run-bun-tests] KILLED (over budget) node env isolated 1 in 600000ms (exit 124)\n');
    const killedPhase = artifactGroups(root);
    expect(killedPhase.groups).toEqual([]);
    expect(killedPhase.killed.map(phase => phase.label)).toEqual(['node env isolated 1']);
    expect(killedPhase.reports).toEqual([]);
    const summary = driftSummary({ files: [], groups: [], groupBudget: 225_000, killed: killedPhase.killed });
    expect(summary).toContain('group `node env isolated 1` was killed');
    expect(summary).toContain('npm run refresh:node-durations');

    fs.writeFileSync(path.join(run, 'node-env.log'), '[run-bun-tests] STARTING node env\n');
    const unread = artifactGroups(root);
    expect(unread.killed).toEqual([]);
    expect(unread.reports).toEqual(['node-env.log: no FINISHED or KILLED line']);

    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'node-drift-empty-'));
    try {
      expect(artifactGroups(empty).reports).toEqual([`${path.basename(empty)}: no run directory`]);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
