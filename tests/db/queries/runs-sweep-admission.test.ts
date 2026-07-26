/**
 * Write admission for the boot stale-run sweeps.
 *
 * `markRunningRunsInterrupted` and `sweepStaleSupersededRuns` rewrite
 * `agent_runs` grove-wide with no project filter. A project mid-residency-
 * transition at daemon restart would have its rows rewritten inside the push
 * window and then deleted unshipped by `deleteAfterAck`, so the sweeps take
 * an exclusion set derived from write admission.
 *
 * The exclusion set is computed from the CANDIDATE ROWS (`listStaleSweepProjectIds`)
 * rather than from the Grove registry, because a project mid-transition is
 * deregistered from every Grove while its lease is held — a registry
 * enumeration would miss precisely the project that matters. That property is
 * asserted directly below.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import {
  insertRun,
  getRun,
  markRunningRunsInterrupted,
  sweepStaleSupersededRuns,
  listStaleSweepProjectIds,
  RESUME_STATUS_READY,
  RESUME_STATUS_SUPERSEDED,
  type RunInsert,
} from '@myco/db/queries/runs.js';
import { ALL_PROJECTS_SCOPE, assertGroveProjectId, projectScope } from '@myco/grove/ids.js';

const epochNow = () => Math.floor(Date.now() / 1000);
const TEST_AGENT_ID = 'sweep-admission-agent';
const TEST_TASK = 'skill-evolve';
const MOVING = assertGroveProjectId('proj_' + 'a'.repeat(32));
const SETTLED = assertGroveProjectId('proj_' + 'b'.repeat(32));

function makeRun(overrides: Partial<RunInsert> = {}): RunInsert {
  return {
    id: `run-${Math.random().toString(36).slice(2, 10)}`,
    agent_id: TEST_AGENT_ID,
    task: TEST_TASK,
    ...overrides,
  };
}

describe('boot stale-run sweeps — project write admission', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: TEST_AGENT_ID, name: 'Sweep Admission Agent', created_at: epochNow() });
  });

  describe('markRunningRunsInterrupted', () => {
    it('rewrites running runs when nothing is excluded', () => {
      const run = insertRun(makeRun({ id: 'run-open', status: 'running', project_id: MOVING }));

      expect(markRunningRunsInterrupted('restarted', ALL_PROJECTS_SCOPE)).toBe(1);

      const after = getRun(run.id, ALL_PROJECTS_SCOPE)!;
      expect(after.status).toBe('failed');
      expect(after.resumable).toBe(1);
    });

    it('leaves an excluded project\'s running run exactly as it was', () => {
      const held = insertRun(makeRun({ id: 'run-held', status: 'running', project_id: MOVING }));
      const free = insertRun(makeRun({ id: 'run-free', status: 'running', project_id: SETTLED }));

      const changed = markRunningRunsInterrupted('restarted', ALL_PROJECTS_SCOPE, [MOVING]);

      expect(changed).toBe(1);
      expect(getRun(held.id, ALL_PROJECTS_SCOPE)!.status).toBe('running');
      expect(getRun(free.id, ALL_PROJECTS_SCOPE)!.status).toBe('failed');
    });

    it('never excludes project-less rows — no project lease governs them', () => {
      const global = insertRun(makeRun({ id: 'run-global', status: 'running' }));

      markRunningRunsInterrupted('restarted', ALL_PROJECTS_SCOPE, [MOVING, SETTLED]);

      expect(getRun(global.id, ALL_PROJECTS_SCOPE)!.status).toBe('failed');
    });
  });

  describe('sweepStaleSupersededRuns', () => {
    function seedSupersedablePair(projectId: string): string {
      const stale = insertRun(makeRun({
        id: `stale-${projectId.slice(-4)}`,
        status: 'failed',
        resumable: 1,
        resume_status: RESUME_STATUS_READY,
        started_at: epochNow() - 200,
        completed_at: epochNow() - 150,
        project_id: projectId,
      }));
      insertRun(makeRun({
        id: `done-${projectId.slice(-4)}`,
        status: 'completed',
        started_at: epochNow() - 120,
        completed_at: epochNow() - 100,
        project_id: projectId,
      }));
      return stale.id;
    }

    it('leaves an excluded project\'s resumable run resumable', () => {
      const heldStale = seedSupersedablePair(MOVING);
      const freeStale = seedSupersedablePair(SETTLED);

      const changed = sweepStaleSupersededRuns(ALL_PROJECTS_SCOPE, [MOVING]);

      expect(changed).toBe(1);
      expect(getRun(heldStale, ALL_PROJECTS_SCOPE)!.resume_status).toBe(RESUME_STATUS_READY);
      expect(getRun(freeStale, ALL_PROJECTS_SCOPE)!.resume_status).toBe(RESUME_STATUS_SUPERSEDED);
    });

    /**
     * Regression: the outer scope/exclusion clause is spliced into the SQL
     * AHEAD of the EXISTS subquery, so its bound params must precede
     * STATUS_COMPLETED. The original `.run(...)` passed STATUS_COMPLETED
     * first, which was latent only because the sole caller passed
     * `{kind:'all'}` with no exclusions — rendering both clauses empty. A
     * non-empty clause would have bound the project id to `C.status` and
     * the status string to the project predicate, silently sweeping the
     * wrong rows (or none).
     */
    it('binds a NON-EMPTY scope clause in placeholder order, not argument order', () => {
      const scopedStale = seedSupersedablePair(SETTLED);
      seedSupersedablePair(MOVING);

      // Project-scoped (non-empty clause) AND an exclusion: two spliced
      // predicates ahead of the subquery's own placeholder.
      const changed = sweepStaleSupersededRuns(projectScope(SETTLED), [MOVING]);

      expect(changed).toBe(1);
      expect(getRun(scopedStale, ALL_PROJECTS_SCOPE)!.resume_status).toBe(RESUME_STATUS_SUPERSEDED);
    });
  });

  describe('listStaleSweepProjectIds', () => {
    it('reports project ids from the ROWS, so a deregistered project is still seen', () => {
      // No Grove registry entry exists for either project in this test —
      // which is the point: mid-transition projects are deregistered, and
      // the sweeps must still find them.
      insertRun(makeRun({ id: 'r-running', status: 'running', project_id: MOVING }));
      insertRun(makeRun({
        id: 'r-resumable',
        status: 'failed',
        resumable: 1,
        resume_status: RESUME_STATUS_READY,
        project_id: SETTLED,
      }));

      const ids = listStaleSweepProjectIds(ALL_PROJECTS_SCOPE).sort();

      expect(ids).toEqual([MOVING, SETTLED].sort());
    });

    it('omits rows no sweep would touch, and project-less rows', () => {
      insertRun(makeRun({ id: 'r-done', status: 'completed', project_id: MOVING }));
      insertRun(makeRun({ id: 'r-null', status: 'running' }));

      expect(listStaleSweepProjectIds(ALL_PROJECTS_SCOPE)).toEqual([]);
    });
  });
});
