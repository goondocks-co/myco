import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxPath } from '../../scripts/test-environment.mjs';

describe('test temp boundary', () => {
  it('keeps the PowerShell executable beside its runtime assets through repeated sandboxing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pwsh-path-'));
    const tools = path.join(root, 'tools');
    const first = path.join(root, 'first');
    const second = path.join(root, 'second');
    for (const dir of [tools, first, second]) fs.mkdirSync(dir);
    const executable = path.join(tools, process.platform === 'win32' ? 'pwsh.exe' : 'pwsh');
    fs.writeFileSync(executable, 'fixture', { mode: 0o755 });
    const previous = process.env.MYCO_TEST_PWSH_EXECUTABLE;
    try {
      const firstPath = sandboxPath(first, tools);
      sandboxPath(second, firstPath);
      expect(process.env.MYCO_TEST_PWSH_EXECUTABLE).toBe(fs.realpathSync(executable));
    } finally {
      if (previous === undefined) delete process.env.MYCO_TEST_PWSH_EXECUTABLE;
      else process.env.MYCO_TEST_PWSH_EXECUTABLE = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('is established before this module loads and reaches every temp environment variable', () => {
    const root = process.env.MYCO_TEST_RUN_ROOT!;
    expect(fs.statSync(root).isDirectory()).toBe(true);
    expect(os.tmpdir()).toBe(root);
    for (const key of ['TMPDIR', 'TEMP', 'TMP']) expect(process.env[key]).toBe(root);
    expect(path.relative(root, os.homedir())).not.toMatch(/^\.\.(?:[/\\]|$)/);
    expect(path.relative(root, process.env.MYCO_HOME!)).not.toMatch(/^\.\.(?:[/\\]|$)/);
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
    expect(ci).toContain('node scripts/run-test-command.mjs node scripts/check-test-shards.mjs');
    const audit = fs.readFileSync(new URL('../../scripts/check-test-shards.mjs', import.meta.url), 'utf8');
    expect(audit).not.toMatch(/\['bun', 'test'/);
    expect(audit).toContain("['node', 'scripts/run-bun-tests.mjs', 'tests/parity/parity.test.ts']");
    expect(ci).toContain('PLAYWRIGHT_BROWSERS_PATH: ${{ github.workspace }}/target/playwright-browsers');
    expect(ci).toContain('path: target/playwright-browsers');
    const runner = fs.readFileSync(new URL('../../scripts/run-bun-tests.mjs', import.meta.url), 'utf8');
    expect(runner.indexOf('createTestTempRun();')).toBeLessThan(runner.indexOf('gen-worker-bundle.ts'));
    expect(runner).toContain("['--import', 'tsx', 'packages/myco/scripts/gen-worker-bundle.ts']");
    const screens = fs.readFileSync(new URL('../ui-screens/global-setup.ts', import.meta.url), 'utf8');
    expect(screens).toContain('registerTestProcess(child)');
  });
});
