/**
 * What the prompt hook is served: the spores that go into one prompt, and the
 * record of having served them.
 *
 * This module OWNS `spore_injections`. The record's shape encodes two rules the
 * 1.4 daemon holds across a status allowlist, a session-wide exclusion set and a
 * UNIQUE content hash:
 *
 * **One spore per session.** A spore already served in this session is out of
 * the pool, so an observation is not repeated prompt after prompt.
 *
 * **One prompt content per session.** The primary key is
 * `(project_id, session_id, prompt_hash)`, and the insert is `INSERT OR IGNORE`:
 * a prompt resubmitted with the same text serves nothing a second time.
 *
 * The row names a session and a prompt and holds NO foreign key to either. The
 * prompt hook answers before the prompt event lands on the server, so a record
 * may precede its prompt; a key to `sessions` or `prompt_batches` would refuse
 * the ordinary case. 1.4 falls through the same way under `no_batch`.
 *
 * Relevance is recency: active spores newest first, capped by the leaf. No
 * lexical scoring and no vectors.
 */
import type { RelationalStore } from './adapters.js';
import { leafValues } from './settings.js';
import { listSpores, listSporesByIds, type SporeRow } from './spores.js';
import type { ReadScope } from '../read/scope.js';

/** A prompt shorter than this carries too little to serve against. */
export const MIN_PROMPT_CHARS = 10;
/** How many active spores the selector reads before the exclusion set narrows them. */
export const INJECTION_POOL = 200;
/** The rendered context's ceiling in estimated tokens. */
export const INJECTION_BUDGET_TOKENS = 300;
/** How much of a spore's text one rendered line carries. */
export const INJECTION_PREVIEW_CHARS = 300;
/** The leaf defaults, applied where the Deployment has written none. */
export const INJECT_ON_PROMPT_SUBMIT_DEFAULT = true;
export const MAX_PER_PROMPT_DEFAULT = 3;
/** The widest selection an operator may ask for. */
export const MAX_PER_PROMPT_CEILING = 10;

/** Four characters to a token, the estimate 1.4 renders its budget against. */
const CHARS_PER_TOKEN = 4;
export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

const HEADER = 'Relevant vault observations:';

/** The leaves this selector reads. */
export const INJECTION_LEAVES: readonly string[] = ['cortex.spores.inject_on_prompt_submit', 'cortex.spores.max_per_prompt'];

export interface InjectionLeaves {
  enabled: boolean;
  maxPerPrompt: number;
}

/** Why the selector served nothing. Null means it served what it selected. */
export type InjectionSkip = 'capability' | 'disabled' | 'short_prompt' | 'zero_max' | 'repeat' | 'empty';

export interface InjectionSelection {
  spores: SporeRow[];
  context: string;
  skipped: InjectionSkip | null;
}

export interface InjectionRecord {
  promptId: string;
  promptHash: string;
  sporeIds: string[];
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

/** One rendered line's text for a spore: its type and the opening of its observation on one line. */
function preview(spore: SporeRow): string {
  const line = spore.content.replace(/\s+/g, ' ').trim();
  return line.length > INJECTION_PREVIEW_CHARS ? `${line.slice(0, INJECTION_PREVIEW_CHARS)}…` : line;
}

/** The header and one line per spore, stopping at the token budget. A selection that renders no line renders nothing. */
export function renderInjectionContext(spores: readonly SporeRow[]): string {
  let text = HEADER;
  let tokens = estimateTokens(text);
  for (const spore of spores) {
    const line = `\n- (${spore.observationType}) ${preview(spore)}`;
    const lineTokens = estimateTokens(line);
    if (tokens + lineTokens > INJECTION_BUDGET_TOKENS) break;
    text += line;
    tokens += lineTokens;
  }
  return text === HEADER ? '' : text;
}

/** Every spore served anywhere in this session. */
export async function injectedSporeIds(db: RelationalStore, scope: ReadScope, sessionId: string): Promise<Set<string>> {
  const { results } = await db
    .prepare(`SELECT spore_ids FROM spore_injections WHERE project_id = ? AND session_id = ?`)
    .bind(scope.projectId, sessionId)
    .all<{ spore_ids: string }>();
  const ids = new Set<string>();
  for (const row of results) for (const id of parseIds(row.spore_ids)) ids.add(id);
  return ids;
}

/** This session's records, newest first. */
export async function injectionsForSession(db: RelationalStore, scope: ReadScope, sessionId: string): Promise<InjectionRecord[]> {
  const { results } = await db
    .prepare(`SELECT prompt_id, prompt_hash, spore_ids, created_at FROM spore_injections
               WHERE project_id = ? AND session_id = ? ORDER BY created_at DESC`)
    .bind(scope.projectId, sessionId)
    .all<{ prompt_id: string; prompt_hash: string; spore_ids: string; created_at: number }>();
  return results.map((r) => ({ promptId: r.prompt_id, promptHash: r.prompt_hash, sporeIds: parseIds(r.spore_ids), createdAt: r.created_at }));
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
      return spore === undefined ? [] : [{ id: spore.id, observationType: spore.observationType, preview: preview(spore) }];
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
 * The spores one prompt is served, and the record of having served them.
 *
 * The gates run in a fixed order — the Project's capability, the Deployment's
 * leaf, the prompt's length, the cap, then the pool — and each answers by name,
 * so a caller reports which gate closed rather than an empty answer that could
 * mean any of them.
 */
export async function selectSporesForPrompt(
  db: RelationalStore,
  scope: ReadScope,
  leaves: InjectionLeaves,
  capabilityOn: boolean,
  input: { sessionId: string; promptId: string; promptHash: string; prompt: string; now: number },
): Promise<InjectionSelection> {
  const nothing = (skipped: InjectionSkip): InjectionSelection => ({ spores: [], context: '', skipped });
  if (!capabilityOn) return nothing('capability');
  if (!leaves.enabled) return nothing('disabled');
  if (input.prompt.length < MIN_PROMPT_CHARS) return nothing('short_prompt');
  if (leaves.maxPerPrompt === 0) return nothing('zero_max');

  const [pool, already] = await Promise.all([
    listSpores(db, scope, { status: 'active', limit: INJECTION_POOL }),
    injectedSporeIds(db, scope, input.sessionId),
  ]);
  const selected = pool.filter((s) => !already.has(s.id)).slice(0, leaves.maxPerPrompt);
  if (selected.length === 0) return nothing('empty');

  const written = await db
    .prepare(`INSERT OR IGNORE INTO spore_injections (project_id, session_id, prompt_id, prompt_hash, spore_ids, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(scope.projectId, input.sessionId, input.promptId, input.promptHash, JSON.stringify(selected.map((s) => s.id)), input.now)
    .run();
  if (written.meta.changes !== 1) return nothing('repeat');

  return { spores: selected, context: renderInjectionContext(selected), skipped: null };
}
