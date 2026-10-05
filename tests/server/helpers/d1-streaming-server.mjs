import http from 'node:http';
import { once } from 'node:events';
import { gzipSync } from 'node:zlib';

const rows = Number(process.argv[2]);
const definition = 'CREATE TABLE payloads(value TEXT)';
const prefix = Buffer.from(`${definition};\n`);
const value = 'é;\n'.repeat(64) + 'x'.repeat(32 * 1024);
const row = Buffer.from(`INSERT INTO payloads VALUES('${value}');\n`);
const total = prefix.length + rows * row.length;
const gzip = process.argv[3] === 'gzip';
let downloads = 0;
const server = http.createServer(async (request, response) => {
  if (request.url === '/redirect') {
    response.writeHead(302, { location: '/export.sql' });
    response.end();
    return;
  }
  const offset = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? '')?.[1] ?? 0);
  if (gzip) {
    const compressed = gzipSync(Buffer.concat([prefix, row]));
    response.writeHead(200, { 'content-encoding': 'gzip', 'content-length': compressed.length });
    response.end(compressed);
    return;
  }
  const interrupt = ++downloads === 1 && process.argv[3] !== 'clean';
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
      if (interrupt && at > 1024 * 1024) { response.destroy(); return; }
    }
    response.end();
  } catch (error) {
    if (!response.destroyed) response.destroy(error);
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
console.log(JSON.stringify({ rows, definition, expectedCharacters: rows * value.length,
  signedUrl: `http://127.0.0.1:${server.address().port}/redirect` }));
