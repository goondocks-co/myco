import { expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WALL_DEADLINE_MS = 8000;
const fixture = fileURLToPath(new URL('../fixtures/stored-text-cost.ts', import.meta.url));
const ROUTE_RUN_LIMIT_MS = 60_000; // The route run measures how cost grows with size, not runner speed: it only has to end.
const cost = (mode: string, limit = WALL_DEADLINE_MS) => JSON.parse(execFileSync(process.execPath, [fixture, mode], { timeout: limit, encoding: 'utf8', env: process.env })
  .trim().split('\n').at(-1)!) as { mode: string; timings: number[] };

it('projects 1 MiB adversarial prose and redaction within an owned subprocess deadline', () => {
  const measured = cost('shared');
  expect(measured.timings).toHaveLength(5);
  expect(measured.timings.every((elapsed) => elapsed < WALL_DEADLINE_MS)).toBe(true);
}, WALL_DEADLINE_MS + 2000);

it('scales through the real report route and persists every bounded details', () => {
  const measured = cost('route', ROUTE_RUN_LIMIT_MS);
  expect(measured.timings).toHaveLength(4);
  for (let i = 2; i < measured.timings.length; i += 1) {
    expect(measured.timings[i]!).toBeLessThan(measured.timings[i - 1]! * 8 + 150);
  }
}, ROUTE_RUN_LIMIT_MS + 2000);
