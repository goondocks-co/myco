/**
 * The Knowledge pages' wire shapes, as the dashboard declares them, match the server's.
 *
 * The dashboard cannot import the server's declarations of a spore, its facets
 * or a plan: they sit in modules whose runtime imports its build does not
 * carry. So it declares them in `features/knowledge/wire.ts`, and this file
 * holds the two to each other. The assertions are types: `npm run
 * typecheck:tests` fails when a shape drifts, and the one runtime expectation
 * keeps the file a test Bun collects.
 */
import { describe, expect, it } from 'bun:test';
import type * as Ui from '../../packages/myco-server/ui/src/features/knowledge/wire.ts';
import type { SporeAcrossRow, SporeFacets, SporeRow, getSpore } from '../../packages/myco-server/src/core/spores.ts';
import type { PlanAcrossRow, ProjectPlanRow, getPlan, pagePlansAcross, pageProjectPlans, planTotals } from '../../packages/myco-server/src/read/plans.ts';

/** True only when each type is assignable to the other. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** True when what the server sends carries every field the dashboard reads, typed as it reads it. */
type Reads<Server, Dashboard> = [Server] extends [Dashboard] ? true : false;

/** `GET /api/spores`: the answer `handleSporesAcross` sends. */
type SporesAnswer = { spores: SporeAcrossRow[]; total: number; maxPage: number; facets?: SporeFacets };
/** `GET /api/projects/{p}/spores/{id}`: the answer `handleProjectSpore` sends. */
type SporeAnswer = { spore: NonNullable<Awaited<ReturnType<typeof getSpore>>>; supersededBy: string[]; supersedes: string[] };
/** `GET /api/plans`: the page `handlePlansAcross` sends, `rows` renamed `plans`, with the totals on its first page. */
type PlansAnswer = { plans: Awaited<ReturnType<typeof pagePlansAcross>>['rows']; cursor: Awaited<ReturnType<typeof pagePlansAcross>>['cursor']; totals?: Awaited<ReturnType<typeof planTotals>> };
/** `GET /api/projects/{p}/plans/{planKey}`: the answer `handleProjectPlan` sends. */
type PlanAnswer = { plan: NonNullable<Awaited<ReturnType<typeof getPlan>>>; projectId: string };
/** `GET /api/projects/{p}/plans`: the page `handleProjectPlans` sends. */
type ProjectPlansAnswer = { plans: Awaited<ReturnType<typeof pageProjectPlans>>['rows']; cursor: Awaited<ReturnType<typeof pageProjectPlans>>['cursor'] };

const SAME: [
  Same<Ui.SporeFacets, SporeFacets>,
  Same<NonNullable<Ui.SporeFields['authorKind']>, NonNullable<SporeRow['authorKind']>>,
] = [true, true];

const READS: [
  Reads<SporeRow, Ui.SporeFields>,
  Reads<SporeAcrossRow, Ui.SporeStreamRow>,
  Reads<SporesAnswer, Ui.SporeStreamPage>,
  Reads<SporeAnswer, Ui.SporeArticleAnswer>,
  Reads<ProjectPlanRow, Ui.PlanFields>,
  Reads<PlanAcrossRow, Ui.PlanBoardRow>,
  Reads<PlansAnswer, Ui.PlanBoardPage>,
  Reads<ProjectPlansAnswer, Ui.ProjectPlanPage>,
  Reads<PlanAnswer, Ui.PlanPageAnswer>,
] = [true, true, true, true, true, true, true, true, true];

describe("the Knowledge pages' wire shapes", () => {
  it('are held to the server declarations by the tests typecheck', () => {
    expect([...SAME, ...READS].every(Boolean)).toBe(true);
  });
});
