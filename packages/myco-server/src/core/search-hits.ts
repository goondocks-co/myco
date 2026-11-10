import { displayPrompt } from '@goondocks/myco-shared/prompt-text';
import { SEARCH_PREVIEW_CHARS, SEARCH_WINDOW, type ReleaseAnnotation, type SearchAcrossResult, type SearchType } from '@goondocks/myco-shared/search-types';
import type { RelationalStore } from './adapters.js';
import { hydrateDocuments, type HydratedDocument, type HydrationFilters } from '../db/search/hydration.js';
import { getReleaseStatesAcross, type ReleaseNamespace } from './provenance.js';
import type { SearchRequest } from './search-query.js';
import type { RankedEntry } from './search-ranking.js';

/**
 * A page of hits from ranked documents. Each document is read back with its record and kept only as it is now: its
 * Project is one the reader reaches, its session is not deleted, a chunk still belongs to a live plan through a proved
 * reference, and it meets every filter its window could not apply. A plan or chunk lists only the plans its entry names,
 * so a plan is one hit. The walk reads batches until the page is full, never past `SEARCH_WINDOW` documents, and reads
 * text only for the hits it keeps.
 */
export interface PageInput {
  db: RelationalStore;
  projects: readonly string[];
  request: SearchRequest;
  scores: ReadonlyMap<number, number> | null;
}

/** Documents one read checks after a page's first. */
export const SEARCH_PAGE_BATCH = 100;
/** How much of a record's text a snippet is cut from, starting a little before the first word matched. */
const SNIPPET_SOURCE_CHARS = 2_000;
const TOOLS: Partial<Record<SearchType, string>> = { session: 'myco_sessions', spore: 'myco_spores', plan: 'myco_plans' };

/** A hit's identity: a card's turn key names a turn only within its session. */
const hitKey = (doc: HydratedDocument) => JSON.stringify([typeOf(doc), doc.project_id, doc.kind === 'card' ? doc.session_id : null, doc.id]);

function filtersOf({ projects, request }: PageInput): HydrationFilters {
  const { filters } = request;
  return {
    projects, agent: filters.agent, branch: filters.branch, status: filters.status, session: filters.session_id,
    sinceMs: filters.since === undefined ? undefined : filters.since * 1000, untilMs: filters.until === undefined ? undefined : filters.until * 1000,
  };
}

/**
 * Hits from `entries` starting at `from`, the position after the last document examined, and the documents listed. An
 * entry's hits stay on one page: an entry that would overflow a page that already holds hits waits for the next.
 */
export async function pageOfHits(input: PageInput, entries: readonly RankedEntry[], from: number): Promise<{ hits: SearchAcrossResult[]; next: number; listed: Set<number> }> {
  const { request } = input;
  const filters = filtersOf(input);
  const kept: { doc: HydratedDocument; release: ReleaseAnnotation | undefined }[] = [];
  const seen = new Set<string>();
  const listed = new Set<number>();
  let position = from;
  const stop = Math.min(entries.length, from + SEARCH_WINDOW);
  let full = false;
  while (!full && kept.length < request.limit && position < stop) {
    // The first batch is a page and one more, enough when the filters admit most documents; later batches are fixed.
    const size = position === from ? Math.min(SEARCH_PAGE_BATCH, request.limit + 1) : SEARCH_PAGE_BATCH;
    const batch = entries.slice(position, Math.min(stop, position + size));
    const docs = await hydrateDocuments(input.db, batch.map((entry) => entry.id), filters, { chars: 0, word: null });
    const rowsOf = (entry: RankedEntry) => (docs.get(entry.id) ?? []).filter((doc) => entry.plans === undefined || entry.plans.includes(doc.plan ?? ''));
    const releases = releaseFiltered(request) ? await releaseOf(input.db, batch.flatMap(rowsOf)) : new Map<string, ReleaseAnnotation>();
    let consumed = 0;
    for (const entry of batch) {
      const rows = rowsOf(entry).map((doc) => ({ doc, release: releases.get(releaseKey(doc)) }))
        .filter(({ doc, release }) => releaseAdmitted(release, request) && !seen.has(hitKey(doc)));
      if (kept.length > 0 && kept.length + rows.length > request.limit) { full = true; break; }
      consumed += 1;
      for (const row of rows) { seen.add(hitKey(row.doc)); kept.push(row); }
      if (rows.length > 0) listed.add(entry.id);
      if (kept.length >= request.limit) break;
    }
    position += consumed;
  }
  const page = kept.slice(0, request.limit);
  const texts = await hydrateDocuments(input.db, [...new Set(page.map(({ doc }) => doc.doc_id))], filters, { chars: SNIPPET_SOURCE_CHARS, word: request.words[0] ?? null });
  const releases = releaseFiltered(request) ? null : await releaseOf(input.db, page.map(({ doc }) => doc));
  return {
    hits: page.map(({ doc, release }) => hitOf({ ...doc, ...textFor(doc, texts) }, input, releases === null ? release : releases.get(releaseKey(doc)))),
    next: position,
    listed,
  };
}

/** The text read for `doc`, from the row of the same document and plan. */
function textFor(doc: HydratedDocument, texts: ReadonlyMap<number, HydratedDocument[]>): Pick<HydratedDocument, 'text' | 'text_start'> {
  const row = (texts.get(doc.doc_id) ?? []).find((candidate) => candidate.plan === doc.plan);
  return { text: row?.text ?? null, text_start: row?.text_start ?? null };
}

const typeOf = (doc: HydratedDocument): SearchType => (doc.kind === 'chunk' ? 'plan' : doc.kind);

const releaseKey = (doc: HydratedDocument) => JSON.stringify([doc.project_id, typeOf(doc), doc.id]);

const releaseFiltered = (request: SearchRequest) => request.filters.release_state !== undefined || request.filters.release_confidence !== undefined;

function releaseAdmitted(release: ReleaseAnnotation | undefined, request: SearchRequest): boolean {
  const { release_state: state, release_confidence: confidence } = request.filters;
  if (state === undefined && confidence === undefined) return true;
  return release !== undefined && (state === undefined || release.state === state) && (confidence === undefined || release.confidence === confidence);
}

/** Each document's release state, one batched read per Project and namespace present. */
async function releaseOf(db: RelationalStore, docs: readonly HydratedDocument[]): Promise<Map<string, ReleaseAnnotation>> {
  const groups = new Map<string, { projectId: string; namespace: ReleaseNamespace; recordIds: string[] }>();
  for (const doc of docs) {
    const namespace = typeOf(doc);
    if (namespace === 'card') continue;
    const key = JSON.stringify([doc.project_id, namespace]);
    const group = groups.get(key) ?? { projectId: doc.project_id, namespace, recordIds: [] };
    group.recordIds.push(doc.id);
    groups.set(key, group);
  }
  const wanted = [...groups.values()];
  const answers = await getReleaseStatesAcross(db, wanted);
  const states = new Map<string, ReleaseAnnotation>();
  wanted.forEach((w, i) => {
    for (const [id, row] of Object.entries(answers[i] ?? {})) {
      states.set(JSON.stringify([w.projectId, w.namespace, id]),
        { state: row.state, confidence: row.confidence, ref: row.basisRef, checked_at: row.checkedAt, ...(row.propagating ? { propagating: true } : {}) });
    }
  });
  return states;
}

function hitOf(doc: HydratedDocument, input: PageInput, release: ReleaseAnnotation | undefined): SearchAcrossResult {
  const type = typeOf(doc);
  const conversational = type === 'session' || type === 'card';
  const rawTitle = type === 'session' ? (doc.title || `Session ${doc.id.slice(-6)}`)
    : type === 'plan' ? (doc.title || 'Plan') : type === 'card' ? (doc.title || 'Turn') : (doc.title ?? '');
  const text = doc.text ?? (type === 'session' ? doc.title : null);
  const preview = doc.line !== null && doc.line !== '' ? doc.line : snippet(text ?? '', input.request.words, (doc.text_start ?? 1) > 1);
  const tool = TOOLS[type];
  return {
    projectId: doc.project_id,
    id: doc.id,
    type,
    title: conversational ? displayPrompt(rawTitle, doc.agent) : rawTitle,
    preview: (conversational ? displayPrompt(preview, doc.agent) : preview).slice(0, SEARCH_PREVIEW_CHARS),
    score: input.scores?.get(doc.doc_id) ?? 0,
    created_at: doc.created_at,
    ...(doc.session_id === null ? {} : { session_id: doc.session_id }),
    ...(doc.prompt_id === null ? {} : { prompt_id: doc.prompt_id }),
    ...(type === 'card' ? { turn: doc.turn_id === null ? null : { prompt_id: doc.turn_id, preview: doc.turn_preview, text_chars: doc.turn_chars, stored: false } } : {}),
    ...(tool === undefined ? {} : { retrieve: { tool, input: { op: 'get', id: doc.id } } }),
    ...(release === undefined ? {} : { release }),
  };
}

/** The text around the first word matched, or its start when none of the words appears as written; `cut` when the text read starts inside the record. */
function snippet(text: string, words: readonly string[], cut: boolean): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const at = Math.min(...words.map((word) => { const i = lower.indexOf(word); return i < 0 ? Infinity : i; }));
  if (!Number.isFinite(at) || at < SEARCH_PREVIEW_CHARS / 3) return cut ? `… ${flat.slice(0, SEARCH_PREVIEW_CHARS - 2)}` : flat.slice(0, SEARCH_PREVIEW_CHARS);
  const start = Math.max(0, at - Math.floor(SEARCH_PREVIEW_CHARS / 3));
  return `… ${flat.slice(start, start + SEARCH_PREVIEW_CHARS - 2)}`;
}
