import { describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { processAlive } from './process-alive.js';

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
