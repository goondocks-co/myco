import type { MycoIndex } from '../index/sqlite.js';
import type { MycoConfig } from '../config/schema.js';
import { scoreRelevance, type ScoredNote } from './relevance.js';

interface InjectionContext {
  branch?: string;
  files?: string[];
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
    ['active', 'in_progress'].includes(String((p.frontmatter as any)?.status ?? '')),
  );
  const plansText = formatLayer(
    'Active Plans',
    activePlans.map((p) => `- **${p.title}** (${(p.frontmatter as any)?.status}): ${p.content.slice(0, 100)}`),
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
      `- **${s.note.title}**: ${s.note.content.slice(0, 80)} (${s.reason})`,
    ),
    budgets.sessions,
  );

  // Layer 3: Relevant memories
  const memories = index.query({ type: 'memory', limit: 20 });
  const scoredMemories = scoreRelevance(memories, {
    branch: context.branch,
    activePlanIds,
  });
  const memoriesText = formatLayer(
    'Relevant Memories',
    scoredMemories.slice(0, 5).map((m) =>
      `- **${m.note.title}** (${(m.note.frontmatter as any)?.observation_type}): ${m.note.content.slice(0, 80)}`,
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
  // Rough estimate: ~4 chars per token
  return Math.ceil(text.length / 4);
}
