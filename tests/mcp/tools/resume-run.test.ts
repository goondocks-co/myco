/**
 * Tests for myco_resume_run tool handler.
 *
 * Mirrors POST /api/agent/runs/:id/resume. The MCP-adapter-layer tests cover
 * input validation + error surfacing; the integration suite below drives the
 * handler through a real DaemonServer + real DaemonClient so the 404
 * (run-not-found) and 400 (not-resumable) branches of handleResumeRun are
 * actually exercised end-to-end — matching the Bundle D plans-delete
 * integration pattern.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { handleMycoResumeRun } from '@myco/mcp/tools/resume-run.js';
import { DaemonClient } from '@myco/hooks/client.js';
import { DaemonServer } from '@myco/daemon/server.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { createAgentRunHandlers } from '@myco/daemon/api/agent-runs.js';
import { insertRun, updateRunStatus } from '@myco/db/queries/runs.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';

function mockClient(data: unknown = null, ok = true): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok, data }),
    post: vi.fn().mockResolvedValue({ ok, data }),
    put: vi.fn(),
    delete: vi.fn(),
  } as unknown as DaemonClient;
}

describe('myco_resume_run (adapter layer)', () => {
  it('requires id', async () => {
    const client = mockClient({});
    const result = await handleMycoResumeRun({ id: '' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/id/);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('POSTs /api/agent/runs/:id/resume with an empty body by default', async () => {
    const client = mockClient({ ok: true, message: 'Agent resume started', runId: 'run-1' });
    const result = await handleMycoResumeRun({ id: 'run-1' }, client);
    expect(client.post).toHaveBeenCalledWith('/api/agent/runs/run-1/resume', {});
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ ok: true, message: 'Agent resume started', runId: 'run-1' });
  });

  it('forwards mode when provided', async () => {
    const client = mockClient({ ok: true, message: 'Agent resume started', runId: 'run-1' });
    await handleMycoResumeRun({ id: 'run-1', mode: 'scheduled' }, client);
    expect(client.post).toHaveBeenCalledWith('/api/agent/runs/run-1/resume', { mode: 'scheduled' });
  });

  it('URL-encodes the id path segment', async () => {
    const client = mockClient({ ok: true, runId: 'x' });
    await handleMycoResumeRun({ id: 'run/with slash' }, client);
    expect(client.post).toHaveBeenCalledWith('/api/agent/runs/run%2Fwith%20slash/resume', {});
  });

  it('surfaces the daemon error body on non-ok', async () => {
    const client = mockClient({ error: 'Run is not resumable' }, false);
    const result = await handleMycoResumeRun({ id: 'run-1' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Run is not resumable');
  });

  it('falls back to resume_failed when the daemon is unreachable (no body)', async () => {
    const client = mockClient(undefined, false);
    const result = await handleMycoResumeRun({ id: 'run-1' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('resume_failed');
  });
});

/**
 * Integration suite — drives handleMycoResumeRun through the real DaemonClient
 * and a real in-process DaemonServer so the 404 + 400 branches of
 * handleResumeRun actually run. The happy-path 202 branch fires
 * runAgent() as a background import, which we deliberately do NOT exercise
 * here (the agent executor has broad side effects). The adapter-layer suite
 * above covers happy-path shape.
 */
describe('myco_resume_run (integration against real HTTP router)', () => {
  let vaultDir: string;
  let server: DaemonServer;
  let logger: DaemonLogger;
  let client: DaemonClient;
  let now: number;

  beforeAll(async () => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-resume-run-'));
    fs.mkdirSync(path.join(vaultDir, 'logs'), { recursive: true });
    logger = new DaemonLogger(path.join(vaultDir, 'logs'));
    setupTestDb();

    server = new DaemonServer({ vaultDir, logger });

    const embeddingManager = {
      onContentWritten: vi.fn(),
      onStatusChanged: vi.fn(),
      onRemoved: vi.fn(),
    } as never;
    const runHandlers = createAgentRunHandlers({
      vaultDir,
      embeddingManager,
      logger,
    });
    server.registerRoute('POST', '/api/agent/runs/:id/resume', runHandlers.handleResumeRun);

    await server.start();

    fs.writeFileSync(
      path.join(vaultDir, 'daemon.json'),
      JSON.stringify({ pid: process.pid, port: server.port }),
    );

    client = new DaemonClient(vaultDir);
  });

  afterAll(async () => {
    await server.stop();
    logger.close();
    teardownTestDb();
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    cleanTestDb();
    now = Math.floor(Date.now() / 1000);
    registerAgent({ id: 'myco-agent', name: 'Test', created_at: now });
  });

  it('returns a 404-shaped error when the run does not exist', async () => {
    const result = await handleMycoResumeRun({ id: 'missing-run' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Run not found/);
  });

  it('returns a 400-shaped error when the run is not resumable', async () => {
    insertRun({
      id: 'run-not-resumable',
      agent_id: 'myco-agent',
      status: 'completed',
      started_at: now,
      // resumable defaults to 0 via insertRun.
    });

    const result = await handleMycoResumeRun({ id: 'run-not-resumable' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not resumable/);
  });

  it('returns a 400-shaped error when the run is resumable but still running', async () => {
    // resumable=1 but status='running' — the route requires status='failed'.
    insertRun({
      id: 'run-still-running',
      agent_id: 'myco-agent',
      status: 'running',
      resumable: 1,
      started_at: now,
    });

    const result = await handleMycoResumeRun({ id: 'run-still-running' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not resumable/);
  });

  // Pre-seed a row that looks resumable so the validation gate passes.
  // We still don't exercise the background runAgent — the route returns
  // {ok:true, message, runId} before awaiting it, and the import is lazy
  // so ESM loads the executor on first call. The unresolved background
  // promise is fine for a unit-style test boundary.
  it('accepts a properly-resumable run (202-equivalent body)', async () => {
    insertRun({
      id: 'run-resumable',
      agent_id: 'myco-agent',
      status: 'running',
      resumable: 1,
      started_at: now,
    });
    updateRunStatus('run-resumable', 'failed', { error: 'ran out of turns' });

    const result = await handleMycoResumeRun({ id: 'run-resumable' }, client);
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      ok: true,
      message: 'Agent resume started',
      runId: 'run-resumable',
    });
  });
});
