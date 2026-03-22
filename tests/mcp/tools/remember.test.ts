/**
 * Tests for myco_remember tool handler.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { getSpore } from '@myco/db/queries/spores.js';
import { handleMycoRemember } from '@myco/mcp/tools/remember.js';

describe('myco_remember', () => {
  beforeEach(async () => {
    const db = await initDatabase();
    await createSchema(db);
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it('creates a spore and returns its ID', async () => {
    const result = await handleMycoRemember({
      content: 'CORS proxy strips auth headers',
      type: 'gotcha',
      tags: ['cors', 'auth'],
    });

    expect(result.id).toContain('gotcha-');
    expect(result.observation_type).toBe('gotcha');
    expect(result.status).toBe('active');
    expect(typeof result.created_at).toBe('number');
  });

  it('persists spore in database', async () => {
    const result = await handleMycoRemember({
      content: 'Decision: use RS256',
      type: 'decision',
    });

    const spore = await getSpore(result.id);
    expect(spore).toBeTruthy();
    expect(spore!.content).toBe('Decision: use RS256');
    expect(spore!.observation_type).toBe('decision');
  });

  it('defaults observation_type to discovery', async () => {
    const result = await handleMycoRemember({
      content: 'Something interesting',
    });

    expect(result.observation_type).toBe('discovery');
  });

  it('stores tags as comma-separated string', async () => {
    const result = await handleMycoRemember({
      content: 'Tagged spore',
      type: 'gotcha',
      tags: ['auth', 'cors'],
    });

    const spore = await getSpore(result.id);
    expect(spore!.tags).toBe('auth, cors');
  });
});
