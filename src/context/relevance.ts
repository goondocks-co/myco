import type { IndexedNote } from '../index/sqlite.js';

export interface ScoredNote {
  note: IndexedNote;
  score: number;
  reason: string;
}

interface RelevanceInput {
  branch?: string;
  files?: string[];
  activePlanIds?: string[];
}

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
      const hoursOld = age / (1000 * 60 * 60);
      if (hoursOld < 24) {
        score += 3;
        reasons.push('recent (<24h)');
      } else if (hoursOld < 72) {
        score += 2;
        reasons.push('recent (<72h)');
      } else if (hoursOld < 168) {
        score += 1;
        reasons.push('recent (<1w)');
      }

      // Branch match
      if (input.branch && fm.branch === input.branch) {
        score += 3;
        reasons.push('same branch');
      }

      // Plan match
      if (input.activePlanIds?.length) {
        const planRef = fm.plan as string | undefined;
        if (planRef && input.activePlanIds.some((id) =>
          planRef === `[[${id}]]` || planRef === id,
        )) {
          score += 2;
          reasons.push('active plan');
        }
      }

      return { note, score, reason: reasons.join(', ') };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
}
