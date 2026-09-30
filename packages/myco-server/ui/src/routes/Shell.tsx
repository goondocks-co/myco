import { useEffect, useState, type ReactNode } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Search } from 'lucide-react';
import {
  AccountMenu, AppShell, BottomBar, Brand, ErrorState, IconButton, LoadingState, NavGroup, NavItem, NavSection, ProjectFilter, SearchCommand, SearchTrigger,
  Sidebar, useSearchShortcut, useShellMenu, type ProjectFilterItem,
} from '../design';
import { useIsAdmin, useMe } from '../hooks/use-me';
import { useProjects } from '../hooks/use-projects';
import { isArchived, type ProjectSummary } from '../lib/api';
import { readLastProject, rememberProject } from '../lib/project-memory';
import { signOut } from '../lib/session';
import { NotAMember } from '../pages/NotAMember';
import {
  ADMIN_PAGES, MY_MACHINES_PATH, inGroup, PHONE_PAGES, PROJECT_PAGES, PROJECTS_PATH, clearProjectHref, projectOf, projectPath, switchProjectHref, titleOf,
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
  const name = member?.label ?? me.data?.login ?? '';

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
      pages={scope === undefined ? [] : pages.map((page) => ({ ...page, to: projectPath(scope.projectId, page.suffix) }))}
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
      title={titleOf(location.pathname, admin ? 'admin' : 'member')}
      headerActions={(
        <>
          <IconButton label="Search" onClick={() => setSearchOpen(true)}>
            <Search aria-hidden className="size-[18px]" />
          </IconButton>
          {account(true)}
        </>
      )}
      bottomBar={scope === undefined ? undefined : (
        <BottomBar items={PHONE_PAGES.map((page) => ({ label: page.label, icon: page.icon, to: projectPath(scope.projectId, page.suffix), end: page.suffix === '' }))} />
      )}
      overlay={(
        <SearchCommand
          key={scope?.projectId ?? ''}
          open={searchOpen}
          onOpenChange={setSearchOpen}
          project={scope === undefined ? null : { projectId: scope.projectId, name: scope.name }}
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
  pages: ReadonlyArray<(typeof PROJECT_PAGES)[number] & { to: string }>;
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
  const { pathname } = useLocation();
  return (
    <Sidebar
      top={(
        <>
          <Brand onNavigate={closeMenu} />
          <SearchTrigger onOpen={() => { closeMenu(); onSearch(); }} />
          {pages.length > 0 && (
            <NavSection label="Pages">
              {pages.map((page) => (
                <NavItem key={page.label} to={page.to} label={page.label} icon={page.icon} end={page.suffix === ''} onNavigate={closeMenu} />
              ))}
            </NavSection>
          )}
        </>
      )}
      middle={projects === null ? undefined : <ProjectFilter items={projects} clearHref={clearHref} allHref={PROJECTS_PATH} onNavigate={closeMenu} />}
      foot={admin ? (
        <NavSection label="Admin">
          {ADMIN_PAGES.map((page) => (page.children === undefined
            ? <NavItem key={page.to} to={page.to} label={page.label} icon={page.icon} onNavigate={closeMenu} />
            : (
              <NavGroup
                key={page.to}
                item={{ to: page.to, label: page.label, icon: page.icon, onNavigate: closeMenu }}
                items={page.children.map((child) => ({ ...child, icon: page.icon, onNavigate: closeMenu }))}
                open={inGroup(page, pathname)}
              />
            )))}
        </NavSection>
      ) : undefined}
      account={account}
    />
  );
}
