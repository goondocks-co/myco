/**
 * The Knowledge pages' wire shapes, as the dashboard declares them, match the server's.
 *
 * The dashboard cannot import the server's declarations of a spore, its facets
 * or a plan: they sit in modules whose runtime imports its build does not
 * carry. So it declares them in `features/knowledge/wire.ts`, and this file
 * holds the two to each other. The assertions are types: `npm run
 * typecheck:tests` fails when a shape drifts.
 */
import type * as Ui from '../../packages/myco-server/ui/src/features/knowledge/wire.ts';
import type { SporeAcrossRow, SporeFacets, SporeRow, listSporePageAcross } from '../../packages/myco-server/src/core/spores.ts';
import type { getSpore } from '../../packages/myco-server/src/db/spores/records.ts';
import type {
  plans_PlanAcrossRow as PlanAcrossRow,
  plans_ProjectPlanRow as ProjectPlanRow,
  plans_getPlan as getPlan,
  plans_pagePlansAcross as pagePlansAcross,
  plans_pageProjectPlans as pageProjectPlans,
  plans_planTotals as planTotals,
} from '../../packages/myco-server/src/read/catalog/plans';

/** True only when each type is assignable to the other. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** True when what the server sends carries every field the dashboard reads, typed as it reads it. */
type Reads<Server, Dashboard> = [Server] extends [Dashboard] ? true : false;

/** `GET /api/spores`: the answer `handleSporesAcross` sends, the page's `rows` renamed `spores`. */
type SporePage = NonNullable<Awaited<ReturnType<typeof listSporePageAcross>>>;
type SporesAnswer = Omit<SporePage, 'rows'> & { spores: SporePage['rows']; maxPage: number };
/** `GET /api/projects/{p}/spores/{id}`: the answer `handleProjectSpore` sends. */
type SporeAnswer = { spore: NonNullable<Awaited<ReturnType<typeof getSpore>>>; supersededBy: string[]; supersedes: string[] };
/** `GET /api/plans`: the page `handlePlansAcross` sends, `rows` renamed `plans`, with the totals on its first page. */
type PlanTotals = Awaited<ReturnType<typeof planTotals>>;
type PlansPage = NonNullable<Awaited<ReturnType<typeof pagePlansAcross>>>;
type PlansAnswer = { plans: PlansPage['rows']; cursor: PlansPage['cursor']; hasMore: boolean;
  totals?: Extract<PlanTotals, { state: 'ready' }>['value']; counting?: 'building' };
/** `GET /api/projects/{p}/plans/{planKey}`: the answer `handleProjectPlan` sends. */
type PlanAnswer = { plan: NonNullable<Awaited<ReturnType<typeof getPlan>>>; projectId: string };
/** `GET /api/projects/{p}/plans`: the page `handleProjectPlans` sends. */
type ProjectPlansPage = NonNullable<Awaited<ReturnType<typeof pageProjectPlans>>>;
type ProjectPlansAnswer = { plans: ProjectPlansPage['rows']; cursor: ProjectPlansPage['cursor']; hasMore: boolean };

/** Each entry type-checks only when it is `true`. */
type Holds<T extends true> = T;

export type KnowledgeWireShapes = [
  Holds<Same<Ui.SporeFacets, SporeFacets>>,
  Holds<Same<NonNullable<Ui.SporeFields['authorKind']>, NonNullable<SporeRow['authorKind']>>>,
  Holds<Reads<SporeRow, Ui.SporeFields>>,
  Holds<Reads<SporeAcrossRow, Ui.SporeStreamRow>>,
  Holds<Reads<SporesAnswer, Ui.SporeStreamPage>>,
  Holds<Reads<SporeAnswer, Ui.SporeArticleAnswer>>,
  Holds<Reads<ProjectPlanRow, Ui.PlanFields>>,
  Holds<Reads<PlanAcrossRow, Ui.PlanBoardRow>>,
  Holds<Reads<PlansAnswer, Ui.PlanBoardPage>>,
  Holds<Reads<ProjectPlansAnswer, Ui.ProjectPlanPage>>,
  Holds<Reads<PlanAnswer, Ui.PlanPageAnswer>>,
];
