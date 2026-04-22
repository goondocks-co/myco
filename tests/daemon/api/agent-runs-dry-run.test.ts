/**
 * Tests for the dry-run + write-intents additions to the agent-runs API.
 *
 * We stub out `runAgent` (dynamic-imported inside handleRun) so the body
 * fields can be verified without spinning up the real executor.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertWriteIntent } from '@myco/db/queries/write-intents.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { createAgentRunHandlers } from '@myco/daemon/api/agent-runs';
import type { RouteRequest } from '@myco/daemon/router';

const epochNow = () => Math.floor(Date.now() / 1000);

// Capture runAgent invocation options so we can verify pass-through.
const runAgentSpy = vi.fn(async () => ({ runId: 'stub', status: 'completed' as const }));
vi.mock('@myco/agent/executor.js', () => ({
  runAgent: (...args: unknown[]) => runAgentSpy(...args),
}));

// Avoid hitting the config loader (the handler guards on a configured
// provider); swap in a stub that always reports one is available.
vi.mock('@myco/config/loader.js', () => ({
  loadMergedConfig: () => ({ agent: { tasks: {} } }),
}));
vi.mock('@myco/agent/config-resolver.js', () => ({
  hasConfiguredProvider: () => true,
}));

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return { params: {}, query: {}, body: undefined, pathname: '/', ...overrides } as RouteRequest;
}

function makeHandlers() {
  const logger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  };
  return createAgentRunHandlers({
    vaultDir: '/tmp/fake-vault',
    embeddingManager: {} as never,
    logger: logger as never,
  });
}

describe('agent-runs API dry-run + write-intents', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    runAgentSpy.mockClear();
    registerAgent({ id: 'myco-agent', name: 'Test', created_at: epochNow() });
  });

  describe('handleRun — dry-run body plumbing', () => {
    it('forwards dryRun into runAgent options', async () => {
      const { handleRun } = makeHandlers();
      await handleRun(makeRequest({
        body: {
          task: 'vault-evolve',
          instruction: 'do the thing',
          agentId: 'myco-agent',
          dryRun: true,
        },
      }));

      expect(runAgentSpy).toHaveBeenCalledTimes(1);
      const [, opts] = runAgentSpy.mock.calls[0] as [string, { dryRun?: boolean }];
      expect(opts.dryRun).toBe(true);
    });

    it('defaults dryRun to undefined when omitted', async () => {
      const { handleRun } = makeHandlers();
      await handleRun(makeRequest({
        body: { task: 'vault-evolve', instruction: 'go', agentId: 'myco-agent' },
      }));
      const [, opts] = runAgentSpy.mock.calls[0] as [string, { dryRun?: boolean }];
      expect(opts.dryRun).toBeUndefined();
    });

    it('forwards executionOverrides (top-level + phases) into runAgent', async () => {
      const { handleRun } = makeHandlers();
      await handleRun(makeRequest({
        body: {
          task: 'vault-evolve',
          instruction: 'go',
          agentId: 'myco-agent',
          executionOverrides: {
            runtime: 'claude-sdk',
            reasoningLevel: 'high',
            model: 'claude-opus-4-6',
            phases: {
              extract: { reasoningLevel: 'low' },
              digest: { model: 'claude-haiku-4-5' },
            },
          },
        },
      }));
      const [, opts] = runAgentSpy.mock.calls[0] as [
        string,
        { executionOverrides?: Record<string, unknown> },
      ];
      expect(opts.executionOverrides).toEqual({
        runtime: 'claude-sdk',
        reasoningLevel: 'high',
        model: 'claude-opus-4-6',
        phases: {
          extract: { reasoningLevel: 'low' },
          digest: { model: 'claude-haiku-4-5' },
        },
      });
    });

    it('rejects invalid reasoningLevel in executionOverrides with a parse error', async () => {
      const { handleRun } = makeHandlers();
      await expect(
        handleRun(makeRequest({
          body: {
            task: 'vault-evolve',
            instruction: 'go',
            agentId: 'myco-agent',
            executionOverrides: { reasoningLevel: 'medium' },
          },
        })),
      ).rejects.toThrow();
    });
  });

  describe('handleResumeRun — dry-run preservation', () => {
    it('preserves dryRun=true when resuming a resumable failed run', async () => {
      insertRun({
        id: 'run-resume-dry',
        agent_id: 'myco-agent',
        status: 'failed',
        resumable: 1,
        dryRun: true,
        task: 'skill-evolve',
        instruction: 'resume this run',
      });

      const { handleResumeRun } = makeHandlers();
      const res = await handleResumeRun(makeRequest({
        params: { id: 'run-resume-dry' },
        body: {},
      }));

      expect((res.body as { ok: boolean }).ok).toBe(true);
      expect(runAgentSpy).toHaveBeenCalledTimes(1);
      const [, opts] = runAgentSpy.mock.calls[0] as [string, { dryRun?: boolean; resumeRunId?: string }];
      expect(opts.resumeRunId).toBe('run-resume-dry');
      expect(opts.dryRun).toBe(true);
    });
  });

  describe('handleGetRun — serializes reasoning_level + execution_overrides', () => {
    it('surfaces reasoning_level and parsed execution_overrides from the row', async () => {
      insertRun({
        id: 'run-overrides',
        agent_id: 'myco-agent',
        reasoningLevel: 'high',
        executionOverrides: {
          runtime: 'claude-sdk',
          reasoningLevel: 'high',
          phases: { extract: { reasoningLevel: 'low' } },
        },
      });

      const { handleGetRun } = makeHandlers();
      const res = await handleGetRun(makeRequest({ params: { id: 'run-overrides' } }));

      const body = res.body as { run: {
        reasoning_level: string | null;
        execution_overrides: Record<string, unknown> | null;
      } };
      expect(body.run.reasoning_level).toBe('high');
      expect(body.run.execution_overrides).toEqual({
        runtime: 'claude-sdk',
        reasoningLevel: 'high',
        phases: { extract: { reasoningLevel: 'low' } },
      });
    });

    it('returns null values when the run row has no overrides', async () => {
      insertRun({ id: 'run-plain', agent_id: 'myco-agent' });
      const { handleGetRun } = makeHandlers();
      const res = await handleGetRun(makeRequest({ params: { id: 'run-plain' } }));
      const body = res.body as { run: { reasoning_level: null; execution_overrides: null } };
      expect(body.run.reasoning_level).toBeNull();
      expect(body.run.execution_overrides).toBeNull();
    });
  });

  describe('handleGetRunWriteIntents', () => {
    it('returns intents for the run with parsed tool_input / synthetic_output', async () => {
      insertRun({ id: 'run-intents', agent_id: 'myco-agent', dryRun: true });
      insertWriteIntent({
        runId: 'run-intents',
        toolName: 'vault_create_spore',
        toolInput: JSON.stringify({ content: 'hello' }),
        syntheticOutput: JSON.stringify({ id: 'stub-1' }),
        stubId: 'stub-1',
      });
      insertWriteIntent({
        runId: 'run-intents',
        phaseId: 'draft',
        toolName: 'vault_write_skill',
        toolInput: JSON.stringify({ name: 'foo' }),
        syntheticOutput: JSON.stringify({ path: '/fake' }),
      });

      const { handleGetRunWriteIntents } = makeHandlers();
      const res = await handleGetRunWriteIntents(makeRequest({ params: { id: 'run-intents' } }));

      const body = res.body as { intents: unknown[]; count: number };
      expect(body.count).toBe(2);
      expect(body.intents).toHaveLength(2);
      const first = body.intents[0] as Record<string, unknown>;
      expect(first.tool_name).toBe('vault_create_spore');
      expect(first.tool_input).toEqual({ content: 'hello' });
      expect(first.synthetic_output).toEqual({ id: 'stub-1' });
    });

    it('returns an empty list for a run with no intents', async () => {
      insertRun({ id: 'run-empty', agent_id: 'myco-agent' });
      const { handleGetRunWriteIntents } = makeHandlers();
      const res = await handleGetRunWriteIntents(makeRequest({ params: { id: 'run-empty' } }));
      expect((res.body as { count: number }).count).toBe(0);
    });
  });
});
