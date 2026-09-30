/**
 * The shapes the Knowledge pages read off the wire: a page of `GET /api/spores`
 * with its facets, one spore of `GET /api/projects/{p}/spores/{id}`, a page
 * of `GET /api/plans` and one plan of `GET /api/projects/{p}/plans/{planKey}`.
 *
 * The server's declarations (`core/spores.ts`, `read/plans.ts`) pull in the
 * server's runtime modules, which this dashboard's build does not carry, so the
 * shapes are declared here and held to the server's by
 * `tests/myco-server/knowledge-wire.test.ts`, which the tests typecheck
 * compiles. This file imports nothing, so that check can read it outside the
 * dashboard.
 */

/** The fields the stream and the article read of a spore. */
export interface SporeFields {
  id: string;
  sessionId: string | null;
  promptId: string | null;
  observationType: string;
  status: string;
  content: string;
  context: string | null;
  importance: number;
  filePath: string | null;
  tags: string | null;
  /** The run, member or access key that wrote it; null on a spore written before this was recorded. */
  author: string | null;
  /** What kind of writer `author` names: one of Myco's runs, a member, a spore imported from Myco 1.4, or an access key; null with no author. */
  authorKind?: 'run' | 'member' | 'imported' | 'grant' | null;
  /** The one line written for agents, when the writer gave one. */
  agentLine: string | null;
  createdAt: number;
  updatedAt: number | null;
}

/** A spore listed across Projects. */
export interface SporeStreamRow extends SporeFields {
  projectId: string;
}

/** How the spores the filters admit divide by type and by Project; each facet counts under every filter but its own. */
export interface SporeFacets {
  type: Record<string, number>;
  project: Record<string, number>;
}

/** A page of `GET /api/spores`. The first page (offset 0) carries the facets. */
export interface SporeStreamPage {
  readonly spores: readonly SporeStreamRow[];
  readonly total: number;
  readonly maxPage: number;
  readonly facets?: SporeFacets;
}

/** One spore with its lineage both ways, as `GET /api/projects/{p}/spores/{id}` answers. */
export interface SporeArticleAnswer {
  spore: SporeFields & { sourceCreatedAt: number | null };
  /** The spores recorded as replacing this one, newest first. */
  supersededBy: string[];
  /** The spores this one replaced, newest first. */
  supersedes: string[];
}

/** The fields the board and a plan's page read of a plan. */
export interface PlanFields {
  planKey: string;
  sessionId: string;
  promptId: string | null;
  title: string | null;
  status: string;
  content: string | null;
  blobKey: string | null;
  originPath: string | null;
  /** `checked/total` over the plan's task list, or `N/A` when it has none. */
  progress: string;
  /** The member behind its last status change; null when a capture wrote last. */
  updatedBy: string | null;
  createdAt: number;
  updatedAt: number;
  tags: string[];
}

/** A plan listed across Projects. */
export interface PlanBoardRow extends PlanFields {
  projectId: string;
}

/** A page of `GET /api/plans`. The first page (no cursor) counts the plans of each status the other filters admit. */
export interface PlanBoardPage {
  readonly plans: readonly PlanBoardRow[];
  readonly cursor: string | null;
  readonly totals?: Readonly<Record<string, number>>;
}

/** `GET /api/projects/{p}/plans/{planKey}`: one plan with its tags. */
export interface PlanPageAnswer {
  plan: PlanFields;
  projectId: string;
}

/** A page of `GET /api/projects/{p}/plans`. */
export interface ProjectPlanPage {
  readonly plans: readonly PlanFields[];
  readonly cursor: string | null;
}
