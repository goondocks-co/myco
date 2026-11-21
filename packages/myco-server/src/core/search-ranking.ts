import type { RelationalStore } from './adapters.js';
import { documentOrdering, documentsOfPlans, plansOfDocuments, readWindows, type WindowRead } from '../db/search/documents.js';
import { windowPresence, windowMatches } from '../db/search/relevance.js';
import { SEARCH_WORD_CEILING, SEARCH_RELEVANCE_WEIGHTS } from '@goondocks/myco-shared/search-types';
import { docIdRange, kindExpression, projectExpression, windowExpression, headlineExpression, textExpression, type DocumentKind, type SearchRequest } from './search-query.js';

/** A kind's remaining historical walk and the global candidates it must not repeat. */
export interface KindWindow { low: number; partial: boolean; excluded?: number[]; resume?: number; anchor?: string; omitted?: string[] }

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
  fences: Partial<Record<DocumentKind, number>>;
  /** Each id's score in [0, 1]. */
  scores: Map<number, number>;
}

/** Each kind's share of a window of `size` matches. */
const windowShare = (size: number, kinds: number) => Math.max(1, Math.floor(size / Math.max(1, kinds)));

/**
 * Ranks candidates admitted by capped scoped frequencies; a continuation ranks the remaining newest matches below its fence. A plan holds
 * a match its title, its inline text and its stored body's chunks hold together: with several words, each word's plan and chunk matches are read
 * too, and a plan every word reached joins the window as the newest of its documents that did.
 */
export async function rankWindow(db: RelationalStore, projects: readonly string[], request: SearchRequest,
  options: { highs: Partial<Record<DocumentKind, number>>; previous?: Partial<Record<DocumentKind, KindWindow>>; listed?: readonly number[] }): Promise<RankedWindow> {
  const { highs, previous = {} } = options;
  const older = options.previous !== undefined;
  const kinds = Object.keys(highs) as DocumentKind[];
  const share = windowShare(request.window, kinds.length);
  const { low } = docIdRange(request.filters);
  const selection = (kind: DocumentKind, terms: readonly string[], limit: number, strategy: 'admitted' | 'newest' = 'admitted') => {
    const frequencies = request.frequencies?.[kind];
    const rarest = [...terms].sort((a, b) => (frequencies?.get(a) ?? 0) - (frequencies?.get(b) ?? 0))[0]!;
    const eligible = terms.filter((term) => (frequencies?.get(term) ?? 0) <= SEARCH_WORD_CEILING);
    const relevant = strategy === 'admitted' && !older && eligible.length > 0;
    const anchor = terms.length === 1 ? terms[0]! : previous[kind]?.anchor ?? rarest;
    const chosen = request.match === 'all' ? [anchor] : relevant ? eligible : terms;
    const capacity = relevant ? SEARCH_WORD_CEILING * (request.match === 'all' ? 1 : eligible.length) + (limit - 1) : older || strategy === 'admitted' ? limit - 1 : Math.min(limit - 1, SEARCH_WORD_CEILING);
    const expression = `${kindExpression(kind, request)} AND {headline body}:(${chosen.join(' OR ')})`;
    const read: WindowRead = { match: older ? windowExpression(kind, projects, request, terms) : `${projectExpression(projects)} AND ${expression}`, low, high: highs[kind]!,
      limit: capacity + 1, direction: 'newest', excluded: previous[kind]?.excluded };
    const prefixes = terms.map((term) => [...(request.wordMatches?.[kind]?.get(term)?.ids ?? [])]);
    const cutoff = Math.max(low, ...prefixes.map((ids) => ids.at(-1) ?? low));
    return { read, expression, cutoff, head: Math.max(low, ...prefixes.map((ids) => ids[0] ?? low)), terms: chosen, prefix: kindExpression(kind, request), kind, relevant, capacity, limit: limit - 1, anchor, omitted: request.match === 'any' && chosen.length < terms.length };
  };
  const selections = kinds.map((kind) => selection(kind, request.terms, share + 1));
  const planKinds = (['plan', 'chunk'] as const).filter((kind) => kinds.includes(kind));
  const perWord = planKinds.length > 0 && request.match === 'all' && request.terms.length > 1;
  const wordShare = Math.max(1, Math.floor(share / request.terms.length));
  if (perWord) for (const term of request.terms) for (const kind of planKinds) selections.push(selection(kind, [term], wordShare + 1, 'newest'));
  const newest = older ? [] : (await readWindows(db, kinds.map((kind) => ({ match: windowExpression(kind, projects, request), low, high: highs[kind]!, limit: share + 1, direction: 'newest' as const })))).windows;
  const raw = older ? (await readWindows(db, selections.map((s) => s.read))).windows : selections.map((s, i) => {
    if (i < kinds.length && !s.relevant) return newest[i]!;
    const words = request.match === 'all' && !s.relevant && i < kinds.length ? request.terms : s.terms;
    const lists = words.map((term) => [...(request.wordMatches?.[s.kind]?.get(term)?.ids ?? [])]);
    const ids = [...new Set(lists.flat())].sort((a, b) => b - a);
    const matches = request.match === 'all' && !s.relevant && i < kinds.length
      ? ids.filter((id) => id >= s.cutoff && lists.every((list) => list.includes(id))) : ids;
    if (i < kinds.length) return [...new Set([...matches, ...newest[i]!.slice(0, share)])].sort((a, b) => b - a).slice(0, s.capacity + 1);
    return matches.slice(0, s.capacity + 1);
  });
  const held = await documentOrdering(db, options.listed ?? []);
  const full = request.match === 'all' && !older ? await windowMatches(db, { scope: projectExpression(projects),
    windows: kinds.map((kind, i) => ({ expression: `${kindExpression(kind, request)} AND {headline body}:(${request.terms.join(' AND ')})`, ids: selections[i]!.relevant ? raw[i]! : [] })) }) : [];
  const found = raw.map((rows, i) => rows.slice(0, selections[i]!.capacity).filter((id) => i >= kinds.length || older || !selections[i]!.relevant || request.match !== 'all' || full[i]!.has(id)));
  const window: RankedWindow = { entries: [], kinds: {}, fences: {}, scores: new Map<number, number>() };
  const byKind = new Map<DocumentKind, number[]>();
  kinds.forEach((kind, i) => {
    const selected = selections[i]!;
    const candidates = found[i]!;
    const listed = [...held].filter(([, doc]) => doc.kind === kind).map(([id]) => id);
    byKind.set(kind, [...new Set([...candidates, ...listed])]);
    window.kinds[kind] = { low: selected.relevant ? low : raw[i]!.slice(0, selected.capacity).at(-1) ?? low,
      partial: found[i]!.length > share || raw[i]!.length > selected.capacity || selected.omitted || (!older && newest[i]!.length > share),
      anchor: selected.anchor, omitted: older ? previous[kind]?.omitted : request.candidateWords?.find((entry) => entry.kind === kind)?.omitted, excluded: [...new Set([...(previous[kind]?.excluded ?? []), ...listed])],
      ...(selected.relevant ? { resume: highs[kind]! } : {}) };
    window.fences[kind] = selected.relevant ? highs[kind]! : raw[i]![0] ?? selected.head ?? highs[kind]!;
  });
  if (perWord) {
    const words = request.terms.map((_, t) => planKinds.map((kind, k) => ({ kind, ids: found[kinds.length + t * planKinds.length + k]!, partial: raw[kinds.length + t * planKinds.length + k]!.length > selections[kinds.length + t * planKinds.length + k]!.capacity })));
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
      window.kinds[w.kind] = { ...held, low: held.resume === undefined ? older ? Math.min(held.low, w.ids.slice(0, wordShare).at(-1) ?? held.low) : held.low : low, partial: held.partial || w.ids.length > wordShare || w.partial };
    }
  }
  const scoreIds = new Set([...byKind.values()].flat());
  const scored = new Set<number>();
  const windows = selections.flatMap((s, i) => {
    const ids = raw[i]!.filter((id) => scoreIds.has(id) && !scored.has(id));
    for (const id of ids) scored.add(id);
    return ids.length ? [{ kind: s.kind, expression: s.expression, prefix: s.prefix, terms: s.terms, ids }] : [];
  });
  window.scores = await presenceScores(db, [...scoreIds], older ? { ...request, wordMatches: undefined } : request, { scope: projectExpression(projects), windows });
  const order = await documentOrdering(db, [...scoreIds]);
  const compare = (a: number, b: number) => window.scores.get(b)! - window.scores.get(a)! || (order.get(b)?.at ?? 0) - (order.get(a)?.at ?? 0)
    || ((order.get(a)?.key ?? '') < (order.get(b)?.key ?? '') ? -1 : (order.get(a)?.key ?? '') > (order.get(b)?.key ?? '') ? 1 : 0);
  for (const [kind, pool] of byKind) {
    const selected = (selections[kinds.indexOf(kind)]!.relevant ? pool.sort(compare) : pool).slice(0, share);
    byKind.set(kind, [...new Set([...selected, ...[...held].filter(([, doc]) => doc.kind === kind).map(([id]) => id)])]);
    if (!older || window.kinds[kind]!.resume !== undefined) window.kinds[kind]!.excluded = [...new Set([...(window.kinds[kind]!.excluded ?? []), ...selected])];
  }
  const ranked = [...new Set([...byKind.values()].flat())].sort(compare);
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
 * A word anywhere in the text counts at half a headline's weight.
 */
async function presenceScores(db: RelationalStore, ids: readonly number[], request: SearchRequest, windows: { scope: string; windows: { kind: DocumentKind; expression: string; prefix: string; terms: readonly string[]; ids: number[] }[] }): Promise<Map<number, number>> {
  const scores = new Map(ids.map((id) => [id, 0]));
  if (ids.length === 0) return scores;
  const present = request.terms.map(() => ({ headline: new Set<number>(), text: new Set<number>() }));
  if (request.wordMatches === undefined) {
    const looked = (await readWindows(db, [], request.terms.flatMap((term) => [{ match: headlineExpression(term), ids }, { match: textExpression(term), ids }]))).lookups;
    request.terms.forEach((_, t) => { present[t] = { headline: looked[t * 2]!, text: looked[t * 2 + 1]! }; });
  } else {
    const candidates = new Set(ids);
    request.terms.forEach((term, t) => {
      for (const byTerm of Object.values(request.wordMatches!)) {
        const match = byTerm?.get(term);
        for (const id of match?.ids ?? []) if (candidates.has(id)) present[t]!.text.add(id);
        for (const id of match?.headline ?? []) if (candidates.has(id)) present[t]!.headline.add(id);
      }
    });
    const missing = windows.windows.flatMap((window) => {
      const targets = request.terms.filter((term) => {
        const match = request.wordMatches?.[window.kind]?.get(term);
        return (match?.ids.size ?? 0) > SEARCH_WORD_CEILING && window.ids.some((id) => id < Math.min(...match!.ids));
      });
      return targets.length ? [{ ...window, targets }] : [];
    });
    // The bounded lookup reads only records holding one of the window's less common words; a window that also ranks newest matches is looked up directly.
    const bounded = (window: typeof missing[number]) => {
      const own = new Set(window.terms.filter((term) => (request.frequencies?.[window.kind]?.get(term) ?? 0) <= SEARCH_WORD_CEILING)
        .flatMap((term) => [...(request.wordMatches?.[window.kind]?.get(term)?.ids ?? [])]));
      return own.size > 0 && window.ids.every((id) => own.has(id));
    };
    const ranges = missing.filter(bounded);
    if (ranges.length) {
      const looked = await windowPresence(db, { scope: windows.scope, windows: ranges, terms: request.terms });
      looked.forEach((match, t) => { for (const id of match.headline) present[t]!.headline.add(id); for (const id of match.text) present[t]!.text.add(id); });
    }
    const direct = missing.filter((window) => !bounded(window)).flatMap((window) => window.targets.flatMap((term) => [
      { term, field: 'headline' as const, match: headlineExpression(term), ids: window.ids },
      { term, field: 'text' as const, match: textExpression(term), ids: window.ids },
    ]));
    if (direct.length) {
      const looked = (await readWindows(db, [], direct)).lookups;
      direct.forEach((lookup, i) => { for (const id of looked[i]!) present[request.terms.indexOf(lookup.term)]![lookup.field].add(id); });
    }
  }
  let best = 0;
  request.terms.forEach((_, t) => {
    const headline = present[t]!.headline;
    const text = present[t]!.text;
    const holders = request.match === 'all' ? headline : text;
    const weight = Math.log(1 + ids.length / (1 + holders.size));
    best += weight * (SEARCH_RELEVANCE_WEIGHTS.headline + SEARCH_RELEVANCE_WEIGHTS.body);
    for (const id of ids) scores.set(id, scores.get(id)! + weight * ((headline.has(id) ? SEARCH_RELEVANCE_WEIGHTS.headline : 0) + (text.has(id) ? SEARCH_RELEVANCE_WEIGHTS.body : 0)));
  });
  if (best > 0) for (const id of ids) scores.set(id, scores.get(id)! / best);
  return scores;
}
