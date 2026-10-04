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
      expect(pkg.scripts.pretest).toBeUndefined();
      const scripts = Object.entries(pkg.scripts).filter(([name]) => name === 'test' || name.startsWith('test:'));
      expect(scripts.length).toBeGreaterThan(0);
      for (const [name, command] of scripts) expect({ name, command }).toEqual({ name, command: expect.stringContaining(name === 'test:screens' ? 'scripts/run-test-command.mjs' : 'scripts/run-bun-tests.mjs') });
    }
    const ci = fs.readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
    expect(ci).not.toMatch(/\bbun test\b/);
    expect(ci).toContain('PLAYWRIGHT_BROWSERS_PATH: ${{ github.workspace }}/target/playwright-browsers');
    expect(ci).toContain('path: target/playwright-browsers');
    const runner = fs.readFileSync(new URL('../../scripts/run-bun-tests.mjs', import.meta.url), 'utf8');
    expect(runner.indexOf('createTestTempRun();')).toBeLessThan(runner.indexOf('gen-worker-bundle.ts'));
    expect(runner).toContain("['--import', 'tsx', 'packages/myco/scripts/gen-worker-bundle.ts']");
  });
});
