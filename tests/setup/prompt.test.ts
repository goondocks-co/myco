import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

it('the shared terminal prompt closes on Ctrl-C and explains how to resume', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-prompt-signal-'));
  const child = spawn(process.execPath, [path.join(import.meta.dir, 'fixtures/prompt-signal.ts')], { cwd: root, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let sent = false;
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Prompt did not stop: ${output}`)); }, 5000);
      child.stdout.on('data', data => {
        output += data.toString();
        if (!sent && output.includes('READY')) { sent = true; child.stdin.write('\x03'); }
      });
      child.stderr.on('data', data => { output += data.toString(); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve(code); });
    });
    expect(code, output).toBe(0);
    expect(output).toContain('Command interrupted; run it again to resume.');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
