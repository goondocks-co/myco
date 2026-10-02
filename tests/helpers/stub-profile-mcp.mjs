import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeRunMaterial } from './stub-run-mcp.mjs';

const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const server = config.mcpServers.myco;
assert.equal(server.type, 'http');
const headers = new Headers(server.headers);
await writeRunMaterial(server.url, headers, process.argv[3]);
