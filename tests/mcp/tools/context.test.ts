/**
 * Tests for myco_context tool handler.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { registerCurator } from '@myco/db/queries/curators.js';
import { handleMycoContext } from '@myco/mcp/tools/context.js';

const epochNow = () => Math.floor(Date.now() / 1000);

async function insertExtract(curatorId: string, tier: number, content: string): Promise<void> {
  const db = getDatabase();
  const now = epochNow();
  await db.query(
    `INSERT INTO digest_extracts (curator_id, tier, content, generated_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (curator_id, tier) DO UPDATE SET content = EXCLUDED.content, generated_at = EXCLUDED.generated_at`,
    [curatorId, tier, content, now],
  );
}

describe('myco_context', () => {
  beforeEach(async () => {
    const db = await initDatabase();
    await createSchema(db);

    const now = epochNow();
    await registerCurator({
      id: 'digest-curator', name: 'Digest', created_at: now,
    });
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it('returns extract for requested tier', async () => {
    await insertExtract('digest-curator', 3000, 'Project synthesis at 3000 tokens.');

    const result = await handleMycoContext({ tier: 3000 });

    expect(result.tier).toBe(3000);
    expect(result.fallback).toBe(false);
    expect(result.content).toBe('Project synthesis at 3000 tokens.');
  });

  it('falls back to nearest tier when requested unavailable', async () => {
    await insertExtract('digest-curator', 1500, 'Executive briefing.');
    await insertExtract('digest-curator', 5000, 'Deep onboarding.');

    const result = await handleMycoContext({ tier: 3000 });

    // 1500 is distance 1500, 5000 is distance 2000 — should pick 1500
    expect(result.tier).toBe(1500);
    expect(result.fallback).toBe(true);
    expect(result.content).toBe('Executive briefing.');
  });

  it('returns not-ready message when no extracts exist', async () => {
    const result = await handleMycoContext({ tier: 3000 });

    expect(result.tier).toBe(3000);
    expect(result.fallback).toBe(false);
    expect(result.content).toContain('not yet available');
  });

  it('defaults to tier 3000 when no tier specified', async () => {
    await insertExtract('digest-curator', 3000, 'Default tier content.');

    const result = await handleMycoContext({});

    expect(result.tier).toBe(3000);
    expect(result.content).toBe('Default tier content.');
  });
});
