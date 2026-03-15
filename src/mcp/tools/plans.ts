import type { MycoIndex } from '../../index/sqlite.js';
import { planFm, sessionFm } from '../../vault/frontmatter.js';

interface PlansInput {
  status?: 'active' | 'in_progress' | 'completed' | 'abandoned' | 'all';
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
    plans = allPlans.filter((p) => planFm(p).status === input.status);
  }

  return plans.map((p) => {
    const f = planFm(p);
    return {
      id: p.id,
      title: p.title,
      status: f.status ?? 'active',
      progress: extractProgress(p.content),
      tags: f.tags ?? [],
    };
  });
}

function getPlanDetail(index: MycoIndex, planId: string): PlanDetail {
  const plans = index.query({ type: 'plan', id: planId });
  if (plans.length === 0) {
    throw new Error(`Plan not found: ${planId}`);
  }

  const plan = plans[0];
  const f = planFm(plan);

  // Query sessions that reference this plan — use SQL to avoid loading all sessions
  const allSessions = index.query({ type: 'session', limit: 100 });
  const linkedSessions = allSessions.filter((s) => {
    const sf = sessionFm(s);
    const planRef = sf.plan;
    const plansArr = sf.plans;
    return planRef === `[[${planId}]]` || planRef === planId
      || plansArr?.includes(planId) || plansArr?.includes(`[[${planId}]]`);
  });

  return {
    id: plan.id,
    title: plan.title,
    status: f.status ?? 'active',
    progress: extractProgress(plan.content),
    tags: f.tags ?? [],
    content: plan.content,
    sessions: linkedSessions.map((s) => {
      const sf = sessionFm(s);
      return {
        id: s.id,
        title: s.title,
        started: sf.started ?? s.created,
      };
    }),
  };
}

function extractProgress(content: string): string {
  const checked = (content.match(/- \[x\]/gi) ?? []).length;
  const unchecked = (content.match(/- \[ \]/g) ?? []).length;
  const total = checked + unchecked;
  if (total === 0) return 'N/A';
  return `${checked}/${total}`;
}
