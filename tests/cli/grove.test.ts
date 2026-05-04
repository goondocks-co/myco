import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from '../helpers/vi-shim.js';
import { run } from '@myco/cli/grove.js';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-grove-cli-'));
  process.env.MYCO_HOME = home;
});

afterEach(() => {
  delete process.env.MYCO_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('myco grove CLI', () => {
  it('creates, lists, and selects Groves', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await run(['create', 'Work']);
    await run(['list']);
    await run(['use', 'work']);

    const output = log.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(output).toContain('Created Grove Work');
    expect(output).toContain('Work (work)');
    expect(output).toContain('Default Grove: Work');

    log.mockRestore();
  });
});
