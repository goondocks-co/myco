/**
 * Keeping a Deployment told which models this worker's harnesses can run.
 *
 * The claim loop asks `due` on each pass where the Deployment advertises `MODEL_CATALOG_FEATURE`, and nothing here
 * holds a claim up: a listing runs in the background, and a report is sent without the loop waiting for its answer. A
 * worker lists its harnesses once on attaching and again `MODEL_CATALOG_REFRESH_MS` after its last listing, and reports
 * each harness's catalog on its own, one per pass, so every report fits the Deployment's body bound. A report the
 * Deployment could not be reached for is sent again on a later pass, and one it refused is dropped until the next
 * listing. A failed listing is said in the worker's log, and the catalogs that did list are reported.
 */
import { MODEL_CATALOG_REFRESH_MS, type ModelCatalog } from '@goondocks/myco-shared/execution-profile';
import type { HarnessListing } from './models.js';
import type { WorkerAnswer } from './loop.js';

/** Lists the models of each harness named, stopping when `signal` aborts. */
export type ListModels = (harnesses: readonly string[], signal: AbortSignal) => Promise<HarnessListing[]>;

export interface CatalogReporter {
  /** Start a listing that is due, or send a report that is waiting; never waits for either. */
  due(): void;
  /** Replace the authenticated harness set and invalidate listings from an older set. */
  reconcile(harnesses: readonly string[]): void;
  /** Stop any listing in flight. */
  stop(): Promise<void>;
}

export function modelCatalogs(options: {
  harnesses: readonly string[];
  list: ListModels;
  send: (catalog: ModelCatalog) => Promise<WorkerAnswer>;
  log: (line: string) => void;
  clock: () => number;
}): CatalogReporter {
  const stopping = new AbortController();
  let harnesses = [...options.harnesses];
  let generation = 0;
  let listingStop = new AbortController();
  const activeListings = new Set<Promise<void>>();
  let listedAt: number | null = null;
  let listing = false;
  let sending = false;
  /** The catalogs listed and not yet recorded, in the order they are reported. */
  let waiting: ModelCatalog[] = [];
  /** The reason each harness last failed to list, so a repeat is not said again. */
  const failed = new Map<string, string>();

  const listNow = (): void => {
    listing = true;
    const revision = generation;
    const work = options.list(harnesses, listingStop.signal).then((listed) => {
      if (revision !== generation || stopping.signal.aborted) return;
      const catalogs: ModelCatalog[] = [];
      for (const result of listed) {
        if (result.ok) { catalogs.push(result.catalog); failed.delete(result.catalog.harness); continue; }
        if (failed.get(result.harness) !== result.reason) options.log(`could not list the models ${result.harness} offers: ${result.reason}`);
        failed.set(result.harness, result.reason);
      }
      waiting = catalogs;
    }, (error: unknown) => {
      if (revision !== generation || stopping.signal.aborted) return;
      options.log(`could not list models: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      if (revision !== generation) return;
      listedAt = options.clock();
      listing = false;
    });
    activeListings.add(work);
    void work.finally(() => { activeListings.delete(work); });
  };

  const sendNow = (catalog: ModelCatalog): void => {
    sending = true;
    void options.send(catalog).then((answer) => {
      if (answer.kind === 'unreachable') return;
      waiting = waiting.filter((held) => held !== catalog);
      if (answer.kind === 'refused') options.log(`the Deployment refused the models ${catalog.harness} offers: ${answer.code}`);
      else if (answer.body.recorded !== true) options.log(`the Deployment did not record the models ${catalog.harness} offers: ${typeof answer.body.reason === 'string' ? answer.body.reason : 'no reason given'}`);
    }).finally(() => { sending = false; });
  };

  return {
    due() {
      if (stopping.signal.aborted || harnesses.length === 0) return;
      if (sending) return;
      const next = waiting[0];
      if (next !== undefined) { sendNow(next); return; }
      if (!listing && (listedAt === null || options.clock() - listedAt >= MODEL_CATALOG_REFRESH_MS)) listNow();
    },
    reconcile(next) {
      if (harnesses.length === next.length && harnesses.every((id, index) => id === next[index])) return;
      generation += 1;
      listingStop.abort();
      listingStop = new AbortController();
      harnesses = [...next];
      waiting = [];
      failed.clear();
      listedAt = null;
      listing = false;
    },
    async stop() { stopping.abort(); listingStop.abort(); await Promise.all(activeListings); },
  };
}
