/**
 * Tests for myco_search tool handler.
 *
 * Search requires an embedding provider. Without one configured,
 * the handler returns empty results gracefully. These tests verify
 * the graceful degradation path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { handleMycoSearch } from '@myco/mcp/tools/search.js';

describe('myco_search', () => {
  const originalVaultDir = process.env.MYCO_VAULT_DIR;

  beforeEach(async () => {
    // Point to a nonexistent vault so loadConfig fails fast (no network calls)
    process.env.MYCO_VAULT_DIR = '/tmp/myco-search-test-nonexistent';
    const db = await initDatabase();
    await createSchema(db);
  });

  afterEach(async () => {
    if (originalVaultDir !== undefined) {
      process.env.MYCO_VAULT_DIR = originalVaultDir;
    } else {
      delete process.env.MYCO_VAULT_DIR;
    }
    await closeDatabase();
  });

  it('returns empty results when no embedding provider available', async () => {
    const results = await handleMycoSearch({ query: 'auth middleware' });
    expect(results).toEqual([]);
  });

  it('returns empty results with type filter', async () => {
    const results = await handleMycoSearch({ query: 'auth', type: 'spore' });
    expect(results).toEqual([]);
  });

  it('accepts limit parameter gracefully', async () => {
    const results = await handleMycoSearch({ query: 'test', limit: 5 });
    expect(results).toEqual([]);
  });
});
