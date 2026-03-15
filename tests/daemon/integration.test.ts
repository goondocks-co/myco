import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DaemonServer } from '@myco/daemon/server';
import { SessionRegistry } from '@myco/daemon/lifecycle';
import { BatchManager } from '@myco/daemon/batch';
import { DaemonLogger } from '@myco/daemon/logger';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Daemon Integration', () => {
  let vaultDir: string;
  let logger: DaemonLogger;
  let server: DaemonServer;

  beforeEach(async () => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-integ-'));
    fs.mkdirSync(path.join(vaultDir, 'logs'), { recursive: true });
    logger = new DaemonLogger(path.join(vaultDir, 'logs'));
    server = new DaemonServer({ vaultDir, logger });

    const batchManager = new BatchManager(() => {});
    const registry = new SessionRegistry({ gracePeriod: 60, onEmpty: () => {} });

    server.registerRoute('POST', '/sessions/register', async (body: any) => {
      registry.register(body.session_id); return { ok: true };
    });
    server.registerRoute('POST', '/sessions/unregister', async (body: any) => {
      registry.unregister(body.session_id); return { ok: true };
    });
    server.registerRoute('POST', '/events', async (body: any) => {
      batchManager.addEvent({ ...body, timestamp: new Date().toISOString() }); return { ok: true };
    });
    server.registerRoute('POST', '/events/stop', async (body: any) => {
      batchManager.finalize(body.session_id); return { ok: true };
    });
    server.registerRoute('POST', '/context', async () => ({ text: '' }));

    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    logger.close();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('full lifecycle: register → events → stop → unregister', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const post = (url: string, body: unknown) =>
      fetch(`${base}${url}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json());

    expect((await post('/sessions/register', { session_id: 't1' })).ok).toBe(true);
    expect((await post('/events', { type: 'user_prompt', prompt: 'Hi', session_id: 't1' })).ok).toBe(true);
    expect((await post('/events', { type: 'tool_use', tool_name: 'Read', session_id: 't1' })).ok).toBe(true);
    expect((await post('/events/stop', { session_id: 't1' })).ok).toBe(true);
    expect((await post('/sessions/unregister', { session_id: 't1' })).ok).toBe(true);

    const health = await fetch(`${base}/health`).then((r) => r.json());
    expect(health.myco).toBe(true);
  });
});
