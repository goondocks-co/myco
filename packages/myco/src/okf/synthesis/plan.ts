import { assertSafeConceptId, OkfPathError } from '../paths.js';
import { OKF_RESERVED_FILES } from '../types.js';

/**
 * The page-plan model for OKF synthesis: the capped, auditable list of wiki
 * pages a synthesis run intends to write. Persisted to the vault's OKF private
 * state as `plan.json` (alongside `manifest.json`) — this doubles as the
 * spec's auditable `_plan.md`-equivalent AND is the cross-phase handoff vehicle:
 * the synthesize task's map-phase reads it back through a source tool because a
 * harness map-phase source can only read persisted state, never a prior phase's
 * in-memory output. `writePlan` therefore durably persists the full page list.
 */

/**
 * Hard ceiling on planned pages per synthesis run. A plan over this cap is a
 * runaway (an agent enumerating every file, say) and is rejected before any
 * page is synthesized.
 */
export const MAX_PLANNED_PAGES = 20;

/**
 * Basenames a planned page may never use: the generated bundle files, with and
 * without the `.md` suffix (plan paths may omit it — the page writer appends
 * `.md` before staging, so `guides/index` would collide with a generated
 * `guides/index.md`).
 */
const RESERVED_PLAN_BASENAMES = new Set<string>(
  OKF_RESERVED_FILES.flatMap((f) => [f, f.replace(/\.md$/, '')]),
);

export interface WikiPagePlan {
  /** Bundle-relative, OKF-slug-safe page path (no leading slash, no traversal). */
  path: string;
  /** Non-empty page kind, e.g. 'concept', 'overview', 'glossary'. */
  type: string;
  title: string;
  rationale: string;
  /** Stable ids of the source material this page synthesizes from. */
  sourceRefs: string[];
  /** Gaps the synthesis agent flagged for this page; omitted when there are none. */
  openQuestions?: string[];
}

export interface WikiPlan {
  generatedAt: string;
  sinceRef: string;
  pages: WikiPagePlan[];
}

/**
 * The narrow ProjectVault surface {@link writePlan}/{@link readPlan} delegate
 * to. Declared here (rather than importing ProjectVault) so this model layer
 * depends only on the pure-core `paths.js` — a ProjectVault satisfies it
 * structurally.
 */
export interface PlanVault {
  writeOkfPlan(plan: WikiPlan): void;
  readOkfPlan(): WikiPlan | null;
}

/**
 * Collect EVERY human-readable violation in `plan` (an empty array means valid).
 * Deliberately never early-returns: one round-trip surfaces the full list.
 * Checks:
 *   - the page count is within {@link MAX_PLANNED_PAGES},
 *   - each page `path` is OKF-slug-safe — delegated to `assertSafeConceptId`,
 *     the same choke point the bundle writer runs a path through (charset per
 *     segment, no traversal, no leading-slash/absolute, no NUL/backslash),
 *   - each page `type` is non-empty,
 *   - no page path uses a reserved basename (`index`/`log`, with or without
 *     `.md`) — those files are generated at publish time,
 *   - page paths are unique.
 */
export function validateWikiPlan(plan: WikiPlan): string[] {
  const errors: string[] = [];
  const { pages } = plan;

  if (pages.length > MAX_PLANNED_PAGES) {
    errors.push(`plan has ${pages.length} pages, over the ${MAX_PLANNED_PAGES}-page cap (MAX_PLANNED_PAGES)`);
  }

  pages.forEach((page, i) => {
    try {
      assertSafeConceptId(page.path);
    } catch (err) {
      const detail = err instanceof OkfPathError ? err.message : String(err);
      errors.push(`page ${i} path ${JSON.stringify(page.path)} is not OKF-slug-safe: ${detail}`);
    }
    if (page.type.trim() === '') {
      errors.push(`page ${i} (path ${JSON.stringify(page.path)}) has an empty type`);
    }
    const basename = page.path.split('/').pop() ?? '';
    if (RESERVED_PLAN_BASENAMES.has(basename)) {
      errors.push(
        `page ${i} path ${JSON.stringify(page.path)} uses the reserved basename ${JSON.stringify(basename)} — index and log files are generated, plan a content page instead`,
      );
    }
  });

  const counts = new Map<string, number>();
  for (const page of pages) counts.set(page.path, (counts.get(page.path) ?? 0) + 1);
  for (const [dupPath, count] of counts) {
    if (count > 1) errors.push(`duplicate page path ${JSON.stringify(dupPath)} appears ${count} times`);
  }

  return errors;
}

/** Durably persist the full plan to the vault's OKF private state (atomic, gitignore-first). */
export function writePlan(vault: PlanVault, plan: WikiPlan): void {
  vault.writeOkfPlan(plan);
}

/** Read the persisted plan back, or null when none exists or the file is corrupt. */
export function readPlan(vault: PlanVault): WikiPlan | null {
  return vault.readOkfPlan();
}
