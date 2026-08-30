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
import { deploymentSecretStore, type SecretStore } from './secrets.js';
import { leafValues, providerConfiguredFor } from './settings.js';

export const TITLING_TASK = 'title-summary';
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';
export const ANSWER_MAX_TOKENS = 400;
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
  | 'malformed' | 'provider' | 'unreachable' | 'titled';

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
  const fixed = FIXED_ENDPOINTS[type];
  if (fixed !== undefined) {
    const bearer = await secrets.get(type);
    if (bearer === null) return { ok: false, outcome: 'no_credential' };
    return { ok: true, provider: { kind: 'openai', provider: type, url: fixed, model: configuredModel, bearer } };
  }
  if (NAMED_ENDPOINT_PROVIDERS.has(type)) {
    if (baseUrl === null) return { ok: false, outcome: type === 'openai-compatible' ? 'no_endpoint' : 'local_provider' };
    return { ok: true, provider: { kind: 'openai', provider: type, url: baseUrl.replace(/\/+$/, ''), model: configuredModel, bearer: null } };
  }
  return { ok: false, outcome: 'no_provider' };
}

export interface MaterialLine { prompt: string; response: string | null }

/** The session's earliest inline user prompts, each with the start of its first inline response, inside the character budget. */
export async function sessionMaterial(db: RelationalStore, projectId: string, sessionId: string): Promise<MaterialLine[]> {
  const { results } = await db
    .prepare(`SELECT substr(pb.text, 1, ?) AS prompt,
                     (SELECT substr(r.text, 1, ?) FROM responses r
                       WHERE r.project_id = pb.project_id AND r.session_id = pb.session_id AND r.prompt_id = pb.prompt_id AND r.text IS NOT NULL
                       ORDER BY r.created_at, r.response_id LIMIT 1) AS response
                FROM prompt_batches pb
               WHERE pb.project_id = ? AND pb.session_id = ? AND pb.origin = 'user' AND pb.text IS NOT NULL
               ORDER BY pb.created_at, pb.prompt_id LIMIT ?`)
    .bind(MATERIAL_EXCERPT_CHARS, MATERIAL_EXCERPT_CHARS, projectId, sessionId, MAX_MATERIAL_PROMPTS)
    .all<{ prompt: string; response: string | null }>();
  const lines: MaterialLine[] = [];
  let used = 0;
  for (const row of results) {
    const cost = row.prompt.length + (row.response?.length ?? 0);
    if (used + cost > MAX_MATERIAL_CHARS) break;
    used += cost;
    lines.push({ prompt: row.prompt, response: row.response ?? null });
  }
  return lines;
}

/** The one message the provider receives: the 1.4 title and summary rules, the session's facts, and its material. */
export function titlingPrompt(facts: { agent: string | null; branch: string | null }, material: MaterialLine[]): string {
  const lines = material.map((m, i) => `Prompt ${i + 1}: ${m.prompt}${m.response === null ? '' : `\nResponse: ${m.response}`}`).join('\n\n');
  return [
    'You title and summarize a coding session for its dashboard.',
    `Session facts: agent ${facts.agent ?? 'unknown'}; branch ${facts.branch ?? 'unknown'}.`,
    'The material is the session\'s earliest user prompts, each with the start of the assistant\'s response.',
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
    return {
      url: ANTHROPIC_MESSAGES_URL,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': provider.key, 'anthropic-version': ANTHROPIC_VERSION },
        body: JSON.stringify({ model: provider.model, max_tokens: ANSWER_MAX_TOKENS, messages: [{ role: 'user', content: prompt }] }),
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
      body: JSON.stringify({ model: provider.model, max_tokens: ANSWER_MAX_TOKENS, messages: [{ role: 'user', content: prompt }] }),
    },
    text: (body) => {
      const content = (body as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]?.message?.content;
      return typeof content === 'string' ? content : null;
    },
  };
}

export interface TitlingTarget { projectId: string; sessionId: string; now: number }

/** Titles one ended session. Resolves with the outcome it emitted; never rejects. */
export async function titleSession(env: ServerEnv, target: TitlingTarget): Promise<TitlingOutcome> {
  const { projectId, sessionId, now } = target;
  const skipped = (outcome: TitlingOutcome): TitlingOutcome => { emit({ kind: 'session_title_skipped', projectId, sessionId, outcome }); return outcome; };
  const failed = (outcome: TitlingOutcome, extra: Record<string, unknown> = {}): TitlingOutcome => { emit({ kind: 'session_title_failed', projectId, sessionId, outcome, ...extra }); return outcome; };
  try {
    const claim = await env.db
      .prepare(`UPDATE sessions SET titled_at = ? WHERE project_id = ? AND session_id = ? AND ended_at IS NOT NULL AND titled_at IS NULL`)
      .bind(now, projectId, sessionId)
      .run();
    if (claim.meta.changes !== 1) return skipped('already');

    const recent = await env.db
      .prepare(`SELECT COUNT(*) AS n FROM sessions WHERE project_id = ? AND titled_at > ?`)
      .bind(projectId, now - HOUR_MS)
      .first<{ n: number }>();
    if ((recent?.n ?? 0) > MAX_TITLES_PER_PROJECT_PER_HOUR) return skipped('budget');

    const material = await sessionMaterial(env.db, projectId, sessionId);
    if (material.length === 0) return skipped('no_material');

    if (!(await providerConfiguredFor(env.db, TITLING_TASK))) return skipped('no_provider');
    const resolved = await resolveTitlingProvider(env.db, deploymentSecretStore(env.db, env.wrappingKey));
    if (!resolved.ok) return skipped(resolved.outcome);

    const facts = await env.db.prepare(`SELECT agent, branch FROM sessions WHERE project_id = ? AND session_id = ?`).bind(projectId, sessionId).first<{ agent: string | null; branch: string | null }>();
    const request = providerRequest(resolved.provider, titlingPrompt(facts ?? { agent: null, branch: null }, material));

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

    const written = await env.db
      .prepare(`UPDATE sessions SET title = ?, summary = ? WHERE project_id = ? AND session_id = ? AND title IS NULL`)
      .bind(answer.title, answer.summary, projectId, sessionId)
      .run();
    if (written.meta.changes !== 1) return skipped('already');
    emit({ kind: 'session_titled', projectId, sessionId, provider: resolved.provider.kind === 'anthropic' ? 'anthropic' : resolved.provider.provider });
    return 'titled';
  } catch {
    return failed('unreachable');
  }
}
