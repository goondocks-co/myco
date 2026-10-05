import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { exportD1 } from '@myco/server/cloudflare-d1-export.js';
import { buildSnapshotDatabase } from '@myco/server/recovery-snapshot.js';
import { fetchD1Download } from '@myco/server/d1-download.js';

const [root, metadata] = process.argv.slice(2);
if (!root || !metadata) throw new Error('root and HTTP fixture metadata required');
const { rows, signedUrl, definition, expectedCharacters } = JSON.parse(metadata) as {
  rows: number; signedUrl: string; definition: string; expectedCharacters: number;
};
let starts = 0;
let downloads = 0;
let resumed = false;
const sqlPath = path.join(root, 'export.sql');
const databasePath = path.join(root, 'snapshot.sqlite');
const peakKiB = () => process.resourceUsage().maxRSS / (process.platform === 'darwin' ? 1024 : 1);
const CONSUMER_PAUSE_MS = 2;
await exportD1({
  accountId: 'fixture', databaseId: 'fixture', tables: ['payloads'], schema: 'fixture', output: sqlPath, recordDir: root,
  login: { current: async () => new Headers(), headers: async () => new Headers(), refused: () => {} },
  sleep: async () => {},
  fetch: async (url, init) => {
    if (url === signedUrl) {
      downloads++;
      resumed ||= new Headers(init.headers).has('range');
      const response = await fetchD1Download(url, init);
      const reader = response.body!.getReader();
      // A slow sink must backpressure the network rather than grow its unread body.
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          const chunk = await reader.read();
          if (chunk.done) controller.close();
          else {
            await new Promise((resolve) => setTimeout(resolve, CONSUMER_PAUSE_MS));
            controller.enqueue(chunk.value);
          }
        },
        cancel: (reason) => reader.cancel(reason),
      }, { highWaterMark: 0 });
      return new Response(body, { status: response.status, headers: response.headers });
    }
    if (!JSON.parse(String(init.body)).current_bookmark) starts++;
    return Response.json({ success: true, result: { success: true, status: 'complete', at_bookmark: 'same-export', result: { signed_url: signedUrl } } });
  },
});
const downloadPeakKiB = peakKiB();
await buildSnapshotDatabase(databasePath, sqlPath, [{ type: 'table', name: 'payloads', sql: definition, storage: 'table' }]);
const db = new Database(databasePath, { readonly: true });
try {
  const result = db.query('SELECT count(*) AS rows, sum(length(value)) AS characters FROM payloads').get();
  console.log(JSON.stringify({ bytes: fs.statSync(sqlPath).size, rows, result, starts, downloads, resumed,
    downloadPeakKiB, peakKiB: peakKiB(), expectedCharacters }));
} finally { db.close(); }
