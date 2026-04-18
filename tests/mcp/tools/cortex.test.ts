/**
 * Tests for myco_cortex tool handler.
 *
 * Covers the four op discriminators: get / refresh / build_prompt /
 * get_prompt_result. Each mirror a /api/cortex/* HTTP endpoint — these
 * tests only verify the MCP adapter layer forwards inputs correctly.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleMycoCortex } from '@myco/mcp/tools/cortex.js';
import type { DaemonClient } from '@myco/hooks/client.js';

function mockClient(data: unknown = null, ok = true): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok, data }),
    post: vi.fn().mockResolvedValue({ ok, data }),
    delete: vi.fn(),
    put: vi.fn(),
  } as unknown as DaemonClient;
}

describe('myco_cortex op: get', () => {
  it('reads the instructions snapshot from /api/cortex/instructions', async () => {
    const snapshot = {
      content: 'cortex instructions body',
      generatedAt: 1700000000,
      sourceRunId: 'run-1',
      enabled: true,
      stored: true,
    };
    const client = mockClient(snapshot);
    const result = await handleMycoCortex({ op: 'get' }, client);
    expect(client.get).toHaveBeenCalledWith('/api/cortex/instructions');
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(snapshot);
  });

  it('surfaces a failure when the daemon is unreachable', async () => {
    const client = mockClient(null, false);
    const result = await handleMycoCortex({ op: 'get' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('fetch_failed');
  });
});

describe('myco_cortex op: refresh', () => {
  it('POSTs to /api/cortex/instructions/refresh and returns the started status', async () => {
    const client = mockClient({ started: true, run_id: 'run-7' });
    const result = await handleMycoCortex({ op: 'refresh' }, client);
    expect(client.post).toHaveBeenCalledWith('/api/cortex/instructions/refresh', {});
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ started: true, run_id: 'run-7' });
  });
});

describe('myco_cortex op: build_prompt', () => {
  it('requires a goal', async () => {
    const client = mockClient({ started: true, runId: 'x' });
    const result = await handleMycoCortex({ op: 'build_prompt' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/goal/i);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('POSTs goal and symbiont to /api/cortex/prompt-builder', async () => {
    const client = mockClient({ started: true, runId: 'run-build-1' });
    const result = await handleMycoCortex(
      { op: 'build_prompt', goal: 'refactor X', symbiont: 'claude-code' },
      client,
    );
    expect(client.post).toHaveBeenCalledWith('/api/cortex/prompt-builder', {
      goal: 'refactor X',
      symbiont: 'claude-code',
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ runId: 'run-build-1' });
  });

  it('omits symbiont when not provided', async () => {
    const client = mockClient({ started: true, runId: 'run-1' });
    await handleMycoCortex({ op: 'build_prompt', goal: 'do a thing' }, client);
    expect(client.post).toHaveBeenCalledWith('/api/cortex/prompt-builder', {
      goal: 'do a thing',
    });
  });
});

describe('myco_cortex op: get_prompt_result', () => {
  it('requires run_id', async () => {
    const client = mockClient({});
    const result = await handleMycoCortex({ op: 'get_prompt_result' }, client);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/run_id/i);
    expect(client.get).not.toHaveBeenCalled();
  });

  it('GETs /api/cortex/prompt-builder/:runId', async () => {
    const payload = { runId: 'run-1', status: 'completed', prompt: 'built prompt', reports: [] };
    const client = mockClient(payload);
    const result = await handleMycoCortex(
      { op: 'get_prompt_result', run_id: 'run-1' },
      client,
    );
    expect(client.get).toHaveBeenCalledWith('/api/cortex/prompt-builder/run-1');
    expect(result.ok).toBe(true);
    expect(result.data).toEqual(payload);
  });

  it('returns a not-ready error when the daemon returns 404', async () => {
    const client = mockClient(null, false);
    const result = await handleMycoCortex(
      { op: 'get_prompt_result', run_id: 'missing' },
      client,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not_ready|not_found/);
  });
});
