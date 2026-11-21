import type { RelationalStore } from './adapters.js';
import { documentOrdering, documentsOfPlans, plansOfDocuments, readWindows, type WindowRead } from '../db/search/documents.js';
import { relevanceWindows } from '../db/search/relevance.js';
import { docIdRange, headlineExpression, textExpression, windowExpression, type DocumentKind, type SearchRequest } from './search-query.js';

/** A kind's remaining historical walk and the global candidates it must not repeat. */
export interface KindWindow { low: number; partial: boolean; excluded?: number[]; resume?: number }

/**
 * One ranked document. A plan's own document or a chunk of its body names the plans it lists: a plan is listed once, at
 * its best-ranked document, so its other documents list nothing for it.
 */
export interface RankedEntry { id: number; plans?: string[] }

/** A plan key as a stable 32-bit number (FNV-1a, never 0), so an entry is named by numbers alone. */
export function planHash(plan: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < plan.length; i += 1) hash = Math.imul(hash ^ plan.charCodeAt(i), 0x01000193) >>> 0;
  return hash === 0 ? 1 : hash;
}

/** One ranked entry's name: its document, and the plan it lists when it lists one (0 when it lists none). */
export function entryKey(entry: RankedEntry): [number, number] {
  return [entry.id, entry.plans === undefined ? 0 : planHash(entry.plans[0]!)];
}

export interface RankedWindow {
  /** The window's documents in rank order. */
  entries: RankedEntry[];
  /** Each kind's walk after this window. */
  kinds: Partial<Record<DocumentKind, KindWindow>>;
  /** Each id's score in [0, 1]. */
  scores: Map<number, number>;
}

/** Each kind's share of a window of `size` matches. */
const windowShare = (size: number, kinds: number) => Math.max(1, Math.floor(size / Math.max(1, kinds)));

/**
 * Ranks global FTS5 candidates first; a continuation ranks the remaining newest matches below its fence. A plan holds
 * a match its title, its inline text and its stored body's chunks hold together: with several words, each word's plan and chunk matches are read
 * too, and a plan every word reached joins the window as the newest of its documents that did.
 */
export async function rankWindow(db: RelationalStore, projects: readonly string[], request: SearchRequest,
  options: { highs: Partial<Record<DocumentKind, number>>; previous?: Partial<Record<DocumentKind, KindWindow>> }): Promise<RankedWindow> {
  const { highs, previous = {} } = options;
  const older = options.previous !== undefined;
  const kinds = Object.keys(highs) as DocumentKind[];
  const share = windowShare(request.window, kinds.length);
  const { low } = docIdRange(request.filters);
  const reads: WindowRead[] = kinds.map((kind) => ({ match: windowExpression(kind, projects, request), low, high: highs[kind]!, limit: share + 1, direction: 'newest', excluded: previous[kind]?.excluded }));
  const planKinds = (['plan', 'chunk'] as const).filter((kind) => kinds.includes(kind));
  const perWord = planKinds.length > 0 && request.match === 'all' && request.terms.length > 1;
  const wordShare = Math.max(1, Math.floor(share / request.terms.length));
  if (perWord) {
    for (const term of request.terms) for (const kind of planKinds) {
      reads.push({ match: windowExpression(kind, projects, request, [term]), low, high: highs[kind]!, limit: wordShare + 1, direction: 'newest', excluded: previous[kind]?.excluded });
    }
  }
  const global = older ? null : await relevanceWindows(db, reads);
  const found = global === null ? (await readWindows(db, reads)).windows : global.map((rows) => rows.map((row) => Number(row.doc_id)));
  const relevance = new Map<number, number>();
  for (const rows of global ?? []) for (const row of rows) relevance.set(Number(row.doc_id), Math.max(relevance.get(Number(row.doc_id)) ?? 0, -Number(row.relevance)));
  const window: RankedWindow = { entries: [], kinds: {}, scores: new Map() };
  const byKind = new Map<DocumentKind, number[]>();
  kinds.forEach((kind, i) => {
    const ids = found[i]!.slice(0, share);
    byKind.set(kind, ids);
    window.kinds[kind] = { low: older ? ids.at(-1) ?? low : low, partial: found[i]!.length > share,
      ...(older ? { excluded: previous[kind]?.excluded } : { resume: highs[kind]!, excluded: ids }) };
  });
  if (perWord) {
    const words = request.terms.map((_, t) => planKinds.map((kind, k) => ({ kind, ids: found[kinds.length + t * planKinds.length + k]! })));
    const reached = words.flat().flatMap((w) => w.ids.slice(0, wordShare));
    const plans = await plansOfDocuments(db, reached);
    const perTerm = words.map((w) => new Set(w.flatMap(({ ids }) => ids.slice(0, wordShare)).flatMap((id) => plans.get(id) ?? [])));
    const listed = new Set([...(byKind.get('plan') ?? []), ...(byKind.get('chunk') ?? [])].flatMap((id) => plans.get(id) ?? []));
    const newest = new Map<string, { id: number; kind: DocumentKind }>();
    for (const w of words.flat()) for (const id of w.ids.slice(0, wordShare)) for (const plan of plans.get(id) ?? []) {
      if (listed.has(plan) || !perTerm.every((set) => set.has(plan))) continue;
      if ((newest.get(plan)?.id ?? -1) < id) newest.set(plan, { id, kind: w.kind });
    }
    for (const { id, kind } of newest.values()) byKind.set(kind, [...byKind.get(kind)!, id]);
    for (const w of words.flat()) {
      const held = window.kinds[w.kind]!;
      window.kinds[w.kind] = { ...held, low: older ? Math.min(held.low, w.ids.slice(0, wordShare).at(-1) ?? held.low) : low, partial: held.partial || w.ids.length > wordShare };
    }
  }
  const ids = [...new Set([...byKind.values()].flat())];
  if (global === null) window.scores = await presenceScores(db, ids, request);
  else {
    const best = Math.max(0, ...relevance.values());
    window.scores = new Map(ids.map((id) => [id, best === 0 ? 0 : (relevance.get(id) ?? 0) / best]));
    for (const [kind, selected] of byKind) window.kinds[kind]!.excluded = [...new Set([...(window.kinds[kind]!.excluded ?? []), ...selected])];
  }
  const order = await documentOrdering(db, ids);
  const at = (id: number) => order.get(id)?.at ?? 0;
  const key = (id: number) => order.get(id)?.key ?? '';
  const ranked = ids.sort((a, b) => window.scores.get(b)! - window.scores.get(a)! || at(b) - at(a) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const planIds = new Set(planKinds.flatMap((kind) => byKind.get(kind) ?? []));
  const plans = await plansOfDocuments(db, [...planIds]);
  // On an older window, a plan one of whose matching documents lies above this window's fence was listed by a newer one.
  const listedAbove = new Set<string>();
  if (older) {
    const excludedPlans = await plansOfDocuments(db, Object.values(previous).flatMap((kind) => kind?.excluded ?? []));
    for (const owned of excludedPlans.values()) for (const plan of owned) listedAbove.add(plan);
    const matching = await matchingPlanDocuments(db, projects, request, [...new Set([...plans.values()].flat())]);
    for (const [plan, docs] of matching) if (docs.some((doc) => doc.doc_id > (highs[doc.kind] ?? -1))) listedAbove.add(plan);
  }
  const owned = new Set<string>();
  for (const id of ranked) {
    if (!planIds.has(id)) { window.entries.push({ id }); continue; }
    const mine = (plans.get(id) ?? []).filter((plan) => !listedAbove.has(plan) && !owned.has(plan));
    // One entry per plan, so a page never cuts the plans of a shared body short.
    for (const plan of mine) { owned.add(plan); window.entries.push({ id, plans: [plan] }); }
  }
  return window;
}

/**
 * Each plan's documents (its own and its body's chunks) that match the request, as the plan and chunk windows match them,
 * within the request's time range.
 */
export async function matchingPlanDocuments(db: RelationalStore, projects: readonly string[], request: SearchRequest, plans: readonly string[]):
  Promise<Map<string, { doc_id: number; kind: 'plan' | 'chunk' }[]>> {
  const range = docIdRange(request.filters);
  const docs = (await documentsOfPlans(db, plans)).filter((doc) => doc.doc_id >= range.low && doc.doc_id <= range.high);
  const kinds = (['plan', 'chunk'] as const).map((kind) => ({ kind, ids: docs.filter((doc) => doc.kind === kind).map((doc) => doc.doc_id) })).filter((k) => k.ids.length > 0);
  const present = (await readWindows(db, [], kinds.map(({ kind, ids }) => ({ match: windowExpression(kind, projects, request), ids })))).lookups;
  const matched = new Set(kinds.flatMap((_, i) => [...present[i]!]));
  const found = new Map<string, { doc_id: number; kind: 'plan' | 'chunk' }[]>();
  for (const doc of docs) if (matched.has(doc.doc_id)) found.set(doc.plan, [...(found.get(doc.plan) ?? []), { doc_id: doc.doc_id, kind: doc.kind }]);
  return found;
}

/**
 * Each id's score from the words its headline holds, weighted by how few of the window's headlines hold each word.
 * Matching any word, a word anywhere in the text counts too, at half a headline's weight.
 */
async function presenceScores(db: RelationalStore, ids: readonly number[], request: SearchRequest): Promise<Map<number, number>> {
  const scores = new Map(ids.map((id) => [id, 0]));
  if (ids.length === 0) return scores;
  const lookups = request.terms.flatMap((term) => [
    { match: headlineExpression(term), ids },
    ...(request.match === 'any' ? [{ match: textExpression(term), ids }] : []),
  ]);
  const present = (await readWindows(db, [], lookups)).lookups;
  const step = request.match === 'any' ? 2 : 1;
  let best = 0;
  request.terms.forEach((_, t) => {
    const headline = present[t * step]!;
    const text = request.match === 'any' ? present[t * step + 1]! : null;
    const holders = text ?? headline;
    const weight = Math.log(1 + ids.length / (1 + holders.size));
    best += weight * (text === null ? 1 : 3);
    for (const id of ids) scores.set(id, scores.get(id)! + weight * ((headline.has(id) ? (text === null ? 1 : 2) : 0) + (text?.has(id) ? 1 : 0)));
  });
  if (best > 0) for (const id of ids) scores.set(id, scores.get(id)! / best);
  return scores;
}
