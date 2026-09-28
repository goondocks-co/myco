/** A worker's log lines carry the instant they were written (#1424). */
import { describe, expect, it } from 'bun:test';
import { workerLogLine } from '@myco/runner/log.js';

describe('a worker log line', () => {
  it('begins with the ISO instant it was written, so two machines\' logs and the run record line up', () => {
    expect(workerLogLine('claimed run_1 (extract-curate) on claude-code, budget 900s', Date.UTC(2026, 8, 27, 23, 13, 31, 948)))
      .toBe('2026-09-27T23:13:31.948Z worker: claimed run_1 (extract-curate) on claude-code, budget 900s');
  });
});
