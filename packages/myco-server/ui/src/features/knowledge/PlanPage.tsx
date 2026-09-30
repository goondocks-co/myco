import { useEffect, useState, type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import {
  Button, Card, CopyButton, ErrorState, FactRow, FactsPanel, focusRing, Link, LoadingState, Progress, Select, StatusChip, TypeChip,
} from '../../design';
import { useMembers } from '../../hooks/use-access';
import { usePlan, type PlanWithSession } from '../../hooks/use-knowledge';
import { useIsAdmin } from '../../hooks/use-me';
import { useSession, useSetPlanStatus } from '../../hooks/use-sessions';
import { useNow } from '../../hooks/use-today';
import { ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { sessionHeadingText } from '../../lib/session-text';
import { NotFound } from '../../pages/NotFound';
import { KNOWLEDGE_SUFFIX, PLANS_SUFFIX, projectPath } from '../../routes/nav';
import { TextOrBlob } from '../sessions/StoredText';
import { dateTime } from '../sessions/words';
import { ago, authorName, PLAN_COLUMNS, planStatusTone, planStatusWord, planTitle, progressParts, progressWords, type PlanStatus } from './words';

export interface PlanPageProps {
  projectId: string;
  planKey: string;
  /** The session a link says wrote the plan; the page finds it without one, a little slower. */
  sessionHint: string | null;
  /** The project's name, or null while the dashboard does not know it. */
  projectName: string | null;
}

/**
 * One plan as a reading page: its title and status, how far its items have
 * got, the plan in full at a readable width, and beside it the session that
 * wrote it and its facts. An admin sets its status here.
 */
export function PlanPage({ projectId, planKey, sessionHint, projectName }: PlanPageProps) {
  const plan = usePlan(projectId, planKey, sessionHint);
  const now = useNow();
  if (plan.error instanceof ApiError && plan.error.status === 404) return <NotFound />;
  if (plan.data === undefined) {
    if (plan.isPending) return <LoadingState shape="reading" label="Loading the plan" />;
    return <ErrorState error={plan.error} onRetry={() => void plan.refetch()} />;
  }
  return <Reading plan={plan.data} projectId={projectId} projectName={projectName ?? 'A project'} now={now} />;
}

function Reading({ plan, projectId, projectName, now }: { plan: PlanWithSession; projectId: string; projectName: string; now: number }) {
  const parts = progressParts(plan.progress);
  const admin = useIsAdmin();
  const members = useMembers();
  const setBy = plan.updatedBy === null ? null : authorName(plan.updatedBy, members.data?.members);
  return (
    <article data-plan-page="" className="flex w-full flex-col gap-s5">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-s1 t-small text-muted">
          <li><Crumb to={projectPath(projectId, KNOWLEDGE_SUFFIX)}>Knowledge</Crumb></li>
          <li aria-hidden><ChevronRight className="size-s4" /></li>
          <li><Crumb to={projectPath(projectId, PLANS_SUFFIX)}>Plans</Crumb></li>
          <li aria-hidden><ChevronRight className="size-s4" /></li>
          <li><Crumb to={projectPath(projectId)}>{projectName}</Crumb></li>
        </ol>
      </nav>

      <div className="grid items-start gap-s6 lg:grid-reading lg:gap-x-s10">
        <div className="flex min-w-0 max-w-measure flex-col gap-s5">
          <header className="flex flex-col gap-s3">
            <p className="flex flex-wrap items-center gap-x-s2 gap-y-s1 t-small text-muted">
              <StatusChip tone={planStatusTone(plan.status)} data-plan-status="">{planStatusWord(plan.status)}</StatusChip>
              <span className="font-medium text-ink-2">{projectName}</span>
              <span aria-hidden>·</span>
              <span>updated {ago(plan.updatedAt, now)}</span>
            </p>
            <h1 className={cn('t-display', plan.title === null || plan.title.trim() === '' ? 'text-muted' : 'text-ink')} data-plan-title="">{planTitle(plan)}</h1>
            {parts !== null && (
              <div className="flex max-w-progress flex-col gap-s1" data-plan-progress="">
                <Progress done={parts.checked} total={parts.total} label="Plan items done" />
                <span className="t-small text-muted">{progressWords(plan.progress)}</span>
              </div>
            )}
          </header>
          <section aria-label="The plan" data-plan-body="">
            <TextOrBlob projectId={projectId} text={plan.content === null ? null : withoutTitle(plan.content, plan.title)} blobKey={plan.blobKey} markdown />
          </section>
        </div>

        <aside aria-label="About this plan" className="flex min-w-0 flex-col gap-s4">
          <WrittenIn projectId={projectId} sessionId={plan.sessionId} promptId={plan.promptId} />
          <FactsPanel title="Facts" actions={<CopyButton value={plan.planKey} label="Copy plan key" variant="secondary" />}>
            <FactRow term="Project">{projectName}</FactRow>
            <FactRow term="Status">
              {admin ? <StatusControl projectId={projectId} plan={plan} /> : planStatusWord(plan.status)}
            </FactRow>
            {setBy !== null && <FactRow term="Status set by">{setBy}</FactRow>}
            <FactRow term="Written">{dateTime(plan.createdAt, now)}</FactRow>
            {plan.updatedAt !== plan.createdAt && <FactRow term="Updated">{dateTime(plan.updatedAt, now)}</FactRow>}
            {plan.originPath !== null && plan.originPath.trim() !== '' && <FactRow term="File" mono>{plan.originPath}</FactRow>}
            {plan.tags.length > 0 && (
              <FactRow term="Tags">
                <span className="inline-flex flex-wrap justify-end gap-s1">{plan.tags.map((tag) => <TypeChip key={tag}>{tag}</TypeChip>)}</span>
              </FactRow>
            )}
          </FactsPanel>
        </aside>
      </div>
    </article>
  );
}

/** A plan's text without its own leading heading when that heading is the title the page already shows. */
export function withoutTitle(content: string, title: string | null): string {
  const match = /^\s*#{1,6}[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(content);
  if (match === null || title === null) return content;
  const same = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase();
  return same(match[1]!) === same(title) ? content.slice(match[0].length).replace(/^\s*\n/, '') : content;
}

function Crumb({ to, children }: { to: string; children: ReactNode }) {
  return <RouterLink to={to} className={cn('rounded-chip hover:text-ink hover:underline', focusRing)}>{children}</RouterLink>;
}

/** The session that wrote the plan, by its title, and the turn it came from. */
function WrittenIn({ projectId, sessionId, promptId }: { projectId: string; sessionId: string; promptId: string | null }) {
  const session = useSession(projectId, sessionId);
  const base = projectPath(projectId, `/sessions/${encodeURIComponent(sessionId)}`);
  const turn = promptId === null ? null : `${base}?${new URLSearchParams({ turn: promptId })}`;
  const gone = session.error instanceof ApiError && session.error.status === 404;
  return (
    <Card className="flex flex-col gap-s2" data-plan-session="">
      <h2 className="t-h3 text-ink">Written in</h2>
      {gone ? <p className="t-small text-muted">A session this project no longer holds.</p> : (
        <>
          {session.data === undefined
            ? <span className="t-small text-muted">{session.isPending ? 'Loading the session…' : 'A session'}</span>
            : <span className="t-small font-medium text-ink">{sessionHeadingText(session.data.session)}</span>}
          <span className="flex flex-wrap gap-x-s4 gap-y-s1 t-small">
            <Link to={base}>Open the session →</Link>
            {turn !== null && <Link to={turn}>The turn it came from →</Link>}
          </span>
        </>
      )}
    </Card>
  );
}

const STATUS_OPTIONS = PLAN_COLUMNS.map((status) => ({ value: status, label: planStatusWord(status) }));

/**
 * An admin's status control: a status is picked, then saved with its own
 * button, so a keystroke in the closed select never writes by itself. The
 * write is made as the signed-in member, and the page reads the plan again.
 */
function StatusControl({ projectId, plan }: { projectId: string; plan: PlanWithSession }) {
  const set = useSetPlanStatus(projectId, plan.sessionId);
  const [draft, setDraft] = useState(plan.status);
  useEffect(() => { setDraft(plan.status); }, [plan.status]);
  const known = (PLAN_COLUMNS as readonly string[]).includes(draft);
  const changed = draft !== plan.status;
  return (
    <span className="inline-flex flex-col items-end gap-s2" data-plan-status-control="">
      <Select
        label="Plan status"
        value={draft}
        onValueChange={setDraft}
        options={known ? STATUS_OPTIONS : [...STATUS_OPTIONS, { value: draft, label: planStatusWord(draft) }]}
        className="w-select"
      />
      {changed && (
        <span className="inline-flex gap-s2">
          <Button size="sm" variant="ghost" onClick={() => setDraft(plan.status)} disabled={set.isPending}>Cancel</Button>
          <Button size="sm" variant="primary" pending={set.isPending} onClick={() => set.mutate({ planKey: plan.planKey, status: draft as PlanStatus })}>
            Save status
          </Button>
        </span>
      )}
      {set.error && <span role="alert" className="t-meta text-bad">The status could not be saved.</span>}
    </span>
  );
}
