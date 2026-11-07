import { runRefusal } from '../../core/run-tool-contract.js';
import { assignmentOf } from '../../db/run-context.js';
/**
 * One page of a run's material, admitted the same way for every run tool that pages: pages are read in order, later pages
 * carry the revision of the earlier ones, and a write waits until the attempt has read every page.
 */
import { type RunPrincipal, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';
import { MATERIAL_CHANGED, MATERIAL_UNREAD, materialRead, materialRevision } from '../../core/material-pages.js';
import { recordMaterialRead } from '../../core/runs.js';

/** The refusal that names the next page this attempt must read. */
const materialTool = (run: RunPrincipal) => (assignmentOf(run.runContext, 'cards') === null ? 'myco_run_learning' : 'myco_run_cards');
const unreadRefusal = (run: RunPrincipal, nextPage: number, revision: string | undefined) => ({
  ...runRefusal({
    what: 'material-dependent operation',
    actual: `material page ${nextPage} has not been read by this attempt`,
    next: { tool: materialTool(run), op: 'material', page: nextPage, ...(revision === undefined ? {} : { revision }) },
  }),
  code: MATERIAL_UNREAD,
  next_page: nextPage,
  ...(revision === undefined ? {} : { revision }),
});

/** The refusal of a write ahead of the pages served, or null once this attempt has read every page of the last revision it started. */
export function materialUnread(run: RunPrincipal): ReturnType<typeof unreadRefusal> | null {
  const read = materialRead(run.runContext, run.tokenId);
  return read === null || read.through < read.pages ? unreadRefusal(run, (read?.through ?? 0) + 1, read?.revision) : null;
}

/**
 * The page this call asks for, or the refusal that answers the call. The page is credited as read last, after every write
 * `before` makes for it: a call that fails leaves the page unread, so a write cannot pass on text the run never received.
 */
export async function servePage<E>(
  ctx: ToolContext,
  run: RunPrincipal,
  input: ToolInput,
  entries: readonly unknown[],
  paginate: () => E[][],
  before: (served: readonly E[]) => Promise<void> = async () => {},
  unavailable: readonly string[] = [],
): Promise<{ refusal: unknown } | { revision: string; page: number; served: E[]; next: { next_page?: number } }> {
  const page = input.page === undefined ? 1 : (input.page as number);
  if (!Number.isInteger(page) || page < 1)
    return {
      refusal: runRefusal({
        what: 'material read',
        read: true,
        actual: `page is ${JSON.stringify(page)}; expected a whole number from 1`,
        next: { tool: materialTool(run), op: 'material', page: 1 },
      }),
    };
  const revision = await materialRevision(entries);
  if (page > 1 && input.revision !== revision) {
    return {
      refusal: {
        ...runRefusal({
          what: 'material read',
          read: true,
          actual: 'the material changed since page 1, or revision is missing',
          next: { tool: materialTool(run), op: 'material', page: 1 },
        }),
        code: MATERIAL_CHANGED,
      },
    };
  }
  const pages = paginate();
  const served = pages[page - 1];
  if (served === undefined)
    return {
      refusal: runRefusal({
        what: 'material read',
        read: true,
        actual: `requested page ${page}; the last valid page is ${pages.length}`,
        next:
          materialUnread(run) === null
            ? {
                tool: materialTool(run) === 'myco_run_cards' ? 'myco_run_cards' : 'myco_spores',
                op: materialTool(run) === 'myco_run_cards' ? 'write' : 'save',
                ...(materialTool(run) === 'myco_run_cards' ? { revision } : {}),
              }
            : { tool: materialTool(run), op: 'material', page: (materialRead(run.runContext, run.tokenId)?.through ?? 0) + 1, revision },
        repair:
          materialUnread(run) === null
            ? materialTool(run) === 'myco_run_cards'
              ? 'All material is read; writing comes next.'
              : 'All material is read. Save the durable spores first, then call myco_run_learning op complete with the handoff.'
            : 'Read the remaining material first; writing comes next.',
      }),
    };
  const read = materialRead(run.runContext, run.tokenId);
  const through = read?.revision === revision ? read.through : 0;
  if (page > through + 1) return { refusal: unreadRefusal(run, through + 1, revision) };
  await before(served);
  if (page > through)
    await recordMaterialRead(ctx.env.db, ctx.projectId, run.runId, {
      tokenId: run.tokenId,
      revision,
      pages: pages.length,
      through: page,
      items: entries.length,
      ...(unavailable.length === 0 ? {} : { unavailable }),
    });
  return { revision, page, served, next: page < pages.length ? { next_page: page + 1 } : {} };
}
