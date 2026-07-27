import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { ensureSessionRowExists, ENSURE_SESSION_SOURCE } from '@myco/daemon/session-lifecycle.js';
import { insertSessionTombstone, SESSION_TOMBSTONE_SOURCE } from '@myco/db/queries/session-tombstones.js';
import { getDatabase } from '@myco/db/client.js';
import { getSession, upsertSession } from '@myco/db/queries/sessions.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

const nowSec = () => Math.floor(Date.now() / 1000);

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function tombstone(sessionId: string): void {
  insertSessionTombstone(getDatabase(), {
    sessionId,
    projectId: null,
    source: SESSION_TOMBSTONE_SOURCE.API_DELETE,
  });
}

describe('ensureSessionRowExists — tombstone gate', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  // RC-A: the defensive insert is for upstream gaps, not for deliberately
  // deleted sessions. A tombstoned id must not be passively materialized
  // by /context or any future defensive caller — that was a resurrection
  // path as a class.
  it('skips the defensive insert for a tombstoned id without throwing', () => {
    const sessionId = 'tombstoned-defensive-001';
    tombstone(sessionId);
    const logger = makeLogger();

    let created: boolean | undefined;
    expect(() => {
      created = ensureSessionRowExists({
        sessionId,
        machineId: 'local',
        logger: logger as never,
        source: ENSURE_SESSION_SOURCE.CONTEXT,
      });
    }).not.toThrow();

    expect(created).toBe(false);
    expect(getSession(sessionId, ALL_PROJECTS_SCOPE)).toBeNull();
    // The skip is expected behavior, not an upstream gap — no WARN noise.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('still recovers a genuinely missing (non-tombstoned) row', () => {
    const sessionId = 'missing-row-recovery-001';
    const logger = makeLogger();

    const created = ensureSessionRowExists({
      sessionId,
      agent: 'claude-code',
      machineId: 'local',
      logger: logger as never,
      source: ENSURE_SESSION_SOURCE.USER_PROMPT,
    });

    expect(created).toBe(true);
    expect(getSession(sessionId, ALL_PROJECTS_SCOPE)).not.toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('no-ops on an existing row even when a stale tombstone lingers (explicit re-register supersedes)', () => {
    const sessionId = 'reregistered-after-delete-001';
    tombstone(sessionId);
    // The supported same-id reload: /sessions/register recreated the row.
    upsertSession({ id: sessionId, agent: 'claude-code', status: 'active', started_at: nowSec(), created_at: nowSec(), machine_id: 'local' });
    const logger = makeLogger();

    const created = ensureSessionRowExists({
      sessionId,
      machineId: 'local',
      logger: logger as never,
      source: ENSURE_SESSION_SOURCE.TOOL_USE,
    });

    expect(created).toBe(false);
    expect(getSession(sessionId, ALL_PROJECTS_SCOPE)).not.toBeNull();
  });
});

describe('transcript path resolution', () => {
  it('is exported so any session-creating path can enrich a row', async () => {
    // Capture learns a transcript's location from the hook payload. An agent
    // that omits the field leaves the column null and mining never runs, even
    // though the manifest declares where that agent keeps transcripts.
    const mod = await import('@myco/daemon/session-lifecycle.js');
    expect(typeof mod.ensureTranscriptPath).toBe('function');
  });
});
