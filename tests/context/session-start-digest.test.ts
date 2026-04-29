/**
 * Tests for shouldInjectSessionStartDigest + getSessionStartDigestPayload.
 *
 * Covers:
 *   (a) returns the extract at the configured tier when present
 *   (b) falls back to DIGEST_FALLBACK_TIER when the preferred tier is missing
 *   (c) returns { content: '', tier: null } when both are missing
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import {
  getSessionStartDigestPayload,
  shouldInjectSessionStartDigest,
} from '@myco/context/session-start-digest.js';
import { DEFAULT_AGENT_ID, DIGEST_FALLBACK_TIER } from '@myco/constants.js';
import { upsertDigestExtract } from '@myco/db/queries/digest-extracts.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { MycoConfigSchema } from '@myco/config/schema.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';

describe('session-start-digest', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({
      id: DEFAULT_AGENT_ID,
      name: 'myco-agent',
      created_at: Math.floor(Date.now() / 1000),
    });
  });

  const digest = MycoConfigSchema.parse({
    version: 3,
    cortex: { digest: { inject_on_session_start: true } },
  }).cortex.digest;

  it('shouldInjectSessionStartDigest honors the config toggle', () => {
    expect(shouldInjectSessionStartDigest(digest)).toBe(true);
    const disabled = MycoConfigSchema.parse({
      version: 3,
      cortex: { digest: { inject_on_session_start: false } },
    }).cortex.digest;
    expect(shouldInjectSessionStartDigest(disabled)).toBe(false);
  });

  it('returns the extract at the configured tier when present', () => {
    const now = Math.floor(Date.now() / 1000);
    upsertDigestExtract({
      agent_id: DEFAULT_AGENT_ID,
      tier: digest.tier,
      content: 'Preferred-tier digest body',
      generated_at: now,
    });

    const payload = getSessionStartDigestPayload(digest);
    expect(payload.content).toBe('Preferred-tier digest body');
    expect(payload.tier).toBe(digest.tier);
  });

  it('falls back to DIGEST_FALLBACK_TIER when the preferred tier is missing', () => {
    const now = Math.floor(Date.now() / 1000);
    upsertDigestExtract({
      agent_id: DEFAULT_AGENT_ID,
      tier: DIGEST_FALLBACK_TIER,
      content: 'Fallback-tier digest body',
      generated_at: now,
    });

    const payload = getSessionStartDigestPayload(digest);
    expect(payload.content).toBe('Fallback-tier digest body');
    expect(payload.tier).toBe(DIGEST_FALLBACK_TIER);
  });

  it('returns empty payload when both the preferred and fallback tiers are missing', () => {
    const payload = getSessionStartDigestPayload(digest);
    expect(payload).toEqual({ content: '', tier: null });
  });
});
