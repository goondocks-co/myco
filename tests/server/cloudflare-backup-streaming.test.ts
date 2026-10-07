import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fetchD1Download } from '@myco/server/d1-download.js';

const MAX_RSS_MIB = 1536;
const MAX_RSS_KIB = MAX_RSS_MIB * 1024;
const MAX_RSS_GROWTH_MIB = 64;
const MAX_RSS_GROWTH_KIB = MAX_RSS_GROWTH_MIB * 1024;
const BASELINE_ROWS = 8192;
const LARGE_ROWS = 65537;
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

interface ExportFixture { rows: number; interrupted: boolean; metadata: string }

async function measureExports(fixtures: ExportFixture[]): Promise<number[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-d1-streaming-'));
  for (const fixture of fixtures) expect(JSON.parse(fixture.metadata).rows).toBe(fixture.rows);
  const child = Bun.spawn([process.execPath, '--no-env-file',
    path.join(repo, 'tests/server/helpers/d1-streaming-child.ts'), root,
    JSON.stringify(fixtures.map((fixture) => JSON.parse(fixture.metadata)))],
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
    const progressFile = path.join(root, 'progress.json');
    const progress = fs.existsSync(progressFile) ? fs.readFileSync(progressFile, 'utf8') : '{"phase":"download"}';
    console.log(`D1 streaming: measured peak ${measuredKiB} KiB; progress ${progress}; ${stdout.trim()}`);
    expect(monitorError).toBeNull();
    expect({ code, stderr, measuredKiB }).toMatchObject({ code: 0, stderr: '' });
    expect(measuredKiB).toBeLessThan(MAX_RSS_KIB);
    const results = JSON.parse(stdout);
    expect(results).toHaveLength(fixtures.length);
    return fixtures.map(({ rows, interrupted }, index) => {
      const result = results[index];
      expect(result.rows).toBe(rows);
      expect(result.peakKiB).toBeGreaterThan(0);
      expect(result.peakKiB).toBeLessThan(MAX_RSS_KIB);
      expect(result.result).toEqual({ rows, characters: result.expectedCharacters });
      expect(result.starts).toBe(1);
      expect(result.downloads).toBe(interrupted ? 2 : 1);
      expect(result.resumed).toBe(interrupted);
      if (rows === LARGE_ROWS) expect(result.bytes).toBeGreaterThan(2 * 1024 ** 3);
      return result.peakKiB;
    });
  } finally {
    clearInterval(monitor);
    child.kill();
    await child.exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

it(`downloads and imports an 8x larger SQL export with less than ${MAX_RSS_GROWTH_MIB} MiB RSS growth`, async () => {
  await withServer(BASELINE_ROWS, 'clean', async (baselineMetadata) => {
    await withServer(LARGE_ROWS, 'clean', async (largeMetadata) => {
      const [baselineKiB, largeKiB] = await measureExports([
        { rows: BASELINE_ROWS, interrupted: false, metadata: baselineMetadata },
        { rows: LARGE_ROWS, interrupted: false, metadata: largeMetadata },
      ]);
      const growthKiB = largeKiB - baselineKiB;
      console.log(`D1 streaming RSS growth: ${growthKiB} KiB; safety cap ${MAX_RSS_KIB} KiB`);
      expect(growthKiB).toBeGreaterThanOrEqual(0);
      expect(growthKiB).toBeLessThan(MAX_RSS_GROWTH_KIB);
    });
  });
}, 600_000);

it('resumes an interrupted SQL export and imports every row', async () => {
  await withServer(4096, 'interrupt', async (metadata) => {
    await measureExports([{ rows: 4096, interrupted: true, metadata }]);
  });
}, 300_000);

it('streams a redirected, encoded signed download while preserving its encoding metadata', async () => {
  await withServer(1, 'gzip', async (metadata) => {
    const { signedUrl } = JSON.parse(metadata);
    const response = await fetchD1Download(signedUrl, { headers: { 'accept-encoding': 'identity' } });
    expect(response.headers.get('content-encoding')).toBe('gzip');
    const decoder = new TextDecoder();
    let text = '';
    for (;;) {
      const chunk = await response.reader!.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    expect(text).toStartWith('CREATE TABLE payloads(value TEXT);');
    expect(text).toContain('INSERT INTO payloads');
    expect(text.length).toBeGreaterThan(Number(response.headers.get('content-length')));
  });
});
