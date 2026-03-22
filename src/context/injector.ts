/**
 * Context injector — assembles context from PGlite for hook injection.
 *
 * Queries sessions, plans, and spores from PGlite. For prompt-submit context,
 * optionally performs semantic search via pgvector. If no data exists (zero-config),
 * returns empty context gracefully.
 */

import { getDatabase } from '@myco/db/client.js';
import { listSessions } from '@myco/db/queries/sessions.js';
import { listPlans } from '@myco/db/queries/plans.js';
import { listSpores } from '@myco/db/queries/spores.js';
import { searchSimilar } from '@myco/db/queries/embeddings.js';
import { tryEmbed } from '@myco/intelligence/embed-query.js';
import type { MycoConfig } from '@myco/config/schema.js';
import {
  estimateTokens,
  CONTEXT_PLAN_PREVIEW_CHARS,
  CONTEXT_SESSION_PREVIEW_CHARS,
  CONTEXT_SPORE_PREVIEW_CHARS,
  SESSION_CONTEXT_MAX_PLANS,
  PROMPT_CONTEXT_MAX_SPORES,
  PROMPT_CONTEXT_MIN_SIMILARITY,
  PROMPT_CONTEXT_MIN_LENGTH,
  EXCLUDED_SPORE_STATUSES,
} from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max recent sessions to include in context. */
const CONTEXT_SESSION_LIMIT = 10;

/** Max sessions displayed after scoring. */
const CONTEXT_SESSION_DISPLAY_LIMIT = 5;

/** Max spores to fetch for scoring. */
const CONTEXT_SPORE_FETCH_LIMIT = 20;

/** Max spores displayed after scoring. */
const CONTEXT_SPORE_DISPLAY_LIMIT = 5;

/** Active plan status values. */
const ACTIVE_PLAN_STATUSES = new Set(['active', 'in_progress']);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InjectionContext {
  branch?: string;
}

interface InjectedContext {
  text: string;
  tokenEstimate: number;
  layers: {
    plans: string;
    sessions: string;
    spores: string;
    team: string;
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build injected context from PGlite data.
 *
 * Returns empty context gracefully when no data exists (zero-config behavior).
 */
export async function buildInjectedContext(
  config: MycoConfig,
  context: InjectionContext,
): Promise<InjectedContext> {
  const budgets = config.context.layers;

  // Verify database is available — return empty if not
  try {
    getDatabase();
  } catch {
    return emptyContext();
  }

  // Fetch plans, sessions, and spores in parallel
  const [plans, sessions, spores] = await Promise.all([
    listPlans({ limit: SESSION_CONTEXT_MAX_PLANS * 2 }),
    listSessions({ limit: CONTEXT_SESSION_LIMIT }),
    listSpores({ limit: CONTEXT_SPORE_FETCH_LIMIT, status: 'active' }),
  ]);

  // Layer 1: Active plans
  const activePlans = plans.filter((p) =>
    ACTIVE_PLAN_STATUSES.has(p.status),
  );
  const plansText = formatLayer(
    'Active Plans',
    activePlans.slice(0, SESSION_CONTEXT_MAX_PLANS).map((p) =>
      `- **${p.title ?? p.id}** (${p.status}): ${(p.content ?? '').slice(0, CONTEXT_PLAN_PREVIEW_CHARS)}`,
    ),
    budgets.plans,
  );

  // Layer 2: Recent sessions
  const sessionsText = formatLayer(
    'Recent Sessions',
    sessions.slice(0, CONTEXT_SESSION_DISPLAY_LIMIT).map((s) => {
      const title = s.title ?? s.id;
      const summary = (s.summary ?? '').slice(0, CONTEXT_SESSION_PREVIEW_CHARS);
      const branchLabel = s.branch === context.branch ? ' (same branch)' : '';
      return `- **${title}**: ${summary}${branchLabel}`;
    }),
    budgets.sessions,
  );

  // Layer 3: Relevant spores (exclude superseded/archived)
  const filteredSpores = spores.filter((s) =>
    !EXCLUDED_SPORE_STATUSES.has(s.status),
  );
  const sporesText = formatLayer(
    'Relevant Spores',
    filteredSpores.slice(0, CONTEXT_SPORE_DISPLAY_LIMIT).map((s) =>
      `- **${s.id}** (${s.observation_type}): ${s.content.slice(0, CONTEXT_SPORE_PREVIEW_CHARS)}`,
    ),
    budgets.spores,
  );

  // Layer 4: Team activity (placeholder — populated in Phase 2)
  const teamText = formatLayer('Team Activity', [], budgets.team);

  // Enforce total max_tokens budget
  const allLayers = [plansText, sessionsText, sporesText, teamText].filter(Boolean);
  const parts: string[] = [];
  let totalTokens = 0;

  for (const layer of allLayers) {
    const layerTokens = estimateTokens(layer);
    if (totalTokens + layerTokens > config.context.max_tokens) break;
    parts.push(layer);
    totalTokens += layerTokens;
  }

  const fullText = parts.join('\n\n');

  return {
    text: fullText,
    tokenEstimate: totalTokens,
    layers: {
      plans: plansText,
      sessions: sessionsText,
      spores: sporesText,
      team: teamText,
    },
  };
}

/**
 * Build per-prompt context using semantic search on spores.
 *
 * If the user's prompt is long enough and embeddings exist, searches for
 * relevant spores via pgvector. Returns empty context gracefully when no
 * embedding provider is configured or no embeddings exist.
 */
export async function buildPromptContext(
  prompt: string,
  config: MycoConfig,
): Promise<InjectedContext> {
  if (prompt.length < PROMPT_CONTEXT_MIN_LENGTH) {
    return emptyContext();
  }

  // Verify database is available
  try {
    getDatabase();
  } catch {
    return emptyContext();
  }

  // Try to embed the prompt and search for similar spores
  const queryVector = await tryEmbed(prompt);
  if (!queryVector) {
    return emptyContext();
  }

  const results = await searchSimilar('spores', queryVector, {
    limit: PROMPT_CONTEXT_MAX_SPORES,
    filters: { status: 'active' },
  });

  const relevant = results.filter((r) => r.similarity >= PROMPT_CONTEXT_MIN_SIMILARITY);
  if (relevant.length === 0) {
    return emptyContext();
  }

  const sporesText = formatLayer(
    'Relevant Knowledge',
    relevant.map((r) => {
      const content = ((r.content as string) ?? '').slice(0, CONTEXT_SPORE_PREVIEW_CHARS);
      const type = r.observation_type as string;
      return `- **${type}** (${r.similarity.toFixed(2)}): ${content}`;
    }),
    config.context.layers.spores,
  );

  const totalTokens = estimateTokens(sporesText);

  return {
    text: sporesText,
    tokenEstimate: totalTokens,
    layers: {
      plans: '',
      sessions: '',
      spores: sporesText,
      team: '',
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyContext(): InjectedContext {
  return {
    text: '',
    tokenEstimate: 0,
    layers: { plans: '', sessions: '', spores: '', team: '' },
  };
}

function formatLayer(heading: string, items: string[], budget: number): string {
  if (items.length === 0) return '';

  let text = `### ${heading}\n`;
  let currentTokens = estimateTokens(text);

  for (const item of items) {
    const itemTokens = estimateTokens(item);
    if (currentTokens + itemTokens > budget) break;
    text += item + '\n';
    currentTokens += itemTokens;
  }

  return text.trim();
}
