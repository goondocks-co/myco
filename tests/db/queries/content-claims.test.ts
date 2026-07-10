/**
 * Tests for the content claim system query layer (Team Host WS2).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import {
  insertContentClaim,
  getActiveContentClaim,
  getContentClaimById,
  listActiveContentClaims,
  updateContentClaimGeneration,
  releaseContentClaim,
  cancelActiveContentClaimForArtifact,
  markContentClaimPublished,
  expireStaleContentClaims,
  pruneTerminalContentClaims,
  getContentPublication,
  listContentPublications,
  upsertContentPublication,
  type ContentClaimInsert,
} from '@myco/db/queries/content-claims.js';
import { projectScope, ALL_PROJECTS_SCOPE, type GroveProjectId } from '@myco/grove/ids.js';

const epochNow = () => Math.floor(Date.now() / 1000);
const PROJECT_A = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PROJECT_B = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function makeClaim(overrides: Partial<ContentClaimInsert> = {}): ContentClaimInsert {
  const now = epochNow();
  return {
    artifactKind: 'skill',
    artifactId: 'skill-1',
    generation: 1,
    projectId: PROJECT_A,
    claimedBy: 'machine-a',
    claimedAt: now,
    expiresAt: now + 86400,
    machineId: 'machine-a',
    ...overrides,
  };
}

describe('content claim store', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: 'agent-test', name: 'Test Agent', created_at: epochNow() });
  });

  // ---------------------------------------------------------------------------
  // insertContentClaim — constraint-based INSERT
  // ---------------------------------------------------------------------------

  describe('insertContentClaim', () => {
    it('creates an active claim with a cclaim_<32hex> id', () => {
      const result = insertContentClaim(makeClaim());
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error('unreachable');
      expect(result.row.id).toMatch(/^cclaim_[0-9a-f]{32}$/);
      expect(result.row.state).toBe('active');
      expect(result.row.claimed_by).toBe('machine-a');
      expect(result.row.generation).toBe(1);
    });

    it('a second claim for the same artifact while active -> 409-shaped conflict with holder identity (order A-then-B)', () => {
      const first = insertContentClaim(makeClaim({ claimedBy: 'machine-a', machineId: 'machine-a' }));
      expect(first.ok).toBe(true);

      const second = insertContentClaim(makeClaim({ claimedBy: 'machine-b', machineId: 'machine-b' }));
      expect(second.ok).toBe(false);
      if (second.ok) throw new Error('unreachable');
      expect(second.holder).not.toBeNull();
      expect(second.holder?.claimed_by).toBe('machine-a');

      // Exactly one active row exists — the constraint, not double-bookkeeping.
      const active = listActiveContentClaims(projectScope(PROJECT_A as GroveProjectId));
      expect(active).toHaveLength(1);
      expect(active[0].claimed_by).toBe('machine-a');
    });

    it('a second claim for the same artifact while active -> conflict with holder identity (order B-then-A, symmetric)', () => {
      const first = insertContentClaim(makeClaim({ claimedBy: 'machine-b', machineId: 'machine-b' }));
      expect(first.ok).toBe(true);

      const second = insertContentClaim(makeClaim({ claimedBy: 'machine-a', machineId: 'machine-a' }));
      expect(second.ok).toBe(false);
      if (second.ok) throw new Error('unreachable');
      expect(second.holder?.claimed_by).toBe('machine-b');

      const active = listActiveContentClaims(projectScope(PROJECT_A as GroveProjectId));
      expect(active).toHaveLength(1);
      expect(active[0].claimed_by).toBe('machine-b');
    });

    it('a distinct artifact_id is unaffected by another artifact holding an active claim', () => {
      insertContentClaim(makeClaim({ artifactId: 'skill-1' }));
      const other = insertContentClaim(makeClaim({ artifactId: 'skill-2' }));
      expect(other.ok).toBe(true);
    });

    it('once the holding row transitions off active (released), a new active claim is free to insert', () => {
      const first = insertContentClaim(makeClaim());
      expect(first.ok).toBe(true);
      if (!first.ok) throw new Error('unreachable');
      releaseContentClaim(first.row.id, epochNow());

      const second = insertContentClaim(makeClaim({ claimedBy: 'machine-b', machineId: 'machine-b' }));
      expect(second.ok).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Scoped lookups
  // ---------------------------------------------------------------------------

  describe('getContentClaimById / getActiveContentClaim scoping', () => {
    it('getContentClaimById is scoped: a caller in a different project cannot address the row by id', () => {
      const created = insertContentClaim(makeClaim({ projectId: PROJECT_A }));
      if (!created.ok) throw new Error('unreachable');

      expect(getContentClaimById(created.row.id, projectScope(PROJECT_A as GroveProjectId))?.id).toBe(created.row.id);
      expect(getContentClaimById(created.row.id, projectScope(PROJECT_B as GroveProjectId))).toBeNull();
      expect(getContentClaimById(created.row.id, ALL_PROJECTS_SCOPE)?.id).toBe(created.row.id);
    });

    it('getActiveContentClaim finds the active row for an artifact, unscoped by project', () => {
      insertContentClaim(makeClaim({ artifactId: 'skill-x' }));
      const active = getActiveContentClaim('skill', 'skill-x');
      expect(active?.artifact_id).toBe('skill-x');
      expect(getActiveContentClaim('skill', 'skill-does-not-exist')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Refresh — holder-only UPDATE of generation, scoped to ONE row
  // ---------------------------------------------------------------------------

  describe('updateContentClaimGeneration (refresh)', () => {
    it('refresh only mutates the holder claim row, leaving a sibling claim untouched', () => {
      const a = insertContentClaim(makeClaim({ artifactId: 'skill-a', generation: 1 }));
      const b = insertContentClaim(makeClaim({ artifactId: 'skill-b', generation: 1, claimedBy: 'machine-b', machineId: 'machine-b' }));
      if (!a.ok || !b.ok) throw new Error('unreachable');

      const updated = updateContentClaimGeneration(a.row.id, 5);
      expect(updated?.generation).toBe(5);
      expect(updated?.id).toBe(a.row.id);

      // The sibling claim (different artifact) is untouched.
      const bAfter = getContentClaimById(b.row.id, ALL_PROJECTS_SCOPE);
      expect(bAfter?.generation).toBe(1);

      // Every other column on the refreshed row is unchanged.
      expect(updated?.state).toBe('active');
      expect(updated?.claimed_by).toBe(a.row.claimed_by);
      expect(updated?.claimed_at).toBe(a.row.claimed_at);
      expect(updated?.expires_at).toBe(a.row.expires_at);
    });

    it('refresh on a non-active claim is a no-op (returns null, row unchanged)', () => {
      const created = insertContentClaim(makeClaim());
      if (!created.ok) throw new Error('unreachable');
      releaseContentClaim(created.row.id, epochNow());

      const result = updateContentClaimGeneration(created.row.id, 99);
      expect(result).toBeNull();
      const after = getContentClaimById(created.row.id, ALL_PROJECTS_SCOPE);
      expect(after?.generation).toBe(1);
      expect(after?.state).toBe('released');
    });
  });

  // ---------------------------------------------------------------------------
  // Release / published transitions
  // ---------------------------------------------------------------------------

  describe('releaseContentClaim', () => {
    it('active -> released, and frees the unique index', () => {
      const created = insertContentClaim(makeClaim());
      if (!created.ok) throw new Error('unreachable');
      const released = releaseContentClaim(created.row.id, epochNow());
      expect(released?.state).toBe('released');
      expect(released?.released_at).not.toBeNull();
      expect(listActiveContentClaims(projectScope(PROJECT_A as GroveProjectId))).toHaveLength(0);
    });

    it('a second release attempt on an already-released row is a no-op', () => {
      const created = insertContentClaim(makeClaim());
      if (!created.ok) throw new Error('unreachable');
      releaseContentClaim(created.row.id, epochNow());
      const secondAttempt = releaseContentClaim(created.row.id, epochNow());
      expect(secondAttempt).toBeNull();
    });
  });

  describe('cancelActiveContentClaimForArtifact (delete-flow cancel, spec §5)', () => {
    it('cancels the active claim for the artifact — same active -> released transition as a voluntary release', () => {
      const created = insertContentClaim(makeClaim({ artifactId: 'skill-to-delete' }));
      if (!created.ok) throw new Error('unreachable');
      const at = epochNow();

      const cancelled = cancelActiveContentClaimForArtifact('skill', 'skill-to-delete', at);
      expect(cancelled?.id).toBe(created.row.id);
      expect(cancelled?.state).toBe('released');
      expect(cancelled?.released_at).toBe(at);
      expect(getActiveContentClaim('skill', 'skill-to-delete')).toBeNull();
    });

    it('is a no-op when the artifact has no active claim', () => {
      expect(cancelActiveContentClaimForArtifact('skill', 'never-claimed', epochNow())).toBeNull();
    });

    it('never touches a different artifact\'s active claim', () => {
      const other = insertContentClaim(makeClaim({ artifactId: 'skill-other', claimedBy: 'machine-b', machineId: 'machine-b' }));
      if (!other.ok) throw new Error('unreachable');

      expect(cancelActiveContentClaimForArtifact('skill', 'skill-does-not-exist', epochNow())).toBeNull();
      expect(getContentClaimById(other.row.id, ALL_PROJECTS_SCOPE)?.state).toBe('active');
    });
  });

  describe('markContentClaimPublished', () => {
    it('active -> published AND upserts the publication marker in one call', () => {
      const created = insertContentClaim(makeClaim({ generation: 3 }));
      if (!created.ok) throw new Error('unreachable');
      const result = markContentClaimPublished(created.row.id, {
        publishedAt: epochNow(),
        publishedBy: 'machine-a',
        machineId: 'machine-a',
      });
      expect(result?.claim.state).toBe('published');
      expect(result?.claim.published_at).not.toBeNull();
      expect(result?.publication).toMatchObject({
        artifact_kind: 'skill',
        artifact_id: 'skill-1',
        published_generation: 3,
        published_by: 'machine-a',
      });
      expect(getContentPublication('skill', 'skill-1')?.published_generation).toBe(3);
    });

    it('is atomic: a forced constraint failure on the marker upsert rolls back the claim transition', () => {
      const created = insertContentClaim(makeClaim());
      if (!created.ok) throw new Error('unreachable');

      // Force the second write (the content_publications upsert) to fail via
      // its NOT NULL constraint on machine_id. Both-or-neither: the claim
      // transition inside the same transaction must roll back with it.
      expect(() =>
        markContentClaimPublished(created.row.id, {
          publishedAt: epochNow(),
          publishedBy: 'machine-a',
          machineId: null as unknown as string,
        }),
      ).toThrow();

      expect(getContentClaimById(created.row.id, ALL_PROJECTS_SCOPE)?.state).toBe('active');
      expect(getContentPublication('skill', 'skill-1')).toBeNull();

      // Because the claim is still active, the holder CAN retry — the exact
      // recovery the unpaired two-statement version made impossible.
      const retry = markContentClaimPublished(created.row.id, {
        publishedAt: epochNow(),
        publishedBy: 'machine-a',
        machineId: 'machine-a',
      });
      expect(retry?.claim.state).toBe('published');
      expect(getContentPublication('skill', 'skill-1')).not.toBeNull();
    });

    it('returns null and writes nothing on a non-active claim', () => {
      const created = insertContentClaim(makeClaim());
      if (!created.ok) throw new Error('unreachable');
      releaseContentClaim(created.row.id, epochNow());

      const result = markContentClaimPublished(created.row.id, {
        publishedAt: epochNow(),
        publishedBy: 'machine-a',
        machineId: 'machine-a',
      });
      expect(result).toBeNull();
      expect(getContentClaimById(created.row.id, ALL_PROJECTS_SCOPE)?.state).toBe('released');
      expect(getContentPublication('skill', 'skill-1')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Expiry sweep
  // ---------------------------------------------------------------------------

  describe('expireStaleContentClaims', () => {
    it('flips active rows past expires_at to expired, leaves unexpired active rows alone', () => {
      const now = epochNow();
      const expired = insertContentClaim(makeClaim({ artifactId: 'skill-old', expiresAt: now - 10 }));
      const fresh = insertContentClaim(makeClaim({ artifactId: 'skill-new', expiresAt: now + 10000, claimedBy: 'machine-b', machineId: 'machine-b' }));
      if (!expired.ok || !fresh.ok) throw new Error('unreachable');

      const count = expireStaleContentClaims(now);
      expect(count).toBe(1);

      expect(getContentClaimById(expired.row.id, ALL_PROJECTS_SCOPE)?.state).toBe('expired');
      expect(getContentClaimById(fresh.row.id, ALL_PROJECTS_SCOPE)?.state).toBe('active');
    });

    it('is the backstop for rows that arrive active with expires_at already past (e.g. backup-restore)', () => {
      // Simulates a row materialized directly (not through insertContentClaim's
      // "claim now" path) that is already past its TTL the moment it appears.
      const now = epochNow();
      const stale = insertContentClaim(makeClaim({ artifactId: 'skill-restored', claimedAt: now - 100000, expiresAt: now - 50000 }));
      if (!stale.ok) throw new Error('unreachable');
      expect(expireStaleContentClaims(now)).toBe(1);
      expect(getContentClaimById(stale.row.id, ALL_PROJECTS_SCOPE)?.state).toBe('expired');
    });

    it('never touches rows already in a terminal state', () => {
      const now = epochNow();
      const created = insertContentClaim(makeClaim({ expiresAt: now - 10 }));
      if (!created.ok) throw new Error('unreachable');
      releaseContentClaim(created.row.id, now);
      expect(expireStaleContentClaims(now)).toBe(0);
      expect(getContentClaimById(created.row.id, ALL_PROJECTS_SCOPE)?.state).toBe('released');
    });
  });

  // ---------------------------------------------------------------------------
  // Terminal-row prune (query function only — not scheduled by this module)
  // ---------------------------------------------------------------------------

  describe('pruneTerminalContentClaims', () => {
    it('removes released/published/expired rows older than the retention window', () => {
      const now = epochNow();
      const THIRTY_DAYS = 30 * 86400;

      const oldReleased = insertContentClaim(makeClaim({ artifactId: 'skill-old-released' }));
      const oldPublished = insertContentClaim(makeClaim({ artifactId: 'skill-old-published', claimedBy: 'm2', machineId: 'm2' }));
      const oldExpired = insertContentClaim(makeClaim({ artifactId: 'skill-old-expired', claimedBy: 'm3', machineId: 'm3', expiresAt: now - THIRTY_DAYS - 1000 }));
      const recentReleased = insertContentClaim(makeClaim({ artifactId: 'skill-recent-released', claimedBy: 'm4', machineId: 'm4' }));
      if (!oldReleased.ok || !oldPublished.ok || !oldExpired.ok || !recentReleased.ok) throw new Error('unreachable');

      releaseContentClaim(oldReleased.row.id, now - THIRTY_DAYS - 1000);
      markContentClaimPublished(oldPublished.row.id, {
        publishedAt: now - THIRTY_DAYS - 1000,
        publishedBy: 'm2',
        machineId: 'm2',
      });
      expireStaleContentClaims(now);
      releaseContentClaim(recentReleased.row.id, now - 100);

      const stillActiveGuard = insertContentClaim(makeClaim({ artifactId: 'skill-still-active', claimedBy: 'm5', machineId: 'm5' }));
      if (!stillActiveGuard.ok) throw new Error('unreachable');

      const removed = pruneTerminalContentClaims(THIRTY_DAYS, now);
      expect(removed).toBe(3);

      expect(getContentClaimById(oldReleased.row.id, ALL_PROJECTS_SCOPE)).toBeNull();
      expect(getContentClaimById(oldPublished.row.id, ALL_PROJECTS_SCOPE)).toBeNull();
      expect(getContentClaimById(oldExpired.row.id, ALL_PROJECTS_SCOPE)).toBeNull();
      // Recent terminal row and the still-active row both survive.
      expect(getContentClaimById(recentReleased.row.id, ALL_PROJECTS_SCOPE)).not.toBeNull();
      expect(getContentClaimById(stillActiveGuard.row.id, ALL_PROJECTS_SCOPE)?.state).toBe('active');
    });
  });

  // ---------------------------------------------------------------------------
  // content_publications
  // ---------------------------------------------------------------------------

  describe('content_publications', () => {
    it('upsert creates then updates the single row per (artifact_kind, artifact_id)', () => {
      const first = upsertContentPublication({
        artifact_kind: 'skill',
        artifact_id: 'skill-pub',
        published_generation: 1,
        published_at: epochNow(),
        published_by: 'machine-a',
        machine_id: 'machine-a',
      });
      expect(first.published_generation).toBe(1);

      const second = upsertContentPublication({
        artifact_kind: 'skill',
        artifact_id: 'skill-pub',
        published_generation: 2,
        published_at: epochNow() + 10,
        published_by: 'machine-b',
        machine_id: 'machine-b',
      });
      expect(second.published_generation).toBe(2);
      expect(second.published_by).toBe('machine-b');

      expect(getContentPublication('skill', 'skill-pub')?.published_generation).toBe(2);
      expect(listContentPublications('skill')).toHaveLength(1);
      expect(listContentPublications('okf_page')).toHaveLength(0);
    });

    it('getContentPublication returns null when the artifact has never been published', () => {
      expect(getContentPublication('skill', 'never-published')).toBeNull();
    });
  });
});
