import type { MycoIndex } from '../../index/sqlite.js';

interface PlansInput {
  status?: 'active' | 'completed' | 'all';
  id?: string;
}

interface PlanSummary {
  id: string;
  title: string;
  status: string;
  progress: string;
  tags: string[];
}

interface PlanDetail extends PlanSummary {
  content: string;
  sessions: Array<{ id: string; title: string; started: string }>;
}

export async function handleMycoPlans(
  index: MycoIndex,
  input: PlansInput,
): Promise<PlanSummary[] | PlanDetail> {
  if (input.id) {
    return getPlanDetail(index, input.id);
  }

  const allPlans = index.query({ type: 'plan' });
  let plans = allPlans;

  if (input.status && input.status !== 'all') {
    plans = allPlans.filter((p) => {
      const status = (p.frontmatter as any)?.status;
      return status === input.status;
    });
  }

  return plans.map((p) => ({
    id: p.id,
    title: p.title,
    status: String((p.frontmatter as any)?.status ?? 'active'),
    progress: extractProgress(p.content),
    tags: ((p.frontmatter as any)?.tags as string[]) ?? [],
  }));
}

function getPlanDetail(index: MycoIndex, planId: string): PlanDetail {
  const plans = index.query({ type: 'plan', id: planId });
  if (plans.length === 0) {
    throw new Error(`Plan not found: ${planId}`);
  }

  const plan = plans[0];

  // Derive sessions that reference this plan (unidirectional: session → plan)
  const allSessions = index.query({ type: 'session' });
  const linkedSessions = allSessions.filter((s) => {
    const planRef = (s.frontmatter as any)?.plan;
    return planRef === `[[${planId}]]` || planRef === planId;
  });

  return {
    id: plan.id,
    title: plan.title,
    status: String((plan.frontmatter as any)?.status ?? 'active'),
    progress: extractProgress(plan.content),
    tags: ((plan.frontmatter as any)?.tags as string[]) ?? [],
    content: plan.content,
    sessions: linkedSessions.map((s) => ({
      id: s.id,
      title: s.title,
      started: String((s.frontmatter as any)?.started ?? s.created),
    })),
  };
}

function extractProgress(content: string): string {
  const checked = (content.match(/- \[x\]/gi) ?? []).length;
  const unchecked = (content.match(/- \[ \]/g) ?? []).length;
  const total = checked + unchecked;
  if (total === 0) return 'N/A';
  return `${checked}/${total}`;
}
