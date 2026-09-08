/**
 * What the prompt hook is served: the spores that go into one prompt, and the
 * record of having served them.
 *
 * This module OWNS `spore_injections`. Its consumer is the member route
 * `POST /context/prompt` (#1026): the route calls the selector and hands the
 * rendered context to the hook. The `INSERT OR IGNORE` and the `meta.changes`
 * it answers from are the pattern `core/resume.ts` and `core/runs.ts` already
 * prove on both targets — the store decides, and the caller reads the decision
 * off the write.
 *
 * The record carries what 1.4 spreads across a status allowlist, a session-wide
 * exclusion set and a UNIQUE content hash, and the two rules hold to different
 * strengths:
 *
 * **A prompt's content is served once per session — structural.** The primary
 * key is `(project_id, session_id, prompt_hash)` and the insert is
 * `INSERT OR IGNORE`, so a prompt resubmitted with the same text serves nothing
 * a second time whatever the caller does.
 *
 * **A spore already served is out of the pool as of the last committed
 * record.** The exclusion set is a read, not a constraint: two prompts of one
 * session that arrive together both read the set before either writes, and each
 * may then serve the same spore. A repeated observation is the cost of leaving
 * the prompt hook off a lock.
 *
 * The row names a session and a prompt and holds NO foreign key to either. The
 * prompt hook answers before the prompt event lands on the server, so a record
 * may precede its prompt; a key to `sessions` or `prompt_batches` would refuse
 * the ordinary case. 1.4 falls through the same way under `no_batch`.
 *
 * Relevance uses Mutual Proximity over the current semantic candidates.
 */
import type { RelationalStore } from './adapters.js';
import { leafValues } from './settings.js';
import { listSporesByIds, type SporeRow } from './spores.js';
import { getPlan } from '../read/plans.js';
import type { ReadScope } from '../read/scope.js';
import { selectRelevantSpores } from '@goondocks/myco-shared/relevance';
import { semanticHits, type SemanticSearch } from '../read/embedding.js';
import { EmbeddingUnavailable } from './embedding/provider.js';
import { VECTOR_QUERY_LIMIT } from './embedding/vectors.js';

/** A prompt shorter than this carries too little to serve against. */
export const MIN_PROMPT_CHARS = 10;
/** The rendered block's ceiling in estimated tokens. */
export const INJECTION_BUDGET_TOKENS = 300;
/** The fewest items a prompt carrying any must serve, and what the per-line cap is derived from. */
export const INJECTION_MIN_ITEMS = 5;
/** The most items one prompt carries. Reached only where the lines run shorter than their cap. */
export const INJECTION_TARGET_ITEMS = 7;
/** The leaf defaults, applied where the Deployment has written none. */
export const INJECT_ON_PROMPT_SUBMIT_DEFAULT = true;
export const MAX_PER_PROMPT_DEFAULT = INJECTION_TARGET_ITEMS;
/** The widest selection an operator may ask for. */
export const MAX_PER_PROMPT_CEILING = 10;

/** Four characters to a token, the estimate 1.4 renders its budget against. */
const CHARS_PER_TOKEN = 4;
export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

const HEADER = 'Relevant project memory — retrieve any item in full by id:';
/** Emitted only where the pool held more than the budget served. */
const SEARCH_LINE = 'More may match — search with myco_search.';

/**
 * The budget arithmetic, derived rather than chosen.
 *
 * Every constant below follows from the token ceiling and the item floor, so a
 * change to either moves the caps with it and `injection.test.ts` fails the
 * pair that no longer fits. A cap picked by hand silently serves fewer items
 * than the floor: at four characters to a token a 200-character line costs 50
 * tokens, and five of those exhaust the ceiling.
 *
 * The cap divides the budget by the FLOOR, not the ceiling of seven. Dividing
 * by seven would buy a seventh item at the price of every line, cutting each to
 * roughly half a sentence; dividing by five keeps a line long enough to carry a
 * trigger and its guidance, and the fill rule still serves seven where the
 * lines happen to run short.
 */
const FIXED_TOKENS = estimateTokens(HEADER) + estimateTokens(`\n${SEARCH_LINE}`);
/** The most one rendered line may cost. */
export const MAX_LINE_TOKENS = Math.floor((INJECTION_BUDGET_TOKENS - FIXED_TOKENS) / INJECTION_MIN_ITEMS);
/** `estimateTokens` is `ceil(len / 4)`, so a line of this many characters costs exactly `MAX_LINE_TOKENS`. */
const MAX_LINE_CHARS = MAX_LINE_TOKENS * CHARS_PER_TOKEN;
/**
 * The `\n- [<id>] (<label>) ` a spore's line carries, which is what the text cap
 * is derived against. A plan key is a path and runs longer; its line costs more
 * and `itemsWithinBudget` drops it on the budget rather than on this number, so
 * a long key spends a plan's place and never the block's ceiling.
 */
const MAX_ID_CHARS = 32;
const MAX_LABEL_CHARS = 'plan: in_progress'.length;
const MAX_PREFIX_CHARS = '\n- ['.length + MAX_ID_CHARS + '] ('.length + MAX_LABEL_CHARS + ') '.length;

/** The most an item's text may carry, and the cut a fallback preview takes. */
export const AGENT_LINE_MAX_CHARS = MAX_LINE_CHARS - MAX_PREFIX_CHARS;
export const INJECTION_PREVIEW_CHARS = AGENT_LINE_MAX_CHARS;

/** The leaves this selector reads. */
export const INJECTION_LEAVES: readonly string[] = ['cortex.spores.inject_on_prompt_submit', 'cortex.spores.max_per_prompt'];

export interface InjectionLeaves {
  enabled: boolean;
  maxPerPrompt: number;
}

/** Why the selector served nothing. Null means it served what it selected. */
export type InjectionSkip = 'capability' | 'disabled' | 'short_prompt' | 'zero_max' | 'repeat' | 'empty' | 'provider_unavailable';

export interface InjectionSelection {
  items: InjectionItem[];
  context: string;
  skipped: InjectionSkip | null;
}

export interface InjectionRecord {
  promptId: string;
  promptHash: string;
  sporeIds: string[];
  planIds: string[];
  createdAt: number;
}

/** One prompt's record with the spores it named, in the order the record holds them. */
export interface PromptInjection {
  sporeIds: string[];
  createdAt: number;
  spores: Array<{ id: string; observationType: string; preview: string }>;
}

/** The selector's leaves over the stored values, each defaulted and the cap clamped to 0..10. */
export function injectionLeaves(leaves: Record<string, unknown>): InjectionLeaves {
  const enabled = leaves['cortex.spores.inject_on_prompt_submit'];
  const max = leaves['cortex.spores.max_per_prompt'];
  const asked = typeof max === 'number' && Number.isFinite(max) ? Math.floor(max) : MAX_PER_PROMPT_DEFAULT;
  return {
    enabled: typeof enabled === 'boolean' ? enabled : INJECT_ON_PROMPT_SUBMIT_DEFAULT,
    maxPerPrompt: Math.min(Math.max(asked, 0), MAX_PER_PROMPT_CEILING),
  };
}

const parse = (value: string | undefined): unknown => {
  if (value === undefined) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
};

/** The Deployment's stored injection leaves, defaulted. */
export async function readInjectionLeaves(db: RelationalStore): Promise<InjectionLeaves> {
  const byLeaf = await leafValues(db, INJECTION_LEAVES);
  return injectionLeaves(Object.fromEntries(INJECTION_LEAVES.map((leaf) => [leaf, parse(byLeaf.get(leaf))])));
}

/** One line of an item's text: whitespace folded, cut at the cap the budget derives. */
export function oneLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > AGENT_LINE_MAX_CHARS ? `${line.slice(0, AGENT_LINE_MAX_CHARS)}…` : line;
}

/**
 * One candidate for a prompt: what it is, how to fetch it, and what it says.
 *
 * A spore renders its `agent_line` where one is derived and the opening of its
 * observation where none is. The line is the projection an agent reads; the
 * Markdown behind it is for a person.
 */
export interface InjectionItem {
  kind: 'spore' | 'plan';
  id: string;
  label: string;
  text: string;
}

const itemLine = (item: InjectionItem): string => `\n- [${item.id}] (${item.label}) ${oneLine(item.text)}`;

/**
 * The items that fit, in the order given.
 *
 * The caller orders the candidates and this takes the longest prefix that fits
 * the budget and the item ceiling. Dropping from the tail IS the drop order —
 * the caller has already put plans after spores and the weakest score last — so
 * a line too long to fit costs itself and everything behind it rather than
 * silently reordering what remains.
 */
export function itemsWithinBudget(items: readonly InjectionItem[]): InjectionItem[] {
  const kept: InjectionItem[] = [];
  let tokens = estimateTokens(HEADER) + estimateTokens(`\n${SEARCH_LINE}`);
  for (const item of items) {
    if (kept.length === INJECTION_TARGET_ITEMS) break;
    const cost = estimateTokens(itemLine(item));
    if (tokens + cost > INJECTION_BUDGET_TOKENS) break;
    kept.push(item);
    tokens += cost;
  }
  return kept;
}

/**
 * The block a prompt is served: a header, one line per item carrying its id,
 * and the search line where the pool held more than the budget served.
 *
 * The id is what makes the block actionable — an agent that wants the whole
 * item asks for it by id rather than by guessing a search that finds it again.
 */
export function renderInjectionContext(items: readonly InjectionItem[], more: boolean): string {
  if (items.length === 0) return '';
  return [HEADER, ...items.map(itemLine), more ? `\n${SEARCH_LINE}` : ''].join('');
}

/** Every id of one column served anywhere in this session. */
async function servedIds(db: RelationalStore, scope: ReadScope, sessionId: string, column: 'spore_ids' | 'plan_ids'): Promise<Set<string>> {
  const { results } = await db
    .prepare(`SELECT ${column} AS ids FROM spore_injections WHERE project_id = ? AND session_id = ?`)
    .bind(scope.projectId, sessionId)
    .all<{ ids: string | null }>();
  const ids = new Set<string>();
  for (const row of results) for (const id of parseIds(row.ids ?? '')) ids.add(id);
  return ids;
}

/** Every spore served anywhere in this session. */
export const injectedSporeIds = (db: RelationalStore, scope: ReadScope, sessionId: string): Promise<Set<string>> =>
  servedIds(db, scope, sessionId, 'spore_ids');

/** Every plan served anywhere in this session. A plan repeated across a session's prompts is the same waste a repeated spore is. */
export const injectedPlanIds = (db: RelationalStore, scope: ReadScope, sessionId: string): Promise<Set<string>> =>
  servedIds(db, scope, sessionId, 'plan_ids');

/** This session's records, newest first. */
export async function injectionsForSession(db: RelationalStore, scope: ReadScope, sessionId: string): Promise<InjectionRecord[]> {
  const { results } = await db
    .prepare(`SELECT prompt_id, prompt_hash, spore_ids, plan_ids, created_at FROM spore_injections
               WHERE project_id = ? AND session_id = ? ORDER BY created_at DESC`)
    .bind(scope.projectId, sessionId)
    .all<{ prompt_id: string; prompt_hash: string; spore_ids: string; plan_ids: string | null; created_at: number }>();
  return results.map((r) => ({ promptId: r.prompt_id, promptHash: r.prompt_hash, sporeIds: parseIds(r.spore_ids), planIds: parseIds(r.plan_ids ?? ''), createdAt: r.created_at }));
}

/**
 * What one prompt is served, with its spores hydrated for a reader; null when
 * the prompt carries no record. A spore named by a record and gone from the
 * store drops out of `spores` and stays in `sporeIds`, so the record still says
 * what went into the prompt.
 */
export async function injectionForPrompt(db: RelationalStore, scope: ReadScope, sessionId: string, promptId: string): Promise<PromptInjection | null> {
  const row = await db
    .prepare(`SELECT spore_ids, created_at FROM spore_injections
               WHERE project_id = ? AND session_id = ? AND prompt_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(scope.projectId, sessionId, promptId)
    .first<{ spore_ids: string; created_at: number }>();
  if (row === null) return null;
  const sporeIds = parseIds(row.spore_ids);
  const hydrated = await listSporesByIds(db, scope, sporeIds);
  const byId = new Map(hydrated.map((s) => [s.id, s]));
  return {
    sporeIds,
    createdAt: row.created_at,
    spores: sporeIds.flatMap((id) => {
      const spore = byId.get(id);
      return spore === undefined ? [] : [{ id: spore.id, observationType: spore.observationType, preview: oneLine(spore.agentLine ?? spore.content) }];
    }),
  };
}

function parseIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The items one prompt is served, and the record of having served them.
 *
 * The gates run in a fixed order — the Project's capability, the Deployment's
 * leaf, the prompt's length, the cap, then the pool — and each answers by name,
 * so a caller reports which gate closed rather than an empty answer that could
 * mean any of them.
 *
 * Two pools feed one budget. Spores rank by Mutual Proximity over the semantic
 * candidates; plans rank by similarity alone. Spores stand ahead of every plan,
 * and within each kind the weakest score stands last, so the budget drops plans
 * before spores and the weakest first.
 *
 * The record names exactly what the block rendered. A record naming more than
 * the agent saw would count an observation as served that never reached it, and
 * the session-wide exclusion set would then withhold it from every later prompt.
 */
export async function selectSporesForPrompt(
  db: RelationalStore,
  scope: ReadScope,
  leaves: InjectionLeaves,
  capabilityOn: boolean,
  input: { sessionId: string; promptId: string; promptHash: string; prompt: string; now: number },
  resolveSemantic?: () => Promise<SemanticSearch | null>,
): Promise<InjectionSelection> {
  const nothing = (skipped: InjectionSkip): InjectionSelection => ({ items: [], context: '', skipped });
  if (!capabilityOn) return nothing('capability');
  if (!leaves.enabled) return nothing('disabled');
  if (input.prompt.length < MIN_PROMPT_CHARS) return nothing('short_prompt');
  if (leaves.maxPerPrompt === 0) return nothing('zero_max');

  const semantic = await resolveSemantic?.();
  if (semantic == null) return nothing('provider_unavailable');
  let values: number[];
  try { values = await semantic.provider.embed(input.prompt); }
  catch (error) { if (error instanceof EmbeddingUnavailable) return nothing('provider_unavailable'); throw error; }

  const [sporeHits, planHits, servedSpores, servedPlans] = await Promise.all([
    semanticHits(db, scope, semantic, values, { topK: VECTOR_QUERY_LIMIT, filters: { type: 'spore', status: 'active' } }),
    semanticHits(db, scope, semantic, values, { topK: VECTOR_QUERY_LIMIT, filters: { type: 'plan' } }),
    injectedSporeIds(db, scope, input.sessionId),
    injectedPlanIds(db, scope, input.sessionId),
  ]);

  const relevant = selectRelevantSpores(sporeHits.map((s) => ({ id: s.record_id, similarity: s.score, alreadyInjected: servedSpores.has(s.record_id),
    ...(s.neighbor_mean === null || s.neighbor_std === null ? {} : { neighborMean: s.neighbor_mean, neighborStd: s.neighbor_std }),
  })), { maxResults: leaves.maxPerPrompt });
  const hydrated = await listSporesByIds(db, scope, relevant.map((s) => s.id));
  const bySpore = new Map(hydrated.filter((s) => s.status === 'active').map((s) => [s.id, s]));
  const sporeItems: InjectionItem[] = relevant.flatMap((s) => {
    const row = bySpore.get(s.id);
    return row === undefined ? [] : [{ kind: 'spore' as const, id: row.id, label: row.observationType, text: row.agentLine ?? row.content }];
  });

  const planCandidates = planHits.filter((h) => !servedPlans.has(h.record_id)).slice(0, leaves.maxPerPrompt);
  const planRows = await Promise.all(planCandidates.map((h) => getPlan(db, scope, h.record_id)));
  const planItems: InjectionItem[] = planRows.flatMap((row) =>
    row === null ? [] : [{ kind: 'plan' as const, id: row.planKey, label: `plan: ${row.status}`, text: row.title ?? row.planKey }]);

  const ordered = [...sporeItems, ...planItems];
  const served = itemsWithinBudget(ordered);
  if (served.length === 0) return nothing('empty');

  const idsOf = (kind: InjectionItem['kind']): string[] => served.filter((i) => i.kind === kind).map((i) => i.id);
  const written = await db
    .prepare(`INSERT OR IGNORE INTO spore_injections (project_id, session_id, prompt_id, prompt_hash, spore_ids, plan_ids, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(scope.projectId, input.sessionId, input.promptId, input.promptHash,
      JSON.stringify(idsOf('spore')), JSON.stringify(idsOf('plan')), input.now)
    .run();
  if (written.meta.changes !== 1) return nothing('repeat');

  return { items: served, context: renderInjectionContext(served, ordered.length > served.length), skipped: null };
}
