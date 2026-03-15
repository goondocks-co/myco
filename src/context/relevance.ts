import type { IndexedNote } from '../index/sqlite.js';

export interface ScoredNote {
  note: IndexedNote;
  score: number;
  reason: string;
}

interface RelevanceInput {
  branch?: string;
  activePlanIds?: string[];
}

// --- Recency thresholds (hours) and score weights ---
const RECENCY_TIERS = [
  { maxHours: 24, score: 3, label: 'recent (<24h)' },
  { maxHours: 72, score: 2, label: 'recent (<72h)' },
  { maxHours: 168, score: 1, label: 'recent (<1w)' },
] as const;

const BRANCH_MATCH_SCORE = 3;
const PLAN_MATCH_SCORE = 2;

const MS_PER_HOUR = 3_600_000;

export function scoreRelevance(
  notes: IndexedNote[],
  input: RelevanceInput,
): ScoredNote[] {
  return notes
    .map((note) => {
      let score = 0;
      const reasons: string[] = [];

      const fm = note.frontmatter as Record<string, unknown>;

      // Recency boost
      const age = Date.now() - new Date(note.created).getTime();
      const hoursOld = age / MS_PER_HOUR;
      for (const tier of RECENCY_TIERS) {
        if (hoursOld < tier.maxHours) {
          score += tier.score;
          reasons.push(tier.label);
          break;
        }
      }

      // Branch match
      if (input.branch && fm.branch === input.branch) {
        score += BRANCH_MATCH_SCORE;
        reasons.push('same branch');
      }

      // Plan match
      if (input.activePlanIds?.length) {
        const planRef = fm.plan as string | undefined;
        if (planRef && input.activePlanIds.some((id) =>
          planRef === `[[${id}]]` || planRef === id,
        )) {
          score += PLAN_MATCH_SCORE;
          reasons.push('active plan');
        }
      }

      return { note, score, reason: reasons.join(', ') };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
}
