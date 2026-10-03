import assert from 'node:assert/strict';
import { writeFileSync } from "../support/fenced-fs.mjs";

/** Read a run's session material through the MCP connection the stub received. */
export async function writeRunMaterial(url, headers, receipt) {
  headers.set('content-type', 'application/json');
  headers.set('accept', 'application/json, text/event-stream');
  headers.set('cf-connecting-ip', '1.2.3.4');
  const response = await fetch(url, {
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
  writeFileSync(receipt, JSON.stringify(body.result.structuredContent.result), { mode: 0o600 });
}
