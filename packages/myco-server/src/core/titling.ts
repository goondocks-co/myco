/**
 * A session's title and summary, written on the Deployment once the session has
 * ended.
 *
 * The request that ends a session schedules this past its answer. The work claims
 * the session first — `titled_at` is written before anything is called, so two
 * ends of one session make one attempt — then keeps within a per-Project hourly
 * ceiling, reads bounded material, asks the configured provider once, and writes
 * the answer only where no title exists. Every outcome is emitted; none is thrown.
 *
 * Only `anthropic`, `openai` and `openrouter` carry a credential, each at its own
 * fixed endpoint; an endpoint the operator names receives no credential at all.
 */
import { MATERIAL_EXCERPT_CHARS, MAX_MATERIAL_CHARS, MAX_MATERIAL_PROMPTS, MAX_TITLES_PER_PROJECT_PER_HOUR, TITLING_TIMEOUT_MS } from '../constants.js';
import { emit } from '../telemetry.js';
import type { RelationalStore, ServerEnv } from './adapters.js';
import { sessionMaterialRows, sessionMaterialTailRows, type MaterialRow } from '../read/children.js';
import { claimOwnerTitling, claimTitling, overwriteTitle, restoreTitlingStamp, sessionFacts, titlingsSince, writeTitle } from '../read/sessions.js';
import { deploymentSecretStore, type SecretStore } from './secrets.js';
import { leafValues, providerConfiguredFor } from './settings.js';

export const TITLING_TASK = 'title-summary';
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
/** A stored Anthropic credential that is a subscription sign-in rather than an API key travels as a bearer with this capability named. */
export const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20';
/** The shape a subscription sign-in credential carries; an API key starts `sk-ant-api…` and travels as `x-api-key`. */
export const ANTHROPIC_OAUTH_PREFIX = 'sk-ant-oat';
/** The system text a subscription sign-in token is admitted with: the provider serves such a token only to a request that presents itself as the CLI the token belongs to. */
export const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';
export const ANSWER_MAX_TOKENS = 4096;
export const TITLE_MAX_CHARS = 80;
export const SUMMARY_MAX_CHARS = 1200;
const HOUR_MS = 60 * 60 * 1000;

/** Providers whose credential travels only to their own endpoint. */
const FIXED_ENDPOINTS: Readonly<Record<string, string>> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
};
/** Providers reached only at an endpoint the operator names, with no credential. */
const NAMED_ENDPOINT_PROVIDERS = new Set(['openai-compatible', 'ollama', 'lmstudio']);

export type TitlingOutcome =
  | 'already' | 'budget' | 'no_material' | 'no_provider' | 'no_credential' | 'local_provider' | 'no_endpoint' | 'no_model'
  | 'malformed' | 'provider' | 'unreachable' | 'superseded' | 'error' | 'titled';

/** The path an OpenAI-shaped endpoint serves its API under; a local backend's endpoint names the server root and gains it. */
const OPENAI_API_PATH = '/v1';

/** A local backend's endpoint with the API path in place: the operator names the server root (`http://ollama.internal:11434`), and an endpoint already carrying `/v1` is kept. */
export function localBackendEndpoint(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { return baseUrl.replace(/\/+$/, ''); }
  if (url.pathname !== OPENAI_API_PATH && !url.pathname.startsWith(`${OPENAI_API_PATH}/`)) url.pathname = `${url.pathname.replace(/\/+$/, '')}${OPENAI_API_PATH}`;
  return url.toString().replace(/\/+$/, '');
}

export type TitlingProvider =
  | { kind: 'anthropic'; model: string; key: string }
  | { kind: 'openai'; provider: string; url: string; model: string; bearer: string | null };

export type ProviderResolution = { ok: true; provider: TitlingProvider } | { ok: false; outcome: TitlingOutcome };

const parseLeaf = (value: string | undefined): unknown => {
  if (value === undefined) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
};
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/** The provider, endpoint, model and credential the titling call uses, from the Deployment's settings and secrets. */
export async function resolveTitlingProvider(db: RelationalStore, secrets: SecretStore): Promise<ProviderResolution> {
  const byLeaf = await leafValues(db, ['agent.tasks', 'agent.provider.type', 'agent.provider.model', 'agent.model', 'agent.provider.base_url']);
  const tasks = parseLeaf(byLeaf.get('agent.tasks'));
  const task = tasks !== null && typeof tasks === 'object' && !Array.isArray(tasks) ? (tasks as Record<string, unknown>)[TITLING_TASK] : undefined;
  const override = task !== null && typeof task === 'object' && !Array.isArray(task) ? (task as Record<string, unknown>) : {};
  const type = str(override.provider) ?? str(parseLeaf(byLeaf.get('agent.provider.type')));
  if (type === null) return { ok: false, outcome: 'no_provider' };
  const configuredModel = str(override.model) ?? str(parseLeaf(byLeaf.get('agent.provider.model'))) ?? str(parseLeaf(byLeaf.get('agent.model')));
  const baseUrl = str(parseLeaf(byLeaf.get('agent.provider.base_url')));

  if (type === 'anthropic') {
    const key = await secrets.get('anthropic');
    if (key === null) return { ok: false, outcome: 'no_credential' };
    return { ok: true, provider: { kind: 'anthropic', model: configuredModel ?? DEFAULT_ANTHROPIC_MODEL, key } };
  }
  if (configuredModel === null) return { ok: false, outcome: 'no_model' };
  const fixed = Object.hasOwn(FIXED_ENDPOINTS, type) ? FIXED_ENDPOINTS[type] : undefined;
  if (fixed !== undefined) {
    const bearer = await secrets.get(type);
    if (bearer === null) return { ok: false, outcome: 'no_credential' };
    return { ok: true, provider: { kind: 'openai', provider: type, url: fixed, model: configuredModel, bearer } };
  }
  if (NAMED_ENDPOINT_PROVIDERS.has(type)) {
    if (baseUrl === null) return { ok: false, outcome: type === 'openai-compatible' ? 'no_endpoint' : 'local_provider' };
    const url = type === 'openai-compatible' ? baseUrl.replace(/\/+$/, '') : localBackendEndpoint(baseUrl);
    return { ok: true, provider: { kind: 'openai', provider: type, url, model: configuredModel, bearer: null } };
  }
  return { ok: false, outcome: 'no_provider' };
}

export type MaterialLine = Pick<MaterialRow, 'prompt' | 'response'>;

/**
 * How a title is asked for. `claim` is the end of a session: one attempt ever,
 * writing only where no title exists, over the session's opening prompts. `owner`
 * is a person asking from the dashboard: any session, ended or not, over the
 * opening and closing prompts, writing over whatever title is there.
 */
export type TitlingMode = 'claim' | 'owner';

const lineCost = (row: MaterialRow): number => row.prompt.length + (row.response?.length ?? 0);

/** The rows that fit a character budget, taken in the given order and answered in that order. */
function fit(rows: readonly MaterialRow[], budget: number): { rows: MaterialRow[]; used: number } {
  const kept: MaterialRow[] = [];
  let used = 0;
  for (const row of rows) {
    const cost = lineCost(row);
    if (used + cost > budget) break;
    used += cost;
    kept.push(row);
  }
  return { rows: kept, used };
}

/**
 * The session's inline user prompts, each with the start of its first inline response, inside the character budget.
 * At a session's end: the earliest prompts. On an owner's ask: the earliest and the latest halves, each fitted to its own half of the budget — the tail from the latest prompt backwards, so what survives is the arc's end and never its middle.
 */
export async function sessionMaterial(db: RelationalStore, projectId: string, sessionId: string, mode: TitlingMode = 'claim'): Promise<MaterialLine[]> {
  const excerpt = { excerptChars: MATERIAL_EXCERPT_CHARS };
  const toLine = (row: MaterialRow): MaterialLine => ({ prompt: row.prompt, response: row.response ?? null });
  if (mode !== 'owner') {
    return fit(await sessionMaterialRows(db, projectId, sessionId, { limit: MAX_MATERIAL_PROMPTS, ...excerpt }), MAX_MATERIAL_CHARS).rows.map(toLine);
  }
  const halfPrompts = Math.ceil(MAX_MATERIAL_PROMPTS / 2);
  const halfChars = Math.ceil(MAX_MATERIAL_CHARS / 2);
  const headRows = await sessionMaterialRows(db, projectId, sessionId, { limit: halfPrompts, ...excerpt });
  const tailRows = await sessionMaterialTailRows(db, projectId, sessionId, { limit: MAX_MATERIAL_PROMPTS - halfPrompts, ...excerpt });
  const seen = new Set(headRows.map((r) => r.promptId));
  const tailOnly = tailRows.filter((r) => !seen.has(r.promptId));
  const tail = fit([...tailOnly].reverse(), halfChars);
  const head = fit(headRows, MAX_MATERIAL_CHARS - tail.used);
  return [...head.rows, ...tail.rows.reverse()].map(toLine);
}

/** The one message the provider receives: the 1.4 title and summary rules, the session's facts, and its material — described as what it is, the opening alone or the opening and the close. */
export function titlingPrompt(facts: { agent: string | null; branch: string | null }, material: MaterialLine[], mode: TitlingMode = 'claim'): string {
  const lines = material.map((m, i) => `Prompt ${i + 1}: ${m.prompt}${m.response === null ? '' : `\nResponse: ${m.response}`}`).join('\n\n');
  return [
    'You title and summarize a coding session for its dashboard.',
    `Session facts: agent ${facts.agent ?? 'unknown'}; branch ${facts.branch ?? 'unknown'}.`,
    mode === 'owner'
      ? 'The material is the session\'s earliest and latest user prompts in order, each with the start of the assistant\'s response; the middle of the session is omitted.'
      : 'The material is the session\'s earliest user prompts, each with the start of the assistant\'s response.',
    '',
    'Title rules: under 80 characters, sentence case. The title describes WHAT WAS ACCOMPLISHED, not what was asked; synthesize the full arc, not the first prompt. Never a file path, directory or working directory; never the user\'s first message; never a truncated prompt ending in "...".',
    'Good: "Wave-based parallel executor and per-task provider config". Good: "SQLite migration with FTS5 search and vector embeddings". Bad: "/git-worktree". Bad: "Help me fix the bug in...". Bad: "Working on code".',
    'Summary rules: 2-4 sentences, rich in detail — what was built or fixed, key files touched, tools used, outcomes — covering the full arc.',
    '',
    'Answer with exactly one JSON object and nothing else: {"title": "...", "summary": "..."}',
    '',
    'Material:',
    lines,
  ].join('\n');
}

/** The title and summary inside an answer, or null when the answer does not carry a usable pair. */
export function parseTitleAnswer(text: string): { title: string; summary: string } | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { title, summary } = parsed as Record<string, unknown>;
  if (typeof title !== 'string' || typeof summary !== 'string') return null;
  const cleanTitle = title.replace(/\s+/g, ' ').trim().replace(/[.…]+$/, '').trim();
  const cleanSummary = summary.trim();
  if (cleanTitle.length === 0 || cleanTitle.length > TITLE_MAX_CHARS) return null;
  if (cleanSummary.length === 0 || cleanSummary.length > SUMMARY_MAX_CHARS) return null;
  return { title: cleanTitle, summary: cleanSummary };
}

/** The request for the provider, and how its answer's text is read back. */
export function providerRequest(provider: TitlingProvider, prompt: string): { url: string; init: RequestInit; text: (body: unknown) => string | null } {
  if (provider.kind === 'anthropic') {
    const oauth = provider.key.startsWith(ANTHROPIC_OAUTH_PREFIX);
    return {
      url: ANTHROPIC_MESSAGES_URL,
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': ANTHROPIC_VERSION,
          ...(oauth
            ? { authorization: `Bearer ${provider.key}`, 'anthropic-beta': ANTHROPIC_OAUTH_BETA }
            : { 'x-api-key': provider.key }),
        },
        body: JSON.stringify({
          model: provider.model,
          max_tokens: ANSWER_MAX_TOKENS,
          ...(oauth ? { system: [{ type: 'text', text: CLAUDE_CODE_SYSTEM_PROMPT }] } : {}),
          messages: [{ role: 'user', content: prompt }],
        }),
      },
      text: (body) => {
        const content = (body as { content?: unknown })?.content;
        if (!Array.isArray(content)) return null;
        const parts = content.filter((b): b is { type: string; text: string } => typeof b?.text === 'string' && b.type === 'text').map((b) => b.text);
        return parts.length === 0 ? null : parts.join('');
      },
    };
  }
  return {
    url: `${provider.url}/chat/completions`,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(provider.bearer === null ? {} : { authorization: `Bearer ${provider.bearer}` }) },
      // OpenAI's own endpoint takes the answer budget as `max_completion_tokens`; the compatible endpoints take `max_tokens`.
      body: JSON.stringify({ model: provider.model, [provider.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens']: ANSWER_MAX_TOKENS, messages: [{ role: 'user', content: prompt }] }),
    },
    text: (body) => {
      const content = (body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
      return typeof content === 'string' ? content : null;
    },
  };
}

export interface TitlingTarget { projectId: string; sessionId: string; now: number }

/** Titles one session: at its end (`claim`, the default) or on an owner's ask (`owner`). Resolves with the outcome it emitted; never rejects. */
export async function titleSession(env: ServerEnv, target: TitlingTarget, opts: { mode?: TitlingMode; by?: string } = {}): Promise<TitlingOutcome> {
  const { projectId, sessionId, now } = target;
  const mode = opts.mode ?? 'claim';
  const skipped = (outcome: TitlingOutcome): TitlingOutcome => { emit({ kind: 'session_title_skipped', projectId, sessionId, outcome, mode }); return outcome; };
  const failed = (outcome: TitlingOutcome, extra: Record<string, unknown> = {}): TitlingOutcome => { emit({ kind: 'session_title_failed', projectId, sessionId, outcome, mode, ...extra }); return outcome; };
  try {
    // An owner's ask that never reaches the provider gives the stamp back: the session keeps its own end-of-session attempt and the ceiling is not charged.
    let previous: number | null = null;
    const unstamp = async (outcome: TitlingOutcome): Promise<TitlingOutcome> => {
      if (mode === 'owner') await restoreTitlingStamp(env.db, projectId, sessionId, now, previous);
      return skipped(outcome);
    };
    if (mode === 'owner') {
      const claim = await claimOwnerTitling(env.db, projectId, sessionId, now, TITLING_TIMEOUT_MS);
      if (!claim.claimed) return skipped('already');
      previous = claim.previous;
    } else if (!(await claimTitling(env.db, projectId, sessionId, now))) {
      return skipped('already');
    }
    if ((await titlingsSince(env.db, projectId, now - HOUR_MS)) > MAX_TITLES_PER_PROJECT_PER_HOUR) return unstamp('budget');

    const material = await sessionMaterial(env.db, projectId, sessionId, mode);
    if (material.length === 0) return unstamp('no_material');

    if (!(await providerConfiguredFor(env.db, TITLING_TASK))) return unstamp('no_provider');
    const resolved = await resolveTitlingProvider(env.db, deploymentSecretStore(env.db, env.wrappingKey));
    if (!resolved.ok) return unstamp(resolved.outcome);

    const request = providerRequest(resolved.provider, titlingPrompt(await sessionFacts(env.db, projectId, sessionId), material, mode));

    let response: Response;
    try {
      response = await env.outbound(request.url, { ...request.init, signal: AbortSignal.timeout(TITLING_TIMEOUT_MS) });
    } catch {
      return failed('unreachable');
    }
    if (!response.ok) return failed('provider', { status: response.status });
    let body: unknown;
    try { body = await response.json(); } catch { return failed('malformed'); }
    const text = request.text(body);
    const answer = text === null ? null : parseTitleAnswer(text);
    if (answer === null) return failed('malformed');

    const written = mode === 'owner'
      ? await overwriteTitle(env.db, projectId, sessionId, answer.title, answer.summary, opts.by ?? null)
      : await writeTitle(env.db, projectId, sessionId, answer.title, answer.summary);
    if (!written) return failed('superseded');
    emit({ kind: 'session_titled', projectId, sessionId, mode, provider: resolved.provider.kind === 'anthropic' ? 'anthropic' : resolved.provider.provider });
    return 'titled';
  } catch {
    return failed('error');
  }
}
