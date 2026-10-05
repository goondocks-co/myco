import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fetchD1Download } from '@myco/server/d1-download.js';

const MAX_RSS_KIB = 512 * 1024;
const MAX_METADATA_CHARACTERS = 4096;
const repo = fileURLToPath(new URL('../../', import.meta.url));

async function withServer(rows: number, mode: string, run: (metadata: string) => Promise<void>): Promise<void> {
  const server = Bun.spawn(['node', path.join(repo, 'tests/server/helpers/d1-streaming-server.mjs'), String(rows), mode],
    { env: process.env, stdout: 'pipe', stderr: 'pipe' });
  try {
    const reader = server.stdout.getReader();
    const decoder = new TextDecoder();
    let metadata = '';
    try {
      while (!metadata.includes('\n')) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error('HTTP fixture ended before its address arrived');
        metadata += decoder.decode(chunk.value, { stream: true });
        if (metadata.length > MAX_METADATA_CHARACTERS) throw new Error('HTTP fixture metadata exceeds its limit');
      }
    } finally { reader.releaseLock(); }
    await run(metadata.slice(0, metadata.indexOf('\n')));
  } finally {
    server.kill();
    await server.exited;
    expect(await new Response(server.stderr).text()).toBe('');
  }
}

for (const rows of [4096, 65537]) {
  it(`downloads and imports ${rows} SQL rows below 512 MiB RSS`, async () => {
    await withServer(rows, rows === 4096 ? 'interrupt' : 'clean', async (metadata) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-d1-streaming-'));
      expect(JSON.parse(metadata).rows).toBe(rows);
      const child = Bun.spawn([process.execPath, '--no-env-file',
        path.join(repo, 'tests/server/helpers/d1-streaming-child.ts'), root, metadata],
      { env: process.env, stdout: 'pipe', stderr: 'pipe' });
      let measuredKiB = 0;
      let monitorError: unknown = null;
      const monitor = setInterval(() => {
        try {
          const rss = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' }).trim());
          measuredKiB = Math.max(measuredKiB, rss);
          if (rss > MAX_RSS_KIB) child.kill();
        } catch (error) {
          if (child.exitCode === null) { monitorError = error; child.kill(); }
        }
      }, 250);
      try {
        const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
        console.log(`D1 streaming ${rows} rows: measured peak ${measuredKiB} KiB; ${stdout.trim()}`);
        expect(monitorError).toBeNull();
        expect({ code, stderr, measuredKiB }).toMatchObject({ code: 0, stderr: '' });
        const result = JSON.parse(stdout);
        expect(result.peakKiB).toBeLessThan(MAX_RSS_KIB);
        expect(measuredKiB).toBeLessThan(MAX_RSS_KIB);
        expect(result.result).toEqual({ rows, characters: result.expectedCharacters });
        expect(result.starts).toBe(1);
        expect(result.downloads).toBe(rows === 4096 ? 2 : 1);
        expect(result.resumed).toBe(rows === 4096);
        if (rows === 65537) expect(result.bytes).toBeGreaterThan(2 * 1024 ** 3);
      } finally {
        clearInterval(monitor);
        child.kill();
        await child.exited;
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }, 300_000);
}

it('streams a redirected, encoded signed download while preserving its encoding metadata', async () => {
  await withServer(1, 'gzip', async (metadata) => {
    const { signedUrl } = JSON.parse(metadata);
    const response = await fetchD1Download(signedUrl, { headers: { 'accept-encoding': 'identity' } });
    expect(response.headers.get('content-encoding')).toBe('gzip');
    const text = await response.text();
    expect(text).toStartWith('CREATE TABLE payloads(value TEXT);');
    expect(text).toContain('INSERT INTO payloads');
    expect(text.length).toBeGreaterThan(Number(response.headers.get('content-length')));
  });
});
