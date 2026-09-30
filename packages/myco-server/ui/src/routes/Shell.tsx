import { useEffect, useState, type ReactNode } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Search } from 'lucide-react';
import {
  AccountMenu, AppShell, BottomBar, Brand, ErrorState, IconButton, LoadingState, NavItem, NavSection, ProjectFilter, SearchTrigger,
  Sidebar, StatusChip, useSearchShortcut, useShellMenu, type ProjectFilterItem,
} from '../design';
import { Search as SearchPanel } from '../features/search/Search';
import { useAttention } from '../hooks/use-attention';
import { useIsAdmin, useMe } from '../hooks/use-me';
import { useProjects } from '../hooks/use-projects';
import { isArchived, type ProjectSummary } from '../lib/api';
import { readLastProject, rememberProject } from '../lib/project-memory';
import { memberDisplayName } from '../lib/member-name';
import { signOut } from '../lib/session';
import { NotAMember } from '../pages/NotAMember';
import {
  ADMIN_PAGES, HEALTH_PATH, MY_MACHINES_PATH, pageHref, pageIsOpen, PHONE_PAGES, PROJECT_PAGES, PROJECTS_PATH, clearProjectHref, projectOf, switchProjectHref, titleOf,
} from './nav';

/** Most recent activity first; a project with none sorts last, then by name. */
function byRecency(a: ProjectSummary, b: ProjectSummary): number {
  return (b.lastActivityAt ?? -1) - (a.lastActivityAt ?? -1) || a.name.localeCompare(b.name);
}

/**
 * The signed-in dashboard: the shell around every page, with the nav, the
 * project filter, search and the account menu. The project a page is scoped
 * to comes from its path; a page that spans the server keeps the project last
 * opened in the nav's links, so the way back is one click.
 */
export function Shell() {
  const me = useMe();
  const member = me.data?.member ?? null;
  // Projects are read only for a member; a signed-in non-member sees how to become one instead.
  const projects = useProjects({ enabled: member !== null });
  const admin = useIsAdmin();
  const location = useLocation();
  const [searchOpen, setSearchOpen] = useState(false);
  useSearchShortcut(() => setSearchOpen((open) => !open));

  const all = projects.data?.projects ?? [];
  const inPath = projectOf(location.pathname);
  const current = inPath === null ? undefined : all.find((p) => p.projectId === inPath);
  useEffect(() => { if (current) rememberProject(current.projectId); }, [current]);

  if (me.data && member === null) return <NotAMember login={me.data.login} />;

  // An archived project leaves the nav, unless it is the one open.
  const listed = all.filter((p) => !isArchived(p) || p.projectId === current?.projectId).sort(byRecency);
  const remembered = readLastProject();
  const scope = current ?? listed.find((p) => p.projectId === remembered) ?? listed[0];
  const pages = PROJECT_PAGES.filter((page) => admin || page.admin !== true);
  const name = memberDisplayName(member, me.data?.login);

  const filterItems: ProjectFilterItem[] = listed.map((p) => ({
    projectId: p.projectId,
    name: p.name,
    sessionCount: p.sessionCount,
    lastActivityAt: p.lastActivityAt,
    href: switchProjectHref(location, p.projectId),
    active: p.projectId === current?.projectId,
  }));

  const account = (compact: boolean) => (
    <AccountMenu
      name={name}
      login={me.data?.login}
      role={member?.role === 'admin' ? 'Admin' : 'Member'}
      machinesHref={MY_MACHINES_PATH}
      onSignOut={() => void signOut()}
      compact={compact}
      align={compact ? 'end' : 'start'}
    />
  );

  const sidebar = (
    <ShellSidebar
      pages={scope === undefined ? [] : pages.map((page) => ({ ...page, to: pageHref(page, location.pathname, scope.projectId), active: pageIsOpen(page, location.pathname) }))}
      projects={projects.isSuccess ? filterItems : null}
      clearHref={clearProjectHref(location)}
      admin={admin}
      account={account(false)}
      onSearch={() => setSearchOpen(true)}
    />
  );

  return (
    <AppShell
      sidebar={sidebar}
      title={titleOf(location.pathname)}
      headerActions={(
        <>
          <IconButton label="Search" onClick={() => setSearchOpen(true)}>
            <Search aria-hidden className="size-[18px]" />
          </IconButton>
          {account(true)}
        </>
      )}
      bottomBar={scope === undefined ? undefined : (
        <BottomBar items={PHONE_PAGES.map((page) => ({ label: page.label, icon: page.icon, to: pageHref(page, location.pathname, scope.projectId), active: pageIsOpen(page, location.pathname) }))} />
      )}
      overlay={(
        <SearchPanel
          key={`${scope?.projectId ?? ''}/${current === undefined ? '' : 'scoped'}`}
          open={searchOpen}
          onOpenChange={setSearchOpen}
          project={scope === undefined ? null : { projectId: scope.projectId, name: scope.name }}
          scoped={current !== undefined}
          projectName={(id) => all.find((p) => p.projectId === id)?.name ?? null}
        />
      )}
    >
      {projects.isPending ? <LoadingState label="Loading projects" />
        : projects.isError ? <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
        : <Outlet />}
    </AppShell>
  );
}

interface ShellSidebarProps {
  pages: ReadonlyArray<(typeof PROJECT_PAGES)[number] & { to: string; active: boolean }>;
  /** The project filter's rows, or null while the list is unread. */
  projects: ProjectFilterItem[] | null;
  clearHref: string | null;
  admin: boolean;
  account: ReactNode;
  onSearch: () => void;
}

/** The nav column's contents, the same in the column and in the drawer. */
function ShellSidebar({ pages, projects, clearHref, admin, account, onSearch }: ShellSidebarProps) {
  const { closeMenu } = useShellMenu();
  return (
    <Sidebar
      top={(
        <>
          <Brand onNavigate={closeMenu} />
          <SearchTrigger onOpen={() => { closeMenu(); onSearch(); }} />
          {pages.length > 0 && (
            <NavSection label="Pages">
              {pages.map((page) => (
                <NavItem key={page.label} to={page.to} label={page.label} icon={page.icon} active={page.active} onNavigate={closeMenu} />
              ))}
            </NavSection>
          )}
        </>
      )}
      middle={projects === null ? undefined : <ProjectFilter items={projects} clearHref={clearHref} allHref={PROJECTS_PATH} onNavigate={closeMenu} />}
      foot={admin ? (
        <NavSection label="Admin">
          {ADMIN_PAGES.map((page) => (
            <NavItem
              key={page.to}
              to={page.to}
              label={page.label}
              icon={page.icon}
              badge={page.to === HEALTH_PATH ? <NeedsYouCount /> : undefined}
              onNavigate={closeMenu}
            />
          ))}
        </NavSection>
      ) : undefined}
      account={account}
    />
  );
}

/**
 * How many things need an admin, beside Health in the nav: nothing while the
 * answer is unread or empty. Only an admin's nav renders it, so a member's
 * browser never asks.
 */
function NeedsYouCount() {
  const attention = useAttention({ enabled: true });
  const count = attention.data?.items.length ?? 0;
  if (count === 0) return null;
  return (
    <StatusChip tone="warn" data-needs-you-count="">
      {count}
      <span className="sr-only"> {count === 1 ? 'thing needs' : 'things need'} you</span>
    </StatusChip>
  );
}
