import { SEARCH_MAX_TERMS, SEARCH_WORD_CEILING } from '@goondocks/myco-shared/search-types';
import type { RelationalStore } from './adapters.js';
import { wordFrequencies, wordPostings } from '../db/search/relevance.js';
import { docIdRange, documentKinds, SearchRefused, projectExpression, kindExpression, type DocumentKind, type SearchRequest } from './search-query.js';

/** Select distinct words and admit candidate selection against capped per-kind frequencies. */
export async function selectSearchWords(db: RelationalStore, projects: readonly string[], request: SearchRequest, options: { held?: readonly string[]; probe: boolean; highs?: Partial<Record<DocumentKind, number>> }): Promise<void> {
  const { held } = options;
  if (held !== undefined && (held.length > SEARCH_MAX_TERMS || new Set(held).size !== held.length || held.some((term) => !request.sourceTerms.includes(term)))) {
    throw new SearchRefused('cursor_foreign', 'cursor words do not belong to this search: request the first page again without a cursor');
  }
  const terms = held ?? request.sourceTerms;
  const kinds = documentKinds(request);
  const counts = held === undefined && request.wordTruncation !== undefined
    ? await wordFrequencies(db, { scope: projectExpression(projects), prefixes: kinds.map((kind) => kindExpression(kind, request)), terms, ...docIdRange(request.filters), limit: SEARCH_WORD_CEILING + 1 })
    : [];
  const frequencies = Object.fromEntries(kinds.map((kind, k) => [kind, new Map(terms.map((term, t) => [term, counts[k]?.[t] ?? 0]))]));
  request.frequencies = frequencies;
  const selected = held ?? (request.wordTruncation === undefined ? terms : terms.map((term, index) => ({ term, index,
    count: kinds.reduce((sum, kind) => sum + frequencies[kind]!.get(term)!, 0) }))
    .sort((a, b) => a.count - b.count || a.index - b.index).slice(0, SEARCH_MAX_TERMS).sort((a, b) => a.index - b.index).map(({ term }) => term));
  if (options.probe) {
    const range = docIdRange(request.filters);
    const matches = await wordPostings(db, { scope: projectExpression(projects), prefixes: kinds.map((kind) => ({ expression: kindExpression(kind, request), high: options.highs?.[kind] ?? range.high })),
      terms: selected, ...range, limit: SEARCH_WORD_CEILING + 1 });
    request.wordMatches = Object.fromEntries(kinds.map((kind, k) => [kind, new Map(selected.map((term, t) => [term, matches[k]![t]!]))]));
    request.frequencies = Object.fromEntries(kinds.map((kind, k) => [kind, new Map(selected.map((term, t) => [term, matches[k]![t]!.ids.size]))]));
  }
  request.terms = [...selected];
  request.words = selected.map((term) => term.slice(1, -1).replace(/""/g, '"'));
  if (request.wordTruncation !== undefined) request.wordTruncation = { actual: request.sourceTerms.length, searched: selected.length, words: request.words };
  if (options.probe) request.candidateWords = kinds.flatMap((kind) => {
    const omitted = selected.filter((term) => request.frequencies?.[kind]?.get(term)! > SEARCH_WORD_CEILING).map((term) => term.slice(1, -1).replace(/""/g, '"'));
    return omitted.length === 0 ? [] : [{ kind, omitted }];
  });
}
