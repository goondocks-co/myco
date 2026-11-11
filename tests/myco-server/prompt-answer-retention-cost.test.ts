/**
 * Pruning expired prompt answers costs the same on D1 whether a Project holds a few or many answers still inside the
 * retention window: the sweep finds the expired ones without reading the ones it keeps.
 */
import { expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { emptyInjectionCounts } from '@myco-server-worker/core/injection.js';
import { JOB_BATCH } from '@myco-server-worker/core/jobs-run.js';
import { prunePromptAnswers } from '@myco-server-worker/core/recall.js';
import { d1TwoScale, eachUnit, expectTwoScale } from './helpers/two-scale.js';

const NOW = 1_790_000_000_000;
const CUTOFF = NOW - 30 * 86_400_000;
const EXPIRED = 5;
const SELECTION = JSON.stringify(emptyInjectionCounts());

async function insertExpired(db: RelationalStore, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await db.prepare(`INSERT INTO prompt_context_answers (project_id, session_id, prompt_id, id, outcome, context_chars, parts, skipped, failures, selection, created_at)
      VALUES ('proj_0', 'session', 'prompt', ?1, 'empty', 0, '[]', '[]', '[]', ?2, ?3)`).bind(id, SELECTION, CUTOFF - 1).run();
  }
}

it('prunes expired prompt answers at the same cost however many answers the window keeps', async () => {
  let round = 0;
  const costs = await d1TwoScale({
    sizes: [200, 2_000],
    setup: async (db) => { await db.prepare("INSERT INTO projects (project_id, name, created_at) VALUES ('proj_0', 'proj_0', 1)").run(); },
    grow: (db, from, to) => eachUnit(db, from, to, `INSERT INTO prompt_context_answers (project_id, session_id, prompt_id, id, outcome, context_chars, parts, skipped, failures, selection, created_at)
      SELECT 'proj_0', 'session', 'prompt', 'kept-' || i, 'empty', 0, '[]', '[]', '[]', ?3, ?4 FROM n`, SELECTION, NOW),
    cases: [{
      name: 'prune expired answers',
      run: async (db, at) => {
        round += 1;
        await insertExpired(at.store, Array.from({ length: EXPIRED }, (_, index) => `expired-${round}-${index}`));
        at.restart();
        expect(await prunePromptAnswers(db, CUTOFF, JOB_BATCH)).toBe(EXPIRED);
      },
    }],
  });
  expectTwoScale(costs);
}, 120_000);
