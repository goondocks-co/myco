import { afterAll, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootCloudflare, stopCloudflareRuntime } from './targets/cloudflare.ts';
import { PARITY_WORKER_HEADER, withParityRequests } from './requests.ts';

const IDLE_BOUNDARY_MS = 5000;
const LANES = 64;
const ROUNDS = 8;
const LANE_OFFSET_MS = 3;
afterAll(stopCloudflareRuntime);

test.skipIf(process.env.MYCO_PARITY_STRESS !== '1')('Cloudflare transport: five-second connection boundary under CPU load', async () => {
  const target = await bootCloudflare();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-parity-cpu-'));
  const threads = Math.max(1, os.availableParallelism() - 2);
  const stress = Bun.spawn(['node', '-e', `
    const { Worker } = require('node:worker_threads');
    for (let i = 0; i < ${threads}; i++) new Worker('for (;;) Math.sqrt(Math.random())', { eval: true });
  `], { cwd: root, stdout: 'ignore', stderr: 'inherit' });
  const stop = () => { stress.kill(); };
  process.on('exit', stop);
  try {
    await withParityRequests([target], async () => {
      const start = performance.now();
      for (let round = 0; round < ROUNDS; round++) {
        const statuses = await Promise.all(Array.from({ length: LANES }, async (_, lane) => {
          await Bun.sleep(Math.max(0, start + round * IDLE_BOUNDARY_MS + lane * LANE_OFFSET_MS - performance.now()));
          const response = await fetch(`${target.url}/health`, { method: 'POST', body: '{}' });
          const body = await response.text();
          expect(response.status).toBe(401);
          expect(body.length).toBeGreaterThan(0);
          expect(response.headers.get(PARITY_WORKER_HEADER)).toBeString();
          return response.status;
        }));
        console.info(`cloudflare transport stress: round ${round + 1}/${ROUNDS}, ${statuses.length} Worker responses`);
      }
      await target.sql('ALTER TABLE members RENAME TO diagnostic_members');
      const expectedFailure = spyOn(console, 'error').mockImplementation(() => {});
      try {
        const response = await fetch(`${target.url}/api/settings`, { headers: target.ownerHeaders() });
        const id = response.headers.get(PARITY_WORKER_HEADER);
        expect(response.status).toBe(503);
        expect(await response.text()).toBe(JSON.stringify({ error: 'unavailable' }));
        expect(id).toBeString();
        expect(target.runtime!().tail).toContain('parity_handled_exception');
        expect(target.runtime!().tail).toContain('no such table: members');
        expect(target.runtime!().tail).toContain(id!);
        expect(expectedFailure).toHaveBeenCalledTimes(1);
      } finally { expectedFailure.mockRestore(); }
    });
  } finally {
    stop();
    await stress.exited;
    process.removeListener('exit', stop);
    fs.rmSync(root, { recursive: true, force: true });
    try { await target.stop(); }
    finally { await stopCloudflareRuntime(); }
  }
}, 240_000);
