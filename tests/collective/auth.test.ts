import { describe, it, expect } from 'bun:test';
import {
  ADMIN_TOKEN_KEY,
  MCP_TOKEN_KEY,
  WORKER_TOKEN_KEY,
  ensureBootstrapTokens,
  rotateTokens,
  tokenHash,
} from '../../packages/myco-collective/worker/src/auth.js';

function createFakeKV() {
  const store = new Map<string, string>();
  return {
    store,
    kv: {
      async get(key: string): Promise<string | null> {
        return store.get(key) ?? null;
      },
      async put(key: string, value: string): Promise<void> {
        store.set(key, value);
      },
    } as unknown as KVNamespace,
  };
}

describe('collective auth helpers', () => {
  it('seeds bootstrap tokens only when missing', async () => {
    const fake = createFakeKV();

    const first = await ensureBootstrapTokens(fake.kv, 'admin-seed', 'mcp-seed');
    const second = await ensureBootstrapTokens(fake.kv, 'ignored-admin', 'ignored-mcp');

    expect(first.adminToken).toBe('admin-seed');
    expect(first.mcpToken).toBe('mcp-seed');
    expect(first.workerToken).toMatch(/^[0-9a-f]{48}$/);
    expect(second.adminToken).toBe('admin-seed');
    expect(second.mcpToken).toBe('mcp-seed');
    expect(second.workerToken).toBe(first.workerToken);
    expect(fake.store.get(ADMIN_TOKEN_KEY)).toBe('admin-seed');
    expect(fake.store.get(MCP_TOKEN_KEY)).toBe('mcp-seed');
    expect(fake.store.get(WORKER_TOKEN_KEY)).toBe(first.workerToken);
  });

  it('rotates only the requested token family', async () => {
    const fake = createFakeKV();
    fake.store.set(ADMIN_TOKEN_KEY, 'admin-old');
    fake.store.set(MCP_TOKEN_KEY, 'mcp-old');
    fake.store.set(WORKER_TOKEN_KEY, 'worker-old');

    const rotatedAdmin = await rotateTokens(fake.kv, 'admin');
    expect(rotatedAdmin.adminToken).toBeTruthy();
    expect(rotatedAdmin.adminToken).not.toBe('admin-old');
    expect(rotatedAdmin.mcpToken).toBeNull();
    expect(fake.store.get(MCP_TOKEN_KEY)).toBe('mcp-old');
    expect(fake.store.get(WORKER_TOKEN_KEY)).toBe('worker-old');

    const rotatedAll = await rotateTokens(fake.kv, 'all');
    expect(rotatedAll.adminToken).toBeTruthy();
    expect(rotatedAll.mcpToken).toBeTruthy();
    expect(fake.store.get(ADMIN_TOKEN_KEY)).toBe(rotatedAll.adminToken);
    expect(fake.store.get(MCP_TOKEN_KEY)).toBe(rotatedAll.mcpToken);
    expect(fake.store.get(WORKER_TOKEN_KEY)).toBe('worker-old');
  });

  it('hashes tokens consistently', () => {
    expect(tokenHash('collective-token')).toMatch(/^[0-9a-f]{8}$/);
    expect(tokenHash('collective-token')).toBe(tokenHash('collective-token'));
    expect(tokenHash(null)).toBeNull();
  });
});
