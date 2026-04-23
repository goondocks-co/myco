import { describe, it, expect } from 'bun:test';
import { createMcpServerInstance } from '@myco-team-worker/mcp/server';

describe('createMcpServerInstance', () => {
  it('creates a server instance', () => {
    // Create a minimal fake env
    const fakeEnv = {
      MYCO_TEAM_DB: {} as D1Database,
      MYCO_TEAM_VECTORS: {} as VectorizeIndex,
      AI: {} as Ai,
      MYCO_TEAM_API_KEY: 'test-key',
      SYNC_PROTOCOL_VERSION: '1',
    };
    const server = createMcpServerInstance(fakeEnv as never);
    expect(server).toBeDefined();
  });
});
