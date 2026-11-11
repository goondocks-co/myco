import { expect, it } from 'bun:test';
import { CommandFailed, CommandTimedOut } from '@myco/server/runner.js';
import {
  applyMigrationsPaced, D1_LAST_APPLY_MIN_MS, D1_MIGRATION_APPLY_TIMEOUT_MS, D1_OVERLOAD_BACKOFF_MIN_MS, D1_OVERLOAD_RETRIES,
  schemaStopLines, SchemaUpdateStopped,
} from '@myco/server/cloudflare-migration-pacing.js';

type Fault = 'overload' | 'overloaded after commit' | 'stall' | 'stall after commit' | 'overload with nothing listed';

/** A database at `start` whose migration files fail as scripted, one fault consumed per attempt at that file. */
function database(start: number, target: number, faults: Record<number, Fault[]>, secondsPerFile = 1) {
  let schema = start;
  let clock = 0;
  const waits: number[] = [];
  const timeouts: number[] = [];
  const lines: string[] = [];
  const failed = (listed: boolean) => new CommandFailed('npx', ['wrangler'], { code: 1, stdout: listed ? 'Migrations to be applied' : '', stderr: 'D1 DB is overloaded [code: 7429]' });
  const run = () => applyMigrationsPaced({
    databaseName: 'fixture', before: start, target, evidence: {}, report: (line) => lines.push(line),
    retry: { sleep: async (ms) => { waits.push(ms); clock += ms; }, now: () => clock },
    liveSchema: async () => schema,
    fileAfter: (version) => `file-${version + 1}`,
    apply: async (timeoutMs) => {
      timeouts.push(timeoutMs);
      while (schema < target) {
        const fault = faults[schema + 1]?.shift();
        if (fault === undefined || fault.includes('after commit')) { schema += 1; clock += secondsPerFile * 1000; }
        if (fault === 'overloaded after commit') throw failed(true);
        if (fault === 'stall' || fault === 'stall after commit') {
          clock += timeoutMs;
          throw new CommandTimedOut('npx', ['wrangler'], timeoutMs, 'ended');
        }
        if (fault === 'overload' || fault === 'overload with nothing listed') throw failed(fault === 'overload');
      }
    },
  });
  return { run, waits, timeouts, lines, schema: () => schema };
}

it('reads the schema after a stalled apply that committed a file and carries on from there', async () => {
  const d = database(3, 6, { 5: ['stall after commit'] });
  expect(await d.run()).toEqual({ kind: 'applied' });
  expect(d.schema()).toBe(6);
  expect(d.waits).toEqual([D1_OVERLOAD_BACKOFF_MIN_MS]);
  expect(d.lines.join('\n')).toContain('answered nothing for 15 minutes and was ended: schema 5 of 6');
});

it('stops by name when a stalled apply applies nothing twice, naming the file and the next command', async () => {
  const d = database(3, 6, { 4: ['stall', 'stall'] });
  const stopped = await d.run().catch((error) => error);
  expect(stopped).toBeInstanceOf(SchemaUpdateStopped);
  expect(stopped.stop).toMatchObject({ reason: 'migration_timed_out', migration: 'file-4', reached: 3 });
  const text = schemaStopLines(stopped.stop, { release: 'r', versionId: null, schema: 3 }).join('\n');
  expect(text).toContain('answered nothing for 15 minutes, twice');
  expect(text).toContain('run: myco server update --target cloudflare');
  expect(d.schema()).toBe(3);
});

it('never stops for lack of waits while every attempt advances the schema', async () => {
  const faults: Record<number, Fault[]> = {};
  for (let file = 2; file <= 20; file += 2) faults[file] = ['overloaded after commit'];
  const d = database(0, 20, faults);
  expect(await d.run()).toMatchObject({ kind: 'applied' });
  expect(d.schema()).toBe(20);
  expect(d.waits.length).toBeGreaterThan(D1_OVERLOAD_RETRIES);
  expect(new Set(d.waits)).toEqual(new Set([D1_OVERLOAD_BACKOFF_MIN_MS]));
  expect(d.lines.join('\n')).toContain(`retry 1 of ${D1_OVERLOAD_RETRIES} at schema`);
});

it('still stops once the waits at one schema are spent', async () => {
  const d = database(3, 6, { 4: Array(50).fill('overload with nothing listed') });
  const stopped = await d.run().catch((error) => error);
  expect(stopped.stop).toMatchObject({ reason: 'overloaded', reached: 3, retries: D1_OVERLOAD_RETRIES });
  expect(d.waits).toHaveLength(D1_OVERLOAD_RETRIES);
  expect(stopped.message).toContain(`through ${D1_OVERLOAD_RETRIES} retries at schema 3`);
});

it('stops by name when a backoff crosses the ceiling, without starting another apply', async () => {
  const faults: Record<number, Fault[]> = {};
  for (let file = 1; file <= 20; file += 1) faults[file] = ['overloaded after commit'];
  const d = database(0, 20, faults, 886);
  const stopped = await d.run().catch((error) => error);
  expect(stopped.stop).toMatchObject({ reason: 'out_of_time', reached: 8 });
  expect(d.timeouts).toHaveLength(8);
  expect(d.waits.at(-1)).toBeLessThan(D1_OVERLOAD_BACKOFF_MIN_MS);
  expect(schemaStopLines(stopped.stop, { release: 'r', versionId: null, schema: 0 }).join('\n')).toContain('ran past its 2 hours limit');
});

it('settles an apply cut short by the ceiling against the live schema before calling it out of time', async () => {
  const d = database(0, 4, { 1: ['overloaded after commit'], 2: ['stall'] }, 7000);
  const stopped = await d.run().catch((error) => error);
  expect(stopped.stop).toMatchObject({ reason: 'out_of_time', reached: 1 });
  expect(d.timeouts[1]).toBeLessThan(D1_MIGRATION_APPLY_TIMEOUT_MS);
  expect(Math.min(...d.timeouts)).toBeGreaterThanOrEqual(D1_LAST_APPLY_MIN_MS);
  expect(d.lines.join('\n')).toContain("The update's time ran out after");
});
