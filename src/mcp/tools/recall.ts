import type { MycoIndex } from '../../index/sqlite.js';

interface RecallInput {
  branch?: string;
  files?: string[];
}

interface RecallResult {
  active_plans: Array<{ id: string; title: string; status: string }>;
  recent_sessions: Array<{ id: string; title: string; summary: string }>;
  relevant_memories: Array<{ id: string; title: string; type: string }>;
  team_activity: Array<{ user: string; session_id: string; summary: string }>;
}

export async function handleMycoRecall(
  index: MycoIndex,
  input: RecallInput,
): Promise<RecallResult> {
  const allPlans = index.query({ type: 'plan' });
  const activePlans = allPlans.filter((p) => {
    const status = (p.frontmatter as any)?.status;
    return status === 'active' || status === 'in_progress';
  });

  let sessions = index.query({ type: 'session', limit: 10 });
  if (input.branch) {
    sessions = sessions.filter((s) => {
      const branch = (s.frontmatter as any)?.branch;
      return branch === input.branch;
    });
  }

  const memories = index.query({ type: 'memory', limit: 5 });

  return {
    active_plans: activePlans.map((p) => ({
      id: p.id,
      title: p.title,
      status: String((p.frontmatter as any)?.status ?? 'active'),
    })),
    recent_sessions: sessions.slice(0, 5).map((s) => ({
      id: s.id,
      title: s.title,
      summary: s.content.slice(0, 200),
    })),
    relevant_memories: memories.map((m) => ({
      id: m.id,
      title: m.title,
      type: String((m.frontmatter as any)?.observation_type ?? 'discovery'),
    })),
    team_activity: [],
  };
}
