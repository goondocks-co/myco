import { Link as RouterLink } from 'react-router-dom';
import { INVITE_CONTROLS } from '@goondocks/myco-shared/member-protocol';
import { Card, ErrorState, focusRing, LoadingState } from '../../../design';
import { useMembers } from '../../../hooks/use-access';
import { useProjects } from '../../../hooks/use-projects';
import { isArchived } from '../../../lib/api';
import { cn } from '../../../lib/cn';
import { MY_MACHINES_PATH, PEOPLE_PATH, PROJECT_SETTINGS_ANCHORS, PROJECT_SETTINGS_SUFFIX, projectPath } from '../../../routes/nav';
import { AdminSection, RowCard } from '../AdminFrame';
import { peopleOf } from '../members';

/** The projects list's anchor, where an older `?tab=capabilities` link lands. */
export const PROJECTS_ANCHOR = 'projects';

const linkClass = cn('shrink-0 rounded-chip t-small font-medium text-primary hover:underline', focusRing);

/** A row of words with one link at its end. */
function PointerRow({ title, detail, to, action, data }: { title: string; detail: string; to: string; action: string; data?: string }) {
  return (
    <div className="flex flex-col gap-s2 px-s4 py-s4 sm:flex-row sm:items-center sm:justify-between sm:gap-s6" data-pointer={data}>
      <div className="flex min-w-0 flex-col gap-s1">
        <span className="t-body font-medium text-ink">{title}</span>
        <span className="t-small text-muted">{detail}</span>
      </div>
      <RouterLink to={to} className={linkClass}>{action} →</RouterLink>
    </div>
  );
}

/**
 * Sign-in and access: who can sign in and where people and machines are
 * managed, and where each project's access keys live. Nothing here is a
 * setting of its own; each row leads to the page that holds it.
 */
export function AccessPointers() {
  const members = useMembers();
  const projects = useProjects();
  const people = peopleOf(members.data?.members ?? []).filter((m) => m.revokedAt === null);
  const linked = people.filter((m) => m.linked).length;
  const live = (projects.data?.projects ?? []).filter((p) => !isArchived(p));

  return (
    <>
      <AdminSection id="sign-in" title="Who can sign in" description="People sign in to this dashboard with the GitHub account connected to their membership. Machines sign in through myco login instead.">
        {members.isPending ? <LoadingState label="Loading members" count={2} />
          : members.isError ? <ErrorState error={members.error} onRetry={() => void members.refetch()} />
          : (
            <RowCard>
              <PointerRow
                data="people"
                title={`${people.length} ${people.length === 1 ? 'person' : 'people'}`}
                detail={linked === people.length
                  ? `${linked === 1 ? 'Their GitHub account is' : 'Each has a GitHub account'} connected.`
                  : `${linked} with a GitHub account connected; ${people.length - linked} without one yet, who can’t sign in here.`}
                to={PEOPLE_PATH}
                action={`Open ${INVITE_CONTROLS.page}`}
              />
              <PointerRow
                data="my-machines"
                title="Your machines"
                detail="The machines you signed in with myco login, and their settings."
                to={MY_MACHINES_PATH}
                action="Open My machines"
              />
            </RowCard>
          )}
      </AdminSection>
      <AdminSection id={PROJECTS_ANCHOR} title="Access keys by project" description="An access key lets an agent outside this server read one project and record what it finds. Each project keeps its own, beside what Myco does there and its repository.">
        {projects.isPending ? <LoadingState label="Loading projects" count={3} />
          : projects.isError ? <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
          : live.length === 0 ? <Card><p className="t-body text-muted">No project accepts capture yet.</p></Card>
          : (
            <RowCard label="Projects">
              {live.map((project) => (
                <PointerRow
                  key={project.projectId}
                  title={project.name}
                  detail="Access keys, repository, what Myco does there and release tracking."
                  to={`${projectPath(project.projectId, PROJECT_SETTINGS_SUFFIX)}#${PROJECT_SETTINGS_ANCHORS.accessKeys}`}
                  action="Project settings"
                />
              ))}
            </RowCard>
          )}
      </AdminSection>
    </>
  );
}
