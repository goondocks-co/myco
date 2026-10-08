import { afterEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from '../support/fenced-fs.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processAlive } from './process-alive.js';
import { readTestProcessState } from '../../scripts/test-process-tree.mjs';
import { removeWhenTestsEnd } from './remove-when-tests-end.js';

describe('processAlive', () => {
  it('reports the running test process alive', () => {
    expect(processAlive(process.pid)).toBe(true);
  });

  it('reports a reaped child gone', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    const pid = child.pid!;
    await new Promise((resolve) => { child.once('close', resolve); });
    expect(processAlive(pid)).toBe(false);
  });

  it('reports a process reaped between the signal probe and the table lookup gone', () => {
    expect(processAlive(process.pid, () => null)).toBe(false);
  });

  it('reports a zombie gone', () => {
    expect(processAlive(process.pid, () => 'Z+')).toBe(false);
  });
});

describe('processAlive classification of the real ps', () => {
  const previousPath = process.env.PATH;
  afterEach(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });

  /** A PATH holding only a `ps` that writes `stdout` and `stderr` and exits `status`, or no `ps` at all. */
  function pathWithPs(script: string | null): string {
    const bin = removeWhenTestsEnd(mkdtempSync(join(tmpdir(), 'myco-process-alive-ps-')));
    if (script !== null) {
      const ps = join(bin, 'ps');
      writeFileSync(ps, `#!/bin/sh\n${script}\n`);
      chmodSync(ps, 0o755);
    }
    return bin;
  }
  // The test process always passes the signal probe, so the outcome is the shimmed table lookup's.
  const lookup = (script: string | null): boolean => {
    process.env.PATH = pathWithPs(script);
    return processAlive(process.pid, pid => readTestProcessState(pid, 'ps'));
  };

  it('reads status 1 with nothing printed as a process gone from the table', () => {
    expect(lookup('exit 1')).toBe(false);
  });

  it('reads a state column on status 0 as the process\'s state', () => {
    expect(lookup('echo S+')).toBe(true);
    expect(lookup('echo Z+')).toBe(false);
  });

  it('throws when ps exits 1 with a diagnostic, rather than reading a live process as gone', () => {
    expect(() => lookup('echo "process table unavailable" >&2; exit 1')).toThrow('process table unavailable');
  });

  it('throws on any other failure status', () => {
    expect(() => lookup('exit 2')).toThrow('exit 2');
  });

  it('throws when ps cannot be executed', () => {
    expect(() => lookup(null)).toThrow();
  });
});
