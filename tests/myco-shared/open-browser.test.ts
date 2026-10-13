import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sandboxChildEnv } from '../../scripts/test-environment.mjs';

it('a missing browser opener leaves the caller running', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-missing-opener-'));
  try {
    const module = pathToFileURL(path.resolve(import.meta.dir, '../../packages/myco-shared/src/open-browser.ts')).href;
    const code = `import { openBrowser } from ${JSON.stringify(module)}; process.env.PATH = ${JSON.stringify(root)}; openBrowser('https://fixture.invalid'); await new Promise(resolve => setTimeout(resolve, 100)); console.log('caller survived');`;
    const child = Bun.spawnSync([process.execPath, '--no-env-file', '-e', code], {
      cwd: root, env: sandboxChildEnv(root), stdout: 'pipe', stderr: 'pipe', timeout: 5000,
    });
    expect({ code: child.exitCode, stderr: child.stderr.toString() }).toMatchObject({ code: 0 });
    expect(child.stdout.toString()).toContain('caller survived');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
