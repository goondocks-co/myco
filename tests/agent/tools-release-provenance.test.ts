import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { createVaultTools } from '@myco/agent/tools.js';
import { upsertReleaseState } from '@myco/db/queries/release-provenance.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk';
import { TEST_REQUEST_CONTEXT } from '../helpers/request-context.js';

const TEST_AGENT_ID = 'test-agent-release';
const TEST_RUN_ID = 'run-release-001';

function findTool(tools: ReturnType<typeof createVaultTools>, name: string) {
  const t = tools.find((tool) => tool.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return t as SdkMcpToolDefinition<any>;
}

function parseResult(result: { content: Array<{ type: string; text: string }> }): unknown {
  return JSON.parse(result.content[0].text);
}

describe('vault release provenance tools', () => {
  beforeAll(() => { setupTestDb(); });
  beforeEach(() => { cleanTestDb(); });
  afterAll(() => { teardownTestDb(); });

  it('exposes vault_release_state as a read-only exact lookup', async () => {
    upsertSession({
      id: 'session-release-tool',
      agent: 'codex',
      status: 'completed',
      started_at: 1_800_000_000,
      created_at: 1_800_000_000,
      machine_id: 'test-machine',
    });
    upsertReleaseState({
      namespace: 'sessions',
      record_id: 'session-release-tool',
      source_session_id: 'session-release-tool',
      state: 'released',
      confidence: 'high',
      basis_kind: 'git_ancestry',
      basis_ref: 'prod',
      basis_sha: 'a'.repeat(40),
      reason: 'Captured HEAD is in production ref',
      checked_at: 1_800_000_000,
      created_at: 1_800_000_000,
    });

    const tools = createVaultTools(TEST_AGENT_ID, TEST_RUN_ID, { requestContext: TEST_REQUEST_CONTEXT });
    const tool = findTool(tools, 'vault_release_state');

    expect(tool.annotations?.readOnlyHint).toBe(true);
    const result = parseResult(await tool.handler({
      namespace: 'sessions',
      record_id: 'session-release-tool',
    }));

    expect(result).toMatchObject({
      found: true,
      release_state: {
        namespace: 'sessions',
        record_id: 'session-release-tool',
        state: 'released',
        confidence: 'high',
        basis_kind: 'git_ancestry',
      },
    });
  });
});
