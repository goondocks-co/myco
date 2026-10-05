import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const MAX_RSS_KIB = 512 * 1024;
const repo = fileURLToPath(new URL('../../', import.meta.url));

it('downloads and imports a multi-GB export below 512 MiB RSS, resuming the same export', async () => {
  for (const rows of [4096, 65537]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-d1-streaming-'));
    const child = Bun.spawn([process.execPath, '--no-env-file', '--tsconfig-override', path.join(repo, 'tsconfig.json'),
      path.join(repo, 'tests/server/helpers/d1-streaming-child.ts'), root, String(rows)],
    { env: process.env, stdout: 'pipe', stderr: 'pipe' });
    let measuredKiB = 0;
    const monitor = setInterval(() => {
      try {
        const rss = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' }).trim());
        measuredKiB = Math.max(measuredKiB, rss);
        if (rss > MAX_RSS_KIB) child.kill();
      } catch (error) {
        if (child.exitCode === null) throw error;
      }
    }, 250);
    try {
      const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      console.log(`D1 streaming ${rows} rows: measured peak ${measuredKiB} KiB; ${stdout.trim()}`);
      expect({ code, stderr, measuredKiB }).toMatchObject({ code: 0, stderr: '' });
      const result = JSON.parse(stdout);
      expect(result.peakKiB).toBeLessThan(MAX_RSS_KIB);
      expect(measuredKiB).toBeLessThan(MAX_RSS_KIB);
      expect(result.result).toEqual({ rows, characters: result.expectedCharacters });
      expect(result.starts).toBe(1);
      expect(result.downloads).toBe(2);
      expect(result.resumed).toBe(true);
      if (rows === 65537) expect(result.bytes).toBeGreaterThan(2 * 1024 ** 3);
    } finally {
      clearInterval(monitor);
      child.kill();
      await child.exited;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
}, 300_000);
