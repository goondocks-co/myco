import { Link, useParams, useSearchParams } from 'react-router-dom';
import { PlanCard } from '../components/sessions/PlanCard';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { PageLoading } from '../components/ui/page-loading';
import { SubtabPill } from '../components/ui/subtab-pill';
import { PLAN_FILTERS, useProjectPlans } from '../hooks/use-plans';

const DEFAULT_FILTER = 'all';

const isFilter = (value: string | null): boolean => value !== null && PLAN_FILTERS.some((f) => f.id === value);

/**
 * `/p/:projectId/plans`: every plan this project holds, newest edit first.
 *
 * The card is the session timeline's own, so a plan reads the same here as it does
 * under the turn that wrote it, and its status is set through the one route that
 * owns a plan's status. The status filter lives in the URL, and the server filters.
 */
export function Plans() {
  const { projectId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const status = isFilter(params.get('status')) ? params.get('status')! : DEFAULT_FILTER;
  const plans = useProjectPlans(projectId, status);
  const rows = plans.data?.plans ?? [];

  return (
    <PageContainer>
      <PageHeader title="Plans" subtitle="What this project set out to do, and how far each one got." />
      <div className="mb-2">
        <SubtabPill
          tabs={PLAN_FILTERS.map((f) => ({ id: f.id, label: f.label }))}
          activeTab={status}
          onTabChange={(id) => setParams((prev) => {
            const next = new URLSearchParams(prev);
            if (id === DEFAULT_FILTER) next.delete('status'); else next.set('status', id);
            return next;
          }, { replace: true })}
        />
      </div>
      <PageLoading isLoading={plans.isPending} error={plans.error}>
        {rows.length === 0 ? (
          <p className="font-sans text-sm text-on-surface-variant">
            {status === DEFAULT_FILTER
              ? 'No plans yet. A plan appears here when a session writes one.'
              : `No ${PLAN_FILTERS.find((f) => f.id === status)!.label.toLowerCase()} plans.`}
          </p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-3 p-0" aria-label="Plans">
            {rows.map((plan) => (
              <li key={plan.planKey}>
                <PlanCard
                  projectId={projectId}
                  sessionId={plan.sessionId}
                  plan={plan}
                  meta={<>
                    <Link
                      to={`/p/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(plan.sessionId)}`}
                      className="text-primary underline"
                    >
                      Open its session
                    </Link>
                    {plan.tags.length > 0 && <span className="font-mono text-[11px]">{plan.tags.join(' · ')}</span>}
                  </>}
                />
              </li>
            ))}
          </ul>
        )}
      </PageLoading>
    </PageContainer>
  );
}
