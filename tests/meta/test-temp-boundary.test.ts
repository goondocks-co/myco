import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

describe('test temp boundary', () => {
  it('is established before this module loads and reaches every temp environment variable', () => {
    const root = process.env.MYCO_TEST_RUN_ROOT!;
    expect(fs.statSync(root).isDirectory()).toBe(true);
    expect(os.tmpdir()).toBe(root);
    for (const key of ['TMPDIR', 'TEMP', 'TMP']) expect(process.env[key]).toBe(root);
    expect(path.relative(root, os.homedir())).not.toMatch(/^\.\.(?:[/\\]|$)/);
  });

  it('routes every active Bun test script and the Windows CI contracts through the runner', () => {
    for (const file of ['../../package.json', '../../packages/myco/package.json']) {
      const pkg = JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8')) as { scripts: Record<string, string> };
      const scripts = Object.entries(pkg.scripts).filter(([name]) => name === 'test' || name.startsWith('test:') && name !== 'test:screens');
      expect(scripts.length).toBeGreaterThan(0);
      for (const [name, command] of scripts) expect({ name, command }).toEqual({ name, command: expect.stringContaining('scripts/run-bun-tests.mjs') });
    }
    const ci = fs.readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(ci).not.toMatch(/\bbun test\b/);
  });
});
