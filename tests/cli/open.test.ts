import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * `myco open` targets the GLOBAL daemon dashboard, so it must resolve the
 * daemon port without any project/Grove context. Regression: a fresh host
 * whose MYCO_HOME has no project manifest must still open the dashboard
 * rather than throw "No Grove project id available for vault ~/.myco" — the
 * failure that surfaced when `open` routed through the tenant-scoped
 * `connectToDaemon`.
 */
const { fakeProbe, openState } = vi.hoisted(() => {
  const fakeProbe: { result: { myco: boolean } | null; calls: number[] } = {
    result: { myco: true },
    calls: [],
  };
  const openState: { urls: string[] } = { urls: [] };
  return { fakeProbe, openState };
});

mock.module('@myco/cli/open-browser.js', () => ({
  openBrowser: (url: string) => {
    openState.urls.push(url);
  },
}));

mock.module('@myco/daemon/eviction.js', () => ({
  probeMycoDaemon: async (port: number) => {
    fakeProbe.calls.push(port);
    return fakeProbe.result;
  },
}));

import { run } from '@myco/cli/open.js';
import { resolveGlobalDaemonPort } from '@myco/daemon/service-state.js';

describe('myco open targets the global daemon without a project context', () => {
  let testDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-open-'));
    originalHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = path.join(testDir, '.home');
    // A service dir but NO project manifest — the fresh-host shape that used
    // to make `connectToDaemon` throw the Grove-id error.
    fs.mkdirSync(path.join(process.env.MYCO_HOME, 'service'), { recursive: true });
    fakeProbe.result = { myco: true };
    fakeProbe.calls = [];
    openState.urls = [];
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = originalHome;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('opens the dashboard on the global daemon port — no project manifest required', async () => {
    const expectedPort = resolveGlobalDaemonPort();

    await run([]);

    // Probed the global port (context-free) and opened that exact URL.
    expect(fakeProbe.calls).toEqual([expectedPort]);
    expect(openState.urls).toEqual([`http://localhost:${expectedPort}/`]);
  });

  it('exits with an install hint when no daemon answers — does not open a dead URL', async () => {
    fakeProbe.result = null;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('__exit__');
    }) as never);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(run([])).rejects.toThrow('__exit__');
    expect(openState.urls).toEqual([]);

    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
