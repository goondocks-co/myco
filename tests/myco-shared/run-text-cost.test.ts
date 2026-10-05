import { expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WALL_DEADLINE_MS = 8000;
const fixture = fileURLToPath(new URL('../fixtures/stored-text-cost.ts', import.meta.url));
const cost = (mode: string) => JSON.parse(execFileSync(process.execPath, [fixture, mode], {
  timeout: WALL_DEADLINE_MS, encoding: 'utf8', env: process.env,
}).trim().split('\n').at(-1)!) as { mode: string; timings: number[] };

it('projects 1 MiB adversarial prose and redaction within an owned subprocess deadline', () => {
  const measured = cost('shared');
  expect(measured.timings).toHaveLength(3);
  expect(measured.timings.every((elapsed) => elapsed < WALL_DEADLINE_MS)).toBe(true);
}, WALL_DEADLINE_MS + 2000);

it('scales through the real report route and persists every bounded details', () => {
  const measured = cost('route');
  expect(measured.timings).toHaveLength(4);
  for (let i = 2; i < measured.timings.length; i += 1) {
    expect(measured.timings[i]!).toBeLessThan(measured.timings[i - 1]! * 8 + 150);
  }
}, WALL_DEADLINE_MS + 2000);
