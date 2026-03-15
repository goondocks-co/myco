import type { MycoIndex } from '../index/sqlite.js';
import type { MycoConfig } from '../config/schema.js';
import { planFm, memoryFm } from '../vault/frontmatter.js';
import { scoreRelevance } from './relevance.js';
import { CHARS_PER_TOKEN, CONTEXT_PLAN_PREVIEW_CHARS, CONTEXT_SESSION_PREVIEW_CHARS, CONTEXT_MEMORY_PREVIEW_CHARS } from '../constants.js';

interface InjectionContext {
  branch?: string;
}

interface InjectedContext {
  text: string;
  tokenEstimate: number;
  layers: {
    plans: string;
    sessions: string;
    memories: string;
    team: string;
  };
}

export function buildInjectedContext(
  index: MycoIndex,
  config: MycoConfig,
  context: InjectionContext,
): InjectedContext {
  const budgets = config.context.layers;

  // Layer 1: Active plans
  const plans = index.query({ type: 'plan' });
  const activePlans = plans.filter((p) =>
    ['active', 'in_progress'].includes(planFm(p).status ?? ''),
  );
  const plansText = formatLayer(
    'Active Plans',
    activePlans.map((p) => `- **${p.title}** (${planFm(p).status}): ${p.content.slice(0, CONTEXT_PLAN_PREVIEW_CHARS)}`),
    budgets.plans,
  );

  // Layer 2: Recent sessions
  const sessions = index.query({ type: 'session', limit: 10 });
  const activePlanIds = activePlans.map((p) => p.id);
  const scoredSessions = scoreRelevance(sessions, {
    branch: context.branch,
    activePlanIds,
  });
  const sessionsText = formatLayer(
    'Recent Sessions',
    scoredSessions.slice(0, 5).map((s) =>
      `- **${s.note.title}**: ${s.note.content.slice(0, CONTEXT_SESSION_PREVIEW_CHARS)} (${s.reason})`,
    ),
    budgets.sessions,
  );

  // Layer 3: Relevant memories (exclude superseded/archived)
  const memories = index.query({ type: 'memory', limit: 20 })
    .filter((m) => {
      const status = memoryFm(m).status;
      return status !== 'superseded' && status !== 'archived';
    });
  const scoredMemories = scoreRelevance(memories, {
    branch: context.branch,
    activePlanIds,
  });
  const memoriesText = formatLayer(
    'Relevant Memories',
    scoredMemories.slice(0, 5).map((m) =>
      `- **${m.note.title}** (${memoryFm(m.note).observation_type}): ${m.note.content.slice(0, CONTEXT_MEMORY_PREVIEW_CHARS)}`,
    ),
    budgets.memories,
  );

  // Layer 4: Team activity
  const teamText = formatLayer('Team Activity', [], budgets.team);

  // Enforce total max_tokens budget
  const allLayers = [plansText, sessionsText, memoriesText, teamText].filter(Boolean);
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
      memories: memoriesText,
      team: teamText,
    },
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

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
