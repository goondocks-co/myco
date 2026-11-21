import { SEARCH_MAX_TERMS } from '@goondocks/myco-shared/search-types';
import type { RelationalStore } from './adapters.js';
import { wordFrequencies } from '../db/search/relevance.js';
import { docIdRange, documentKinds, SearchRefused, windowExpression, type SearchRequest } from './search-query.js';

/** A frequency probe distinguishes rare words without counting every match of a common one. */
const FREQUENCY_PROBE = SEARCH_MAX_TERMS + 1;

/** Shorten long questions by scoped, capped document frequency, keeping original order among equally common words. */
export async function selectSearchWords(db: RelationalStore, projects: readonly string[], request: SearchRequest, held?: readonly string[]): Promise<void> {
  if (request.wordTruncation === undefined) return;
  if (held !== undefined && (held.length !== SEARCH_MAX_TERMS || held.some((term) => !request.sourceTerms.includes(term)))) {
    throw new SearchRefused('cursor_foreign', 'cursor words do not belong to this search: request the first page again without a cursor');
  }
  let selected = held;
  if (selected === undefined) {
    const terms = [...new Set(request.terms)];
    const kinds = documentKinds(request);
    const range = docIdRange(request.filters);
    const matches = terms.flatMap((term) => kinds.map((kind) => windowExpression(kind, projects, request, [term])));
    const found = await wordFrequencies(db, { matches, ...range, limit: FREQUENCY_PROBE });
    const frequency = new Map(terms.map((term, t) => [term, Math.min(FREQUENCY_PROBE,
      kinds.reduce((count, _, k) => count + found[t * kinds.length + k]!, 0))]));
    selected = request.terms.map((term, index) => ({ term, index }))
      .sort((a, b) => frequency.get(a.term)! - frequency.get(b.term)! || a.index - b.index)
      .slice(0, SEARCH_MAX_TERMS).sort((a, b) => a.index - b.index).map(({ term }) => term);
  }
  request.terms = [...selected];
  request.words = selected.map((term) => term.slice(1, -1).replace(/""/g, '"').toLowerCase());
  request.wordTruncation.words = request.words;
}
