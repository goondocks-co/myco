/**
 * One page of a run's material, admitted the same way for every run tool that pages: pages are read in order, later pages
 * carry the revision of the earlier ones, and a write waits until the attempt has read every page.
 */
import { failure, type RunPrincipal, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';
import { MATERIAL_CHANGED, MATERIAL_UNREAD, materialRead, materialRevision } from '../../core/material-pages.js';
import { recordMaterialRead } from '../../core/runs.js';

/** The refusal that names the next page this attempt must read. */
const unreadRefusal = (nextPage: number, revision: string | undefined) => ({
  ...failure(`read page ${nextPage} of the material first`), code: MATERIAL_UNREAD, next_page: nextPage, ...(revision === undefined ? {} : { revision }),
});

/** The refusal of a write ahead of the pages served, or null once this attempt has read every page of the last revision it started. */
export function materialUnread(run: RunPrincipal): ReturnType<typeof unreadRefusal> | null {
  const read = materialRead(run.runContext, run.tokenId);
  return read === null || read.through < read.pages ? unreadRefusal((read?.through ?? 0) + 1, read?.revision) : null;
}

/**
 * The page this call asks for, or the refusal that answers the call. The page is credited as read last, after every write
 * `before` makes for it: a call that fails leaves the page unread, so a write cannot pass on text the run never received.
 */
export async function servePage<E>(ctx: ToolContext, run: RunPrincipal, input: ToolInput, entries: readonly unknown[], paginate: () => E[][],
  before: (served: readonly E[]) => Promise<void> = async () => {}):
  Promise<{ refusal: unknown } | { revision: string; page: number; served: E[]; next: { next_page?: number } }> {
  const page = input.page === undefined ? 1 : input.page as number;
  if (!Number.isInteger(page) || page < 1) return { refusal: failure('page is a whole number from 1') };
  const revision = await materialRevision(entries);
  if (page > 1 && input.revision !== revision) {
    return { refusal: { ...failure('the material changed since page 1, or this call carries no revision from it: restart at page 1'), code: MATERIAL_CHANGED } };
  }
  const pages = paginate();
  const served = pages[page - 1];
  if (served === undefined) return { refusal: failure(`this run's material ends at page ${pages.length}`) };
  const read = materialRead(run.runContext, run.tokenId);
  const through = read?.revision === revision ? read.through : 0;
  if (page > through + 1) return { refusal: unreadRefusal(through + 1, revision) };
  await before(served);
  if (page > through) await recordMaterialRead(ctx.env.db, ctx.projectId, run.runId, { tokenId: run.tokenId, revision, pages: pages.length, through: page });
  return { revision, page, served, next: page < pages.length ? { next_page: page + 1 } : {} };
}
