import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeRunMaterial } from './stub-run-mcp.mjs';

// The ACP child reads connection credentials from stdin, never from argv.
const request = JSON.parse(readFileSync(0, 'utf8'));
assert.equal(request.method, 'session/new');
assert.equal(typeof request.params.cwd, 'string');
assert.equal(request.params.mcpServers.length, 1);
const server = request.params.mcpServers[0];
assert.equal(server.type, 'http');
assert.equal(server.name, 'myco');
const headers = new Headers(server.headers.map(({ name, value }) => [name, value]));
await writeRunMaterial(server.url, headers, process.argv[2]);
