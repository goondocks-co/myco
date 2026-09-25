/**
 * Opt-in live smoke using this machine's harness logins and Deployment membership.
 * MYCO_SMOKE_SERVER=<url> MYCO_SMOKE_PROJECT=<id> npm run smoke:worker
 * MYCO_SMOKE_HARNESSES selects a comma-separated subset of the default matrix.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { detectHarnesses } from '../packages/myco/src/runner/detect.js';
import { runWorker } from '../packages/myco/src/runner/loop.js';
import { readDeploymentMembership } from '../packages/myco/src/member/registry.js';
import { memberHeaders } from '../packages/myco/src/member/constants.js';
import { verifyWorkerOutcome } from '../tests/helpers/worker-smoke-evidence.js';

const SERVER = process.env.MYCO_SMOKE_SERVER ?? '';
const PROJECT = process.env.MYCO_SMOKE_PROJECT ?? '';
const HARNESSES = (process.env.MYCO_SMOKE_HARNESSES ?? 'claude-code,codex,opencode').split(',').map((id) => id.trim());
const SMOKE_TIMEOUT_MS = 420_000;
const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const;

assert(SERVER.length > 0 && PROJECT.length > 0, 'Set MYCO_SMOKE_SERVER and MYCO_SMOKE_PROJECT to the live target');
const endpoint = new URL('/mcp', SERVER);
const membership = readDeploymentMembership(SERVER);
assert(membership !== null, 'This machine holds no membership of the target Deployment');
const ready = new Set(detectHarnesses(HARNESSES).filter((h) => h.authenticated).map((h) => h.id));
for (const harness of HARNESSES) assert(ready.has(harness), `${harness || '(empty harness)'} is not installed and logged in`);

for (const harness of HARNESSES) {
  const runRoot = mkdtempSync(join(tmpdir(), 'myco-worker-smoke-'));
  const stopping = new AbortController();
  const stop = () => stopping.abort();
  for (const signal of STOP_SIGNALS) process.once(signal, stop);
  const timeout = setTimeout(() => stopping.abort(), SMOKE_TIMEOUT_MS);
  const lines: string[] = [];
  const client = new Client({ name: 'myco-worker-smoke', version: '1' });
  try {
    const { driven, refused } = await runWorker({
      serverUrl: SERVER, token: membership.token, lockDir: null, runRoot, only: [harness], once: true, pollIdleMs: 1_000,
      log: (line) => { lines.push(line); console.log(line); }, signal: stopping.signal,
    });
    assert.equal(refused, null, 'The Deployment refused the worker');
    assert.equal(driven, 1, 'The worker did not drive one run within the smoke bound');
    const runId = lines.map((line) => /^claimed (\S+) /.exec(line)?.[1]).find(Boolean);
    assert(runId !== undefined, 'The worker named no claimed run');
    await client.connect(new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: memberHeaders({ token: membership.token, projectId: PROJECT }), signal: stopping.signal },
    }));
    console.log(JSON.stringify(await verifyWorkerOutcome(client, PROJECT, runId)));
  } finally {
    for (const signal of STOP_SIGNALS) process.removeListener(signal, stop);
    clearTimeout(timeout);
    stopping.abort();
    try { await client.close(); } finally { rmSync(runRoot, { recursive: true, force: true }); }
  }
}
