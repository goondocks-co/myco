import { describe, it, expect } from 'vitest';
import {
  generateMcpToken,
  getMcpTokenHash,
  validateMcpToken,
  ensureMcpToken,
  rotateMcpToken,
  authenticateMcpRequest,
} from '@myco-team-worker/mcp/auth';

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

describe('generateMcpToken', () => {
  it('returns a non-empty string', () => {
    const token = generateMcpToken();
    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(0);
  });

  it('returns unique values on successive calls', () => {
    const a = generateMcpToken();
    const b = generateMcpToken();
    expect(a).not.toBe(b);
  });
});

describe('getMcpTokenHash', () => {
  it('returns an 8-character hex string', () => {
    const hash = getMcpTokenHash('test-token');
    expect(hash).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is deterministic', () => {
    const a = getMcpTokenHash('same-input');
    const b = getMcpTokenHash('same-input');
    expect(a).toBe(b);
  });

  it('returns different hashes for different inputs', () => {
    const a = getMcpTokenHash('input-one');
    const b = getMcpTokenHash('input-two');
    expect(a).not.toBe(b);
  });
});

describe('validateMcpToken', () => {
  it('returns true when token matches stored value', async () => {
    const fake = createFakeKV();
    fake.store.set('mcp_access_token', 'valid-token');

    const result = await validateMcpToken(fake.kv as never, 'valid-token');
    expect(result).toBe(true);
  });

  it('returns false when token does not match', async () => {
    const fake = createFakeKV();
    fake.store.set('mcp_access_token', 'valid-token');

    const result = await validateMcpToken(fake.kv as never, 'wrong-token');
    expect(result).toBe(false);
  });

  it('returns false when no token is stored', async () => {
    const fake = createFakeKV();

    const result = await validateMcpToken(fake.kv as never, 'any-token');
    expect(result).toBe(false);
  });
});

describe('ensureMcpToken', () => {
  it('generates and stores a token when none exists', async () => {
    const fake = createFakeKV();

    const token = await ensureMcpToken(fake.kv as never);
    expect(token).toBeTruthy();
    expect(fake.store.get('mcp_access_token')).toBe(token);
  });

  it('returns the existing token when one is already stored', async () => {
    const fake = createFakeKV();
    fake.store.set('mcp_access_token', 'existing-token');

    const token = await ensureMcpToken(fake.kv as never);
    expect(token).toBe('existing-token');
  });
});

describe('rotateMcpToken', () => {
  it('replaces the old token with a new one', async () => {
    const fake = createFakeKV();
    fake.store.set('mcp_access_token', 'old-token');

    const newToken = await rotateMcpToken(fake.kv as never);
    expect(newToken).not.toBe('old-token');
    expect(fake.store.get('mcp_access_token')).toBe(newToken);
  });
});

describe('authenticateMcpRequest', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const fake = createFakeKV();
    const request = new Request('https://example.com/mcp', {
      method: 'GET',
    });

    const response = await authenticateMcpRequest(request, fake.kv as never);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
    const body = await response!.json();
    expect(body).toEqual({ error: 'Missing Authorization header' });
  });

  it('returns 401 when token is invalid', async () => {
    const fake = createFakeKV();
    fake.store.set('mcp_access_token', 'valid-token');
    const request = new Request('https://example.com/mcp', {
      method: 'GET',
      headers: { Authorization: 'Bearer wrong-token' },
    });

    const response = await authenticateMcpRequest(request, fake.kv as never);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(401);
    const body = await response!.json();
    expect(body).toEqual({ error: 'Invalid MCP access token' });
  });

  it('returns null when token is valid', async () => {
    const fake = createFakeKV();
    fake.store.set('mcp_access_token', 'valid-token');
    const request = new Request('https://example.com/mcp', {
      method: 'GET',
      headers: { Authorization: 'Bearer valid-token' },
    });

    const response = await authenticateMcpRequest(request, fake.kv as never);
    expect(response).toBeNull();
  });
});
