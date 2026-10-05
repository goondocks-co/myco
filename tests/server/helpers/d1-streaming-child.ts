import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { Database } from 'bun:sqlite';
import { exportD1 } from '@myco/server/cloudflare-d1-export.js';
import { buildSnapshotDatabase } from '@myco/server/recovery-snapshot.js';

const [root, countText] = process.argv.slice(2);
if (!root || !countText) throw new Error('root and row count required');
const rows = Number(countText);
const definition = 'CREATE TABLE payloads(value TEXT)';
const prefix = Buffer.from(`${definition};\n`);
const value = 'é;\n'.repeat(64) + 'x'.repeat(32 * 1024);
const row = Buffer.from(`INSERT INTO payloads VALUES('${value}');\n`);
const total = prefix.length + rows * row.length;
let starts = 0;
let downloads = 0;
let resumed = false;
const server = http.createServer(async (request, response) => {
  const offset = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? '')?.[1] ?? 0);
  downloads++;
  resumed ||= offset > 0;
  response.writeHead(offset > 0 ? 206 : 200, {
    'content-length': total - offset, etag: '"synthetic-export"',
    ...(offset > 0 ? { 'content-range': `bytes ${offset}-${total - 1}/${total}` } : {}),
  });
  let at = offset;
  try {
    while (at < total) {
      const buffer = at < prefix.length ? prefix : row;
      const within = at < prefix.length ? at : (at - prefix.length) % row.length;
      const chunk = buffer.subarray(within);
      at += chunk.length;
      if (!response.write(chunk)) await once(response, 'drain');
      if (downloads === 1 && at > 1024 * 1024) { response.destroy(); return; }
    }
    response.end();
  } catch (error) {
    if (!response.destroyed) response.destroy(error as Error);
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('HTTP address missing');
const signedUrl = `http://127.0.0.1:${address.port}/export.sql`;
const sqlPath = path.join(root, 'export.sql');
const databasePath = path.join(root, 'snapshot.sqlite');
const peakKiB = () => process.resourceUsage().maxRSS / (process.platform === 'darwin' ? 1024 : 1);
try {
  await exportD1({
    accountId: 'fixture', databaseId: 'fixture', tables: ['payloads'], schema: 'fixture', output: sqlPath, recordDir: root,
    login: { current: async () => new Headers(), headers: async () => new Headers(), refused: () => {} },
    sleep: async () => {},
    fetch: async (url, init) => {
      if (url === signedUrl) return fetch(url, init);
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
      downloadPeakKiB, peakKiB: peakKiB(), expectedCharacters: rows * value.length }));
  } finally { db.close(); }
} finally {
  server.closeAllConnections();
  server.close();
}
