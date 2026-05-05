import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { createGrove, setDefaultGrove } from '@myco/grove/registry.js';
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

  it('migrates projects into the default Grove when --grove is omitted', async () => {
    const projectRoot = path.join(home, 'project');
    const vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    const db = openDatabase(path.join(vaultDir, 'myco.db'));
    try {
      createSchema(db);
    } finally {
      db.close();
    }

    createGrove('Dogfood', home);
    const defaultGrove = createGrove('Default Projects', home);
    setDefaultGrove(defaultGrove.id, home);

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await run(['migrate-project', '--project', projectRoot, '--dry-run', '--json']);

    const parsed = JSON.parse(log.mock.calls.at(-1)?.[0] as string) as { grove: { id: string }; dry_run: boolean };
    expect(parsed.grove.id).toBe(defaultGrove.id);
    expect(parsed.dry_run).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, 'project.toml'))).toBe(false);

    log.mockRestore();
  });
});
