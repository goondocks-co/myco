/**
 * Context injector — assembles context from SQLite for hook injection.
 *
 * Queries sessions, plans, and spores from SQLite. For prompt-submit context,
 * semantic search is deferred to Phase 2 (requires daemon vector store).
 * If no data exists (zero-config), returns empty context gracefully.
 */

import { getDatabase } from '@myco/db/client.js';
import { listSessions } from '@myco/db/queries/sessions.js';
import { listPlans } from '@myco/db/queries/plans.js';
import { listSpores } from '@myco/db/queries/spores.js';
import type { MycoConfig } from '@myco/config/schema.js';
import {
  estimateTokens,
  CONTEXT_PLAN_PREVIEW_CHARS,
  CONTEXT_SESSION_PREVIEW_CHARS,
  CONTEXT_SPORE_PREVIEW_CHARS,
  SESSION_CONTEXT_MAX_PLANS,
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

/** Default token budget for plans layer. */
const DEFAULT_PLANS_BUDGET = 200;

/** Default token budget for sessions layer. */
const DEFAULT_SESSIONS_BUDGET = 500;

/** Default token budget for spores layer. */
const DEFAULT_SPORES_BUDGET = 300;

/** Default token budget for team layer. */
const DEFAULT_TEAM_BUDGET = 200;

/** Default total context max tokens. */
const DEFAULT_CONTEXT_MAX_TOKENS = 1200;

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
 * Build injected context from SQLite data.
 *
 * Returns empty context gracefully when no data exists (zero-config behavior).
 */
export async function buildInjectedContext(
  _config: MycoConfig,
  context: InjectionContext,
): Promise<InjectedContext> {
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
    DEFAULT_PLANS_BUDGET,
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
    DEFAULT_SESSIONS_BUDGET,
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
    DEFAULT_SPORES_BUDGET,
  );

  // Layer 4: Team activity (placeholder — populated in Phase 2)
  const teamText = formatLayer('Team Activity', [], DEFAULT_TEAM_BUDGET);

  // Enforce total max_tokens budget
  const allLayers = [plansText, sessionsText, sporesText, teamText].filter(Boolean);
  const parts: string[] = [];
  let totalTokens = 0;

  for (const layer of allLayers) {
    const layerTokens = estimateTokens(layer);
    if (totalTokens + layerTokens > DEFAULT_CONTEXT_MAX_TOKENS) break;
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
 * Semantic search via the daemon's in-process vector store is deferred to
 * Phase 2. For now, returns empty context. The hook (`user-prompt-submit`)
 * routes through the daemon API at `/context/prompt`, which will implement
 * vector search when ready.
 */
export async function buildPromptContext(
  prompt: string,
  _config: MycoConfig,
): Promise<InjectedContext> {
  if (prompt.length < PROMPT_CONTEXT_MIN_LENGTH) {
    return emptyContext();
  }

  // Per-prompt semantic search deferred to Phase 2 (requires daemon vector store)
  return emptyContext();
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
