/**
 * Shared fixture helpers for test suites that seed a session + batches.
 *
 * Intended to replace the repeated pattern:
 *
 *   const now = () => Math.floor(Date.now() / 1000);
 *   beforeAll(() => setupTestDb());
 *   afterAll(teardownTestDb);
 *   beforeEach(() => {
 *     cleanTestDb();
 *     upsertSession({ id: 's1', agent: 'opencode', started_at: now(), created_at: now(), status: 'active' });
 *   });
 */

import { upsertSession } from '@myco/db/queries/sessions.js';

/** Seconds-granularity epoch clock — matches stored column precision. */
export const nowSec = (): number => Math.floor(Date.now() / 1000);

export interface SeedSessionOptions {
  id?: string;
  agent?: string;
  status?: 'active' | 'completed';
  startedAt?: number;
}

/**
 * Insert (or replace) a session row with sensible defaults. Returns the id
 * used, so callers can reference it without duplicating the literal.
 */
export function seedSession(options: SeedSessionOptions = {}): string {
  const id = options.id ?? 's-test';
  const startedAt = options.startedAt ?? nowSec();
  upsertSession({
    id,
    agent: options.agent ?? 'claude-code',
    started_at: startedAt,
    created_at: startedAt,
    status: options.status ?? 'active',
  });
  return id;
}
