/**
 * Release provenance end-to-end smoke.
 *
 * Drives the full release-provenance pipeline against a real temp git repo:
 *   1. Capture: write a knowledge_git_provenance row from a real Git HEAD.
 *   2. Reconcile: classify the row into knowledge_release_state.
 *   3. Lineage materialize: a spore tied to the prompt_batch inherits the
 *      same release_state row via record-lineage.
 *   4. Vector metadata: a fake VectorStore captures every patchDomainMetadata
 *      call so we can assert reconciliation propagates state without
 *      requiring sqlite-vec's native extension in the test process. (The
 *      real SqliteVecVectorStore swaps Bun's SQLite implementation via
 *      `setCustomSQLite`, which invalidates the test vault's pre-existing
 *      in-memory connection.)
 *   5. Search annotation: fullTextSearch result rows carry release_state.
 *   6. MCP surfaces: handleListSpores / handleListSessions / listPlansForMcp
 *      return release_state annotations.
 *   7. Harness projection: projectSporeForAgent returns compact
 *      {state, confidence} summary.
 *   8. Privacy: synced release_state payload omits basis_ref / basis_sha.
 *
 * If this test passes, every wiring layer in the feature is connected and
 * the contract between layers holds.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids';
import {
  getReleaseState,
  listGitProvenance,
} from '@myco/db/queries/release-provenance';
import { LOCAL_ONLY_SYNC_COLUMNS } from '@myco/db/queries/team-outbox';
import { upsertSession } from '@myco/db/queries/sessions';
import { insertBatch } from '@myco/db/queries/batches';
import { insertSpore } from '@myco/db/queries/spores';
import { upsertPlan } from '@myco/db/queries/plans';
import { registerAgent } from '@myco/db/queries/agents';
import { captureGitSnapshot } from '@myco/release-provenance/git-snapshot';
import { captureGitProvenance, deferGitProvenance } from '@myco/release-provenance/capture';
import { reconcileReleaseProvenance } from '@myco/release-provenance/reconcile';
import { refreshReleaseVectorMetadata } from '@myco/release-provenance/vector-metadata';
import { findDerivedRecords } from '@myco/release-provenance/record-lineage';
import type { DomainMetadata, VectorStore } from '@myco/daemon/embedding/types';
import { fullTextSearch } from '@myco/db/queries/search';
import { listPlansForMcp } from '@myco/plans/list-for-mcp';
import { handleListSpores } from '@myco/daemon/api/mycelium';
import { handleListSessions } from '@myco/daemon/api/sessions';
import {
  projectSporeForAgent,
  projectSessionForAgent,
  projectBatchForAgent,
} from '@myco/agent/tools/read-projections';
import {
  releaseStateAnnotation,
  releaseStateAnnotationMap,
} from '@myco/release-provenance/annotations';
import { TEST_REQUEST_CONTEXT } from '../helpers/request-context';

const NOW = 1_800_000_000;
const SESSION_ID = 'session-e2e';
const SPORE_ID = 'spore-e2e';
const PLAN_ID = 'plan-e2e';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeRepoWithRelease(): { repo: string; releasedSha: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-rp-e2e-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'one\n', 'utf-8');
  git(repo, ['add', 'file.txt']);
  git(repo, ['commit', '-qm', 'initial']);
  git(repo, ['tag', 'prod-v1']);
  return { repo, releasedSha: git(repo, ['rev-parse', 'HEAD']) };
}

/**
 * In-memory VectorStore stub that records every patchDomainMetadata call.
 * Avoids loading sqlite-vec in the test process.
 */
function makeFakeVectorStore() {
  const patches = new Map<string, Partial<DomainMetadata>>();
  const store: VectorStore = {
    upsert: () => {},
    remove: () => {},
    clear: () => ({ cleared: 0 }),
    search: () => [],
    stats: () => ({ total: 0, by_namespace: {}, models: {} }),
    getStaleIds: () => [],
    getEmbeddedIds: () => [],
    pairwiseSimilarity: () => [],
    patchDomainMetadata: (namespace, recordId, patch) => {
      const key = `${namespace}:${recordId}`;
      patches.set(key, { ...(patches.get(key) ?? {}), ...patch });
      return true;
    },
  };
  return { store, patches };
}

describe('release provenance E2E', () => {
  beforeAll(() => { setupTestDb(); });
  beforeEach(() => { cleanTestDb(); });
  afterAll(() => { teardownTestDb(); });

  it('drives capture → reconcile → derived materialize → vector → search → MCP → harness', async () => {
    const { repo, releasedSha } = makeRepoWithRelease();
    const { store, patches } = makeFakeVectorStore();

    try {
      // ---------- Phase 1: schema seed ----------
      registerAgent({
        id: 'claude-code',
        name: 'Claude Code',
        created_at: NOW,
      });
      upsertSession({
        id: SESSION_ID,
        agent: 'claude-code',
        status: 'completed',
        started_at: NOW,
        ended_at: NOW + 60,
        title: 'Release provenance E2E',
        summary: 'Drives the full pipeline.',
        created_at: NOW,
        machine_id: 'test-machine',
      });
      const batch = insertBatch({
        session_id: SESSION_ID,
        prompt_number: 1,
        user_prompt: 'reconcile please',
        response_summary: 'reconciled observation',
        started_at: NOW,
        ended_at: NOW + 30,
        created_at: NOW,
        machine_id: 'test-machine',
      });

      // ---------- Phase 2: capture provenance ----------
      const captured = captureGitProvenance({
        projectRoot: repo,
        sessionId: SESSION_ID,
        promptBatchId: batch.id,
        capturePoint: 'prompt_batch_stop',
        capturedAt: NOW,
      });
      expect(captured?.head_sha).toBe(releasedSha);

      // Idempotency: second call with identical status_hash is a no-op.
      const dupCount = listGitProvenance({ scope: ALL_PROJECTS_SCOPE, session_id: SESSION_ID }).length;
      captureGitProvenance({
        projectRoot: repo,
        sessionId: SESSION_ID,
        promptBatchId: batch.id,
        capturePoint: 'prompt_batch_stop',
        capturedAt: NOW + 1,
      });
      expect(listGitProvenance({ scope: ALL_PROJECTS_SCOPE, session_id: SESSION_ID }).length).toBe(dupCount);

      // Deferred capture path runs off-tick.
      deferGitProvenance({
        projectRoot: repo,
        sessionId: SESSION_ID,
        capturePoint: 'session_end',
        capturedAt: NOW + 5,
      });
      await new Promise((resolve) => setImmediate(resolve));
      const endRows = listGitProvenance({
        scope: ALL_PROJECTS_SCOPE,
        session_id: SESSION_ID,
        capture_point: 'session_end',
      });
      expect(endRows.length).toBe(1);

      // ---------- Phase 3: spore + plan tied to the prompt_batch ----------
      insertSpore({
        id: SPORE_ID,
        agent_id: 'claude-code',
        session_id: SESSION_ID,
        prompt_batch_id: batch.id,
        observation_type: 'discovery',
        content: 'release-provenance E2E observation',
        created_at: NOW + 10,
        machine_id: 'test-machine',
      });
      upsertPlan({
        id: PLAN_ID,
        logical_key: 'plan/e2e',
        session_id: SESSION_ID,
        prompt_batch_id: batch.id,
        title: 'E2E plan',
        content: '- [x] capture\n- [ ] release',
        created_at: NOW + 10,
        machine_id: 'test-machine',
      });

      // ---------- Phase 4: reconcile + vector propagation ----------
      const reconcileChanges: Array<{ namespace: string; recordId: string }> = [];
      const result = await reconcileReleaseProvenance({
        projectRoot: repo,
        scope: ALL_PROJECTS_SCOPE,
        config: {
          enabled: true,
          production_refs: ['prod-v1'],
          integration_refs: [],
          reconcile_interval_minutes: 15,
        },
        now: NOW + 100,
        onReleaseStateChanged: (changes) => {
          for (const change of changes) {
            reconcileChanges.push({ namespace: change.namespace, recordId: change.recordId });
            refreshReleaseVectorMetadata({
              store,
              db: null as never, // findDerivedRecords falls back to getDatabase()
              scope: ALL_PROJECTS_SCOPE,
              sourceNamespace: change.namespace,
              sourceRecordId: change.recordId,
              patch: {
                state: change.state,
                confidence: change.confidence,
                basis_kind: change.basisKind,
                checked_at: change.checkedAt,
              },
            });
          }
        },
      });
      expect(result.reconciled).toBeGreaterThan(0);
      expect(result.failed).toBe(0);

      // Source rows: prompt_batch + session_end should both classify released.
      const batchState = getReleaseState('prompt_batches', String(batch.id), ALL_PROJECTS_SCOPE);
      expect(batchState?.state).toBe('released');
      expect(batchState?.confidence).toBe('high');
      expect(batchState?.basis_ref).toBe('prod-v1');

      // Derived materialize: spore + plan inherit from the prompt_batch.
      const sporeState = getReleaseState('spores', SPORE_ID, ALL_PROJECTS_SCOPE);
      expect(sporeState?.state).toBe('released');
      expect(sporeState?.confidence).toBe('high');
      const planState = getReleaseState('plans', PLAN_ID, ALL_PROJECTS_SCOPE);
      expect(planState?.state).toBe('released');

      // record-lineage discovered both derived records.
      const derived = findDerivedRecords({
        sourceNamespace: 'prompt_batches',
        sourceRecordId: String(batch.id),
        scope: ALL_PROJECTS_SCOPE,
      });
      expect(derived.map((d) => `${d.namespace}:${d.recordId}`).sort()).toEqual(
        [`plans:${PLAN_ID}`, `spores:${SPORE_ID}`].sort(),
      );

      // onReleaseStateChanged fired for every source + derived record so the
      // vector store got every patch it needs.
      const changedKeys = new Set(reconcileChanges.map((c) => `${c.namespace}:${c.recordId}`));
      expect(changedKeys.has(`spores:${SPORE_ID}`)).toBe(true);
      expect(changedKeys.has(`plans:${PLAN_ID}`)).toBe(true);

      // Vector metadata patches reached the store for embeddable namespaces
      // (sessions/spores/plans). prompt_batches is non-embeddable and is
      // intentionally skipped.
      expect(patches.has(`spores:${SPORE_ID}`)).toBe(true);
      expect(patches.get(`spores:${SPORE_ID}`)?.release_state).toBe('released');
      expect(patches.get(`spores:${SPORE_ID}`)?.release_confidence).toBe('high');
      expect(patches.has(`plans:${PLAN_ID}`)).toBe(true);
      expect(patches.has(`sessions:${SESSION_ID}`)).toBe(true);
      expect(patches.has(`prompt_batches:${batch.id}`)).toBe(false);

      // ---------- Phase 5: search annotation ----------
      const ftsResults = fullTextSearch('observation', { scope: ALL_PROJECTS_SCOPE });
      const sporeResult = ftsResults.find((r) => r.type === 'spore' && r.id === SPORE_ID);
      expect(sporeResult?.release_state?.state).toBe('released');

      // ---------- Phase 6: MCP surfaces ----------
      const sporesBody = await handleListSpores({
        requestContext: TEST_REQUEST_CONTEXT,
        body: undefined,
        query: {},
        params: {},
        pathname: '/api/spores',
      });
      const spores = (sporesBody.body as { spores: Array<Record<string, unknown>> }).spores;
      const sporeRow = spores.find((s) => s.id === SPORE_ID);
      expect((sporeRow?.release_state as { state: string } | undefined)?.state).toBe('released');

      const sessionsBody = await handleListSessions({
        requestContext: TEST_REQUEST_CONTEXT,
        body: undefined,
        query: {},
        params: {},
        pathname: '/api/sessions',
      });
      const sessions = (sessionsBody.body as { sessions: Array<Record<string, unknown>> }).sessions;
      const sessionRow = sessions.find((s) => s.id === SESSION_ID);
      expect((sessionRow?.release_state as { state: string } | undefined)?.state).toBe('released');

      const plansResult = listPlansForMcp({ requestContext: TEST_REQUEST_CONTEXT });
      expect(plansResult.ok).toBe(true);
      if (plansResult.ok) {
        const planRow = plansResult.plans.find((p) => p.id === PLAN_ID);
        expect(planRow?.release_state?.state).toBe('released');
      }

      // ---------- Phase 7: harness projection ----------
      const sporeAnnotations = releaseStateAnnotationMap('spores', [SPORE_ID], ALL_PROJECTS_SCOPE);
      const projected = projectSporeForAgent(
        { id: SPORE_ID, observation_type: 'discovery', content: 'x', session_id: SESSION_ID, importance: 5, created_at: NOW + 10 } as never,
        { exact: false, release: sporeAnnotations.get(SPORE_ID) },
      );
      expect((projected.release_state as { state: string })?.state).toBe('released');
      expect((projected.release_state as { confidence: string })?.confidence).toBe('high');

      const sessionAnnotation = releaseStateAnnotation('sessions', SESSION_ID, ALL_PROJECTS_SCOPE);
      const projectedSession = projectSessionForAgent(
        { id: SESSION_ID, agent: 'claude-code', status: 'completed', title: 'E2E', prompt_count: 1 } as never,
        { release: sessionAnnotation ?? undefined },
      );
      expect((projectedSession.release_state as { state: string })?.state).toBe('released');

      const batchAnnotationMap = releaseStateAnnotationMap('prompt_batches', [String(batch.id)], ALL_PROJECTS_SCOPE);
      const projectedBatch = projectBatchForAgent(
        { id: batch.id, session_id: SESSION_ID, prompt_number: 1, user_prompt: 'x', response_summary: 'y' } as never,
        { release: batchAnnotationMap.get(String(batch.id)) },
      );
      expect((projectedBatch.release_state as { state: string })?.state).toBe('released');

      // ---------- Phase 8: privacy contract ----------
      expect(LOCAL_ONLY_SYNC_COLUMNS.knowledge_release_state).toContain('basis_ref');
      expect(LOCAL_ONLY_SYNC_COLUMNS.knowledge_release_state).toContain('basis_sha');
      expect(LOCAL_ONLY_SYNC_COLUMNS.knowledge_release_state).toContain('evidence_json');

      // ---------- Phase 9: idempotency on re-run ----------
      // Mark the existing release_state rows as synced. The reconciler's
      // unchanged short-circuit only fires for rows that have completed a
      // sync round-trip; pre-sync rows go through the full upsert path so
      // syncRow re-enqueues them (orphan-protection guard).
      const { getDatabase } = await import('@myco/db/client');
      getDatabase().prepare('UPDATE knowledge_release_state SET synced_at = ?').run(NOW + 150);

      const second = await reconcileReleaseProvenance({
        projectRoot: repo,
        scope: ALL_PROJECTS_SCOPE,
        config: {
          enabled: true,
          production_refs: ['prod-v1'],
          integration_refs: [],
          reconcile_interval_minutes: 15,
        },
        now: NOW + 200,
      });
      expect(second.unchanged).toBeGreaterThan(0);
      expect(second.failed).toBe(0);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('captureGitSnapshot returns soft-failure shape outside Git', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-rp-nogit-'));
    try {
      const snapshot = captureGitSnapshot(tmp);
      expect(snapshot.is_git_repository).toBe(false);
      expect(snapshot.error).toBe('not_git_repository');
      expect(snapshot.head_sha).toBeNull();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // Ref-movement gate tests (A/B/C/D)
  // ---------------------------------------------------------------------------

  describe('ref-movement gate', () => {
    // Minimal repo setup shared across gate tests: one session, one batch, one
    // provenance row.
    async function setupGateRepo(repo: string) {
      const NOW_GATE = 1_900_000_000;
      const SESSION_G = 'session-gate';

      registerAgent({ id: 'claude-code', name: 'Claude Code', created_at: NOW_GATE });
      upsertSession({
        id: SESSION_G,
        agent: 'claude-code',
        status: 'completed',
        started_at: NOW_GATE,
        ended_at: NOW_GATE + 60,
        title: 'Gate test',
        summary: 'Gate test session.',
        created_at: NOW_GATE,
        machine_id: 'test-machine',
      });
      const batch = insertBatch({
        session_id: SESSION_G,
        prompt_number: 1,
        user_prompt: 'gate',
        response_summary: 'gate',
        started_at: NOW_GATE,
        ended_at: NOW_GATE + 30,
        created_at: NOW_GATE,
        machine_id: 'test-machine',
      });
      captureGitProvenance({
        projectRoot: repo,
        sessionId: SESSION_G,
        promptBatchId: batch.id,
        capturePoint: 'prompt_batch_stop',
        capturedAt: NOW_GATE,
      });
      return { batch, NOW_GATE };
    }

    it('Test A — gate returns a fingerprint and skips when refs unchanged', async () => {
      const { repo, releasedSha: _sha } = makeRepoWithRelease();
      try {
        const { batch, NOW_GATE } = await setupGateRepo(repo);

        // First pass: no lastRefsFingerprint.
        const result = await reconcileReleaseProvenance({
          projectRoot: repo,
          scope: ALL_PROJECTS_SCOPE,
          config: {
            enabled: true,
            production_refs: ['prod-v1'],
            integration_refs: [],
            reconcile_interval_minutes: 15,
          },
          now: NOW_GATE + 100,
        });
        expect(result.reconciled).toBeGreaterThan(0);
        expect(result.failed).toBe(0);
        const fp1 = result.refsFingerprint;
        expect(fp1).toBeTruthy();
        expect(typeof fp1).toBe('string');

        // Mark all rows synced.
        const { getDatabase } = await import('@myco/db/client');
        getDatabase().prepare('UPDATE knowledge_release_state SET synced_at = ?').run(NOW_GATE + 150);

        // Second pass: refs unmoved, fingerprint matches.
        const result2 = await reconcileReleaseProvenance({
          projectRoot: repo,
          scope: ALL_PROJECTS_SCOPE,
          config: {
            enabled: true,
            production_refs: ['prod-v1'],
            integration_refs: [],
            reconcile_interval_minutes: 15,
          },
          now: NOW_GATE + 200,
          lastRefsFingerprint: fp1,
        });
        expect(result2.refsFingerprint).toBe(fp1);
        expect(result2.unchanged).toBeGreaterThan(0);
        expect(result2.reconciled).toBe(0);
        expect(result2.failed).toBe(0);

        // Verify batch state is still correct.
        const batchState = getReleaseState('prompt_batches', String(batch.id), ALL_PROJECTS_SCOPE);
        expect(batchState?.state).toBe('released');
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    it('Test B — no missed transition when ref moves (merged_unreleased → released)', async () => {
      // Build a repo where HEAD is ahead of the production tag but the
      // integration branch includes HEAD, so first classify = merged_unreleased.
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-rp-gate-b-'));
      try {
        git(repo, ['init', '-q']);
        git(repo, ['config', 'user.email', 'test@example.com']);
        git(repo, ['config', 'user.name', 'Test User']);

        // Commit 1: prod tag placed here.
        fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n', 'utf-8');
        git(repo, ['add', 'base.txt']);
        git(repo, ['commit', '-qm', 'base commit']);
        git(repo, ['tag', 'prod-v1']);

        // Commit 2: only reachable from integration branch (HEAD is past prod-v1).
        fs.writeFileSync(path.join(repo, 'new.txt'), 'new\n', 'utf-8');
        git(repo, ['add', 'new.txt']);
        git(repo, ['commit', '-qm', 'integration commit']);
        // HEAD is now ahead of prod-v1; create an integration branch pointing at HEAD.
        git(repo, ['branch', 'integration']);

        const NOW_B = 1_950_000_000;
        const SESSION_B = 'session-gate-b';
        registerAgent({ id: 'claude-code', name: 'Claude Code', created_at: NOW_B });
        upsertSession({
          id: SESSION_B,
          agent: 'claude-code',
          status: 'completed',
          started_at: NOW_B,
          ended_at: NOW_B + 60,
          title: 'Gate B',
          summary: 'Gate B.',
          created_at: NOW_B,
          machine_id: 'test-machine',
        });
        const batch = insertBatch({
          session_id: SESSION_B,
          prompt_number: 1,
          user_prompt: 'gate b',
          response_summary: 'gate b',
          started_at: NOW_B,
          ended_at: NOW_B + 30,
          created_at: NOW_B,
          machine_id: 'test-machine',
        });
        captureGitProvenance({
          projectRoot: repo,
          sessionId: SESSION_B,
          promptBatchId: batch.id,
          capturePoint: 'prompt_batch_stop',
          capturedAt: NOW_B,
        });

        // First pass: HEAD reachable from integration but not prod-v1 → merged_unreleased.
        const result1 = await reconcileReleaseProvenance({
          projectRoot: repo,
          scope: ALL_PROJECTS_SCOPE,
          config: {
            enabled: true,
            production_refs: ['prod-v1'],
            integration_refs: ['integration'],
            reconcile_interval_minutes: 15,
          },
          now: NOW_B + 100,
        });
        expect(result1.reconciled).toBeGreaterThan(0);
        expect(result1.failed).toBe(0);
        const fp1 = result1.refsFingerprint;
        expect(fp1).toBeTruthy();

        // Verify initial state is merged_unreleased.
        const batchState1 = getReleaseState('prompt_batches', String(batch.id), ALL_PROJECTS_SCOPE);
        expect(batchState1?.state).toBe('merged_unreleased');

        // Mark rows synced.
        const { getDatabase } = await import('@myco/db/client');
        getDatabase().prepare('UPDATE knowledge_release_state SET synced_at = ?').run(NOW_B + 150);

        // Move prod-v1 to HEAD.
        git(repo, ['tag', '-f', 'prod-v1', 'HEAD']);

        // Second pass with fp1 as lastRefsFingerprint — prod-v1 moved so
        // fingerprint should differ and row should re-classify to released.
        const result2 = await reconcileReleaseProvenance({
          projectRoot: repo,
          scope: ALL_PROJECTS_SCOPE,
          config: {
            enabled: true,
            production_refs: ['prod-v1'],
            integration_refs: ['integration'],
            reconcile_interval_minutes: 15,
          },
          now: NOW_B + 200,
          lastRefsFingerprint: fp1,
        });
        expect(result2.refsFingerprint).not.toBe(fp1);
        expect(result2.reconciled).toBeGreaterThan(0);
        expect(result2.failed).toBe(0);

        const batchState2 = getReleaseState('prompt_batches', String(batch.id), ALL_PROJECTS_SCOPE);
        expect(batchState2?.state).toBe('released');
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    it('Test C — undefined lastRefsFingerprint forces full scan (first-run / restart safety)', async () => {
      const { repo } = makeRepoWithRelease();
      try {
        const { batch, NOW_GATE } = await setupGateRepo(repo);

        // First pass (no fingerprint).
        const result1 = await reconcileReleaseProvenance({
          projectRoot: repo,
          scope: ALL_PROJECTS_SCOPE,
          config: {
            enabled: true,
            production_refs: ['prod-v1'],
            integration_refs: [],
            reconcile_interval_minutes: 15,
          },
          now: NOW_GATE + 100,
        });
        expect(result1.reconciled).toBeGreaterThan(0);

        // Mark rows synced.
        const { getDatabase } = await import('@myco/db/client');
        getDatabase().prepare('UPDATE knowledge_release_state SET synced_at = ?').run(NOW_GATE + 150);

        // Second pass WITHOUT lastRefsFingerprint (simulates daemon restart).
        const result2 = await reconcileReleaseProvenance({
          projectRoot: repo,
          scope: ALL_PROJECTS_SCOPE,
          config: {
            enabled: true,
            production_refs: ['prod-v1'],
            integration_refs: [],
            reconcile_interval_minutes: 15,
          },
          now: NOW_GATE + 200,
          // intentionally omit lastRefsFingerprint
        });
        // Must go through the normal path (classificationUnchanged fires → unchanged).
        expect(result2.unchanged).toBeGreaterThan(0);
        expect(result2.failed).toBe(0);
        // Must still return a fingerprint.
        expect(result2.refsFingerprint).toBeTruthy();

        // Sanity: batch state still set correctly.
        const batchState = getReleaseState('prompt_batches', String(batch.id), ALL_PROJECTS_SCOPE);
        expect(batchState?.state).toBe('released');
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    it('Test D — unsynced orphan is NOT gate-skipped even when refs unchanged', async () => {
      const { repo } = makeRepoWithRelease();
      try {
        const { batch, NOW_GATE } = await setupGateRepo(repo);

        // First pass.
        const result1 = await reconcileReleaseProvenance({
          projectRoot: repo,
          scope: ALL_PROJECTS_SCOPE,
          config: {
            enabled: true,
            production_refs: ['prod-v1'],
            integration_refs: [],
            reconcile_interval_minutes: 15,
          },
          now: NOW_GATE + 100,
        });
        expect(result1.reconciled).toBeGreaterThan(0);
        const fp1 = result1.refsFingerprint;
        expect(fp1).toBeTruthy();

        // Mark rows synced, then clear synced_at for the batch row (orphan).
        const { getDatabase } = await import('@myco/db/client');
        getDatabase().prepare('UPDATE knowledge_release_state SET synced_at = ?').run(NOW_GATE + 150);
        getDatabase()
          .prepare(
            "UPDATE knowledge_release_state SET synced_at = NULL WHERE namespace = 'prompt_batches' AND record_id = ?",
          )
          .run(String(batch.id));

        // Second pass: refs unchanged, but the batch row is unsynced (orphan).
        const result2 = await reconcileReleaseProvenance({
          projectRoot: repo,
          scope: ALL_PROJECTS_SCOPE,
          config: {
            enabled: true,
            production_refs: ['prod-v1'],
            integration_refs: [],
            reconcile_interval_minutes: 15,
          },
          now: NOW_GATE + 200,
          lastRefsFingerprint: fp1,
        });
        // The unsynced prompt_batches row must go through the full upsert path.
        expect(result2.reconciled).toBeGreaterThan(0);
        expect(result2.failed).toBe(0);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    it('Test E — moving a tag that shares a name with a branch is NOT a false skip', async () => {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-rp-gate-e-'));
      try {
        git(repo, ['init', '-q']);
        git(repo, ['config', 'user.email', 'test@example.com']);
        git(repo, ['config', 'user.name', 'Test User']);
        fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n', 'utf-8');
        git(repo, ['add', 'base.txt']);
        git(repo, ['commit', '-qm', 'c1']);
        const c1 = git(repo, ['rev-parse', 'HEAD']);
        fs.writeFileSync(path.join(repo, 'next.txt'), 'next\n', 'utf-8');
        git(repo, ['add', 'next.txt']);
        git(repo, ['commit', '-qm', 'c2']); // HEAD = c2

        // Branch `release` frozen at c1; tag `release` also at c1. Bare config name
        // `release` resolves (git precedence) to the TAG.
        git(repo, ['branch', 'release', c1]);
        git(repo, ['tag', 'release', c1]);

        const NOW_E = 1_970_000_000;
        const SESSION_E = 'session-gate-e';
        registerAgent({ id: 'claude-code', name: 'Claude Code', created_at: NOW_E });
        upsertSession({
          id: SESSION_E, agent: 'claude-code', status: 'completed',
          started_at: NOW_E, ended_at: NOW_E + 60, title: 'Gate E', summary: 'Gate E.',
          created_at: NOW_E, machine_id: 'test-machine',
        });
        const batch = insertBatch({
          session_id: SESSION_E, prompt_number: 1, user_prompt: 'gate e',
          response_summary: 'gate e', started_at: NOW_E, ended_at: NOW_E + 30,
          created_at: NOW_E, machine_id: 'test-machine',
        });
        captureGitProvenance({
          projectRoot: repo, sessionId: SESSION_E, promptBatchId: batch.id,
          capturePoint: 'prompt_batch_stop', capturedAt: NOW_E,
        });

        const cfg = {
          enabled: true,
          production_refs: ['release'],
          integration_refs: [],
          reconcile_interval_minutes: 15,
        };

        // Pass 1: HEAD (c2) is not contained in tag release (c1) -> not released.
        const r1 = await reconcileReleaseProvenance({
          projectRoot: repo, scope: ALL_PROJECTS_SCOPE, config: cfg, now: NOW_E + 100,
        });
        expect(r1.failed).toBe(0);
        const fp1 = r1.refsFingerprint;
        expect(fp1).toBeTruthy();
        const state1 = getReleaseState('prompt_batches', String(batch.id), ALL_PROJECTS_SCOPE);
        expect(state1?.state).not.toBe('released');

        const { getDatabase } = await import('@myco/db/client');
        getDatabase().prepare('UPDATE knowledge_release_state SET synced_at = ?').run(NOW_E + 150);

        // Move ONLY the tag to HEAD (c2). The branch `release` stays at c1.
        git(repo, ['tag', '-f', 'release', 'HEAD']);

        // Pass 2 with fp1: the tag moved, so the fingerprint MUST change and the
        // row MUST re-classify to released. The old for-each-ref+alias map tracked
        // the (unmoved) branch SHA and would wrongly skip here.
        const r2 = await reconcileReleaseProvenance({
          projectRoot: repo, scope: ALL_PROJECTS_SCOPE, config: cfg,
          now: NOW_E + 200, lastRefsFingerprint: fp1,
        });
        expect(r2.refsFingerprint).not.toBe(fp1);
        expect(r2.failed).toBe(0);
        const state2 = getReleaseState('prompt_batches', String(batch.id), ALL_PROJECTS_SCOPE);
        expect(state2?.state).toBe('released');
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});
