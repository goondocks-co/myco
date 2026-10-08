import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { exportD1 } from '@myco/server/cloudflare-d1-export.js';
import { buildSnapshotDatabase } from '@myco/server/recovery-snapshot.js';
import { fetchD1Download } from '@myco/server/d1-download.js';

const [root, metadata] = process.argv.slice(2);
if (!root || !metadata) throw new Error('root and HTTP fixture metadata required');
interface Fixture {
  rows: number; signedUrl: string; definition: string; expectedCharacters: number;
}
const fixtures = JSON.parse(metadata) as Fixture[];
/** Process-wide RSS high-water mark in KiB, cumulative across exports. */
const peakKiB = () => process.resourceUsage().maxRSS;
const CONSUMER_PAUSE_MS = 2;
const PROGRESS_BYTES = 16 * 1024 ** 2;

async function measureExport(root: string, { rows, signedUrl, definition, expectedCharacters }: Fixture) {
  const exportRoot = path.join(root, String(rows));
  fs.mkdirSync(exportRoot);
  let starts = 0;
  let downloads = 0;
  let resumed = false;
  const sqlPath = path.join(exportRoot, 'export.sql');
  const databasePath = path.join(exportRoot, 'snapshot.sqlite');
  const progressFile = path.join(root, 'progress.json');
  let readBytes = 0;
  let reportedBytes = 0;
  let maxDownloadChunkBytes = 0;
  fs.writeFileSync(progressFile, JSON.stringify({ rows, phase: 'download', readBytes }));
  await exportD1({
    accountId: 'fixture', databaseId: 'fixture', tables: ['payloads'], schema: 'fixture', output: sqlPath, recordDir: exportRoot,
    login: { current: async () => new Headers(), headers: async () => new Headers(), refused: () => {} },
    sleep: async () => {},
    download: async (url, init) => {
      downloads++;
      resumed ||= new Headers(init.headers).has('range');
      const response = await fetchD1Download(url, init);
      const reader = response.reader!;
      return { ...response, reader: {
        async read() {
          const chunk = await reader.read();
          if (!chunk.done) {
            readBytes += chunk.value.byteLength;
            maxDownloadChunkBytes = Math.max(maxDownloadChunkBytes, chunk.value.byteLength);
            if (readBytes - reportedBytes >= PROGRESS_BYTES) {
              reportedBytes = readBytes;
              fs.writeFileSync(progressFile, JSON.stringify({ rows, phase: 'download', readBytes, maxDownloadChunkBytes }));
            }
            await new Promise((resolve) => setTimeout(resolve, CONSUMER_PAUSE_MS));
          }
          return chunk;
        },
        cancel: (reason) => reader.cancel(reason),
      } };
    },
    fetch: async (_url, init) => {
      if (!JSON.parse(String(init.body)).current_bookmark) starts++;
      return Response.json({ success: true, result: { success: true, status: 'complete', at_bookmark: 'same-export', result: { signed_url: signedUrl } } });
    },
  });
  const downloadPeakKiB = peakKiB();
  fs.writeFileSync(progressFile, JSON.stringify({ rows, phase: 'import', downloadPeakKiB, maxDownloadChunkBytes, bytes: fs.statSync(sqlPath).size }));
  await buildSnapshotDatabase(databasePath, sqlPath, [{ type: 'table', name: 'payloads', sql: definition, storage: 'table' }]);
  const db = new Database(databasePath, { readonly: true });
  try {
    const result = db.query('SELECT count(*) AS rows, sum(length(value)) AS characters FROM payloads').get();
    return { bytes: fs.statSync(sqlPath).size, rows, result, starts, downloads, resumed,
      downloadPeakKiB, maxDownloadChunkBytes, peakKiB: peakKiB(), expectedCharacters };
  } finally {
    db.close();
    fs.rmSync(exportRoot, { recursive: true, force: true });
  }
}

const results = [];
for (const fixture of fixtures) {
  results.push(await measureExport(root, fixture));
  Bun.gc(true);
}
console.log(JSON.stringify(results));
