import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run } from '@myco/cli/finish-uninstall.js';

describe('myco __finish-uninstall', () => {
  it('removes the target install dir (recursively)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-fu-'));
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bin', 'myco'), 'binary');
    await run([dir]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('no-ops when the dir is already gone', async () => {
    const dir = path.join(os.tmpdir(), `myco-fu-missing-${process.pid}`);
    await run([dir]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('returns without throwing when no dir argument is given', async () => {
    await expect(run([])).resolves.toBeUndefined();
  });
});
