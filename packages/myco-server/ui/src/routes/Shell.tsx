import { useEffect, useState, type ReactNode } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Search } from 'lucide-react';
import {
  AccountMenu, AppShell, BottomBar, Brand, ErrorState, IconButton, NavItem, NavSection, SearchTrigger,
  Sidebar, StatusChip, useSearchShortcut, useShellMenu,
} from '../design';
import { Search as SearchPanel } from '../features/search/Search';
import { useAttention } from '../hooks/use-attention';
import { useIsAdmin, useMe } from '../hooks/use-me';
import { useProjects } from '../hooks/use-projects';
import { readLastProject, rememberProject } from '../lib/project-memory';
import { memberDisplayName } from '../lib/member-name';
import { signOut } from '../lib/session';
import { NotAMember } from '../pages/NotAMember';
import {
  ADMIN_PAGES, HEALTH_PATH, MY_MACHINES_PATH, pageHref, pageIsOpen, PHONE_PAGES, PROJECT_PAGES, projectOf, titleOf,
} from './nav';
import { scopeProjects } from './scope';

/**
 * The signed-in dashboard: the shell around every page, with the nav, search
 * and the account menu. The nav lists pages only; which projects a page shows
 * is said and changed in the page's own header. The project a page is scoped
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

  // An archived project is never the nav's fallback, unless it is the one open.
  const listed = scopeProjects(all, current?.projectId ?? null);
  const remembered = readLastProject();
  const scope = current ?? listed.find((p) => p.projectId === remembered) ?? listed[0];
  const pages = PROJECT_PAGES.filter((page) => admin || page.admin !== true);
  const name = memberDisplayName(member, me.data?.login);

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
      {/* The page starts its own reads at once, beside the projects' read, rather than after it: a page that needs a
          project's name shows it when the list arrives, and one whose project the list lacks says not found then. */}
      {projects.isError ? <ErrorState error={projects.error} onRetry={() => void projects.refetch()} /> : <Outlet />}
    </AppShell>
  );
}

interface ShellSidebarProps {
  pages: ReadonlyArray<(typeof PROJECT_PAGES)[number] & { to: string; active: boolean }>;
  admin: boolean;
  account: ReactNode;
  onSearch: () => void;
}

/** The nav column's contents, the same in the column and in the drawer. */
function ShellSidebar({ pages, admin, account, onSearch }: ShellSidebarProps) {
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
    <>
      <StatusChip tone="warn" data-needs-you-count="" aria-hidden>{count}</StatusChip>
      <span className="sr-only">, {count} {count === 1 ? 'thing needs' : 'things need'} you</span>
    </>
  );
}
