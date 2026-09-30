import { Link as RouterLink } from 'react-router-dom';
import { focusRing, StatusChip } from '../../design';
import { planPagePath } from '../../hooks/use-knowledge';
import { cn } from '../../lib/cn';
import { ago, planStatusTone, planStatusWord, planTitle, progressWords } from './words';

export interface PlanLineProps {
  projectId: string;
  sessionId: string;
  plan: { planKey: string; title: string | null; status: string; progress: string; updatedAt: number };
  now: number;
}

/** A plan where a session lists it: its status, its title leading to its own page, how far its items have got, and when it last changed. */
export function PlanLine({ projectId, sessionId, plan, now }: PlanLineProps) {
  const progress = progressWords(plan.progress);
  return (
    <div className="relative flex flex-col gap-s1 rounded-card border border-line bg-surface-1 px-s4 py-s3 transition-colors duration-120 hover:bg-surface-2" data-plan-line={plan.status}>
      <span className="flex flex-wrap items-center gap-x-s2 gap-y-s1 t-meta text-muted">
        <StatusChip tone={planStatusTone(plan.status)}>{planStatusWord(plan.status)}</StatusChip>
        {progress !== null && <span>{progress}</span>}
        <span aria-hidden>·</span>
        <span>updated {ago(plan.updatedAt, now)}</span>
      </span>
      <RouterLink
        to={planPagePath(projectId, { planKey: plan.planKey, sessionId })}
        className={cn('w-fit rounded-chip t-body font-medium text-ink after:absolute after:inset-0 after:rounded-card hover:underline', focusRing)}
      >
        {planTitle(plan)}
      </RouterLink>
    </div>
  );
}
