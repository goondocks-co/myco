import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { driftSummary, durationDrift, fileSuiteMilliseconds, phaseGroup } from '../../scripts/node-report-workload.mjs';

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
