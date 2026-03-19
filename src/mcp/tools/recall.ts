import type { MycoIndex } from '../../index/sqlite.js';
import { planFm, sessionFm, sporeFm } from '../../vault/frontmatter.js';
import { RECALL_SUMMARY_PREVIEW_CHARS } from '../../constants.js';

interface RecallInput {
  branch?: string;
  files?: string[];
}

interface RecallResult {
  active_plans: Array<{ id: string; title: string; status: string }>;
  recent_sessions: Array<{ id: string; title: string; summary: string }>;
  relevant_spores: Array<{ id: string; title: string; type: string }>;
  team_activity: Array<{ user: string; session_id: string; summary: string }>;
}

export async function handleMycoRecall(
  index: MycoIndex,
  input: RecallInput,
): Promise<RecallResult> {
  const allPlans = index.query({ type: 'plan' });
  const activePlans = allPlans.filter((p) => {
    const status = planFm(p).status;
    return status === 'active' || status === 'in_progress';
  });

  let sessions = index.query({ type: 'session', limit: 10 });
  if (input.branch) {
    sessions = sessions.filter((s) => sessionFm(s).branch === input.branch);
  }

  const spores = index.query({ type: 'spore', limit: 5 })
    .filter((m) => sporeFm(m).status !== 'superseded' && sporeFm(m).status !== 'archived');

  return {
    active_plans: activePlans.map((p) => ({
      id: p.id,
      title: p.title,
      status: planFm(p).status ?? 'active',
    })),
    recent_sessions: sessions.slice(0, 5).map((s) => ({
      id: s.id,
      title: s.title,
      summary: s.content.slice(0, RECALL_SUMMARY_PREVIEW_CHARS),
    })),
    relevant_spores: spores.map((m) => ({
      id: m.id,
      title: m.title,
      type: sporeFm(m).observation_type ?? 'discovery',
    })),
    team_activity: [],
  };
}
