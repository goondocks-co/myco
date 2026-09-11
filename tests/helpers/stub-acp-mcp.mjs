import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

// The ACP child reads connection credentials from stdin, never from argv.
const request = JSON.parse(readFileSync(0, 'utf8'));
assert.equal(request.method, 'session/new');
assert.equal(typeof request.params.cwd, 'string');
assert.equal(request.params.mcpServers.length, 1);
const server = request.params.mcpServers[0];
assert.equal(server.type, 'http');
assert.equal(server.name, 'myco');
const headers = new Headers(server.headers.map(({ name, value }) => [name, value]));
headers.set('content-type', 'application/json');
headers.set('accept', 'application/json, text/event-stream');
// Local Wrangler does not supply an edge client address.
headers.set('cf-connecting-ip', '1.2.3.4');
const response = await fetch(server.url, {
  method: 'POST', headers,
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'myco_run_sessions', arguments: { op: 'material' },
  } }),
  signal: AbortSignal.timeout(15_000),
});
assert.equal(response.status, 200);
const body = await response.json();
assert.equal(body.error, undefined);
assert.notEqual(body.result.isError, true);
assert.equal(typeof body.result.structuredContent.result.session_id, 'string');
writeFileSync(process.argv[2], JSON.stringify(body.result.structuredContent.result), { mode: 0o600 });
