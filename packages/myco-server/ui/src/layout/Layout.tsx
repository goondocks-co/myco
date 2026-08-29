import { Activity, Bell, Bot, Brain, FolderTree, KeyRound, LayoutDashboard, MessageSquare, Settings2, Sparkles, Users, Wrench } from 'lucide-react';
import { NavLink, Outlet, useNavigate, useParams } from 'react-router-dom';
import { PageLoading } from '../components/ui/page-loading';
import { useMe } from '../hooks/use-me';
import { useProjects } from '../hooks/use-projects';
import { isArchived, SignedOutError } from '../lib/api';
import { cn } from '../lib/cn';
import { rememberProject } from '../lib/project-memory';
import { NotAMember } from '../pages/NotAMember';
import { SignedOut } from '../pages/SignedOut';
import { AppearanceSection } from './AppearanceSection';
import { Topbar } from './Topbar';

interface ProjectNavItem {
  label: string;
  icon: typeof LayoutDashboard;
  /** Path suffix under `/p/:projectId`, or null while the page is still to come. */
  suffix: string | null;
}

/** Pages under a Project. A null suffix is a page a later slice delivers; it is shown so the shape is visible, and it is not a route. */
const PROJECT_NAV: ProjectNavItem[] = [
  { label: 'Overview', icon: LayoutDashboard, suffix: '' },
  { label: 'Sessions', icon: MessageSquare, suffix: '/sessions' },
  { label: 'Cortex', icon: Brain, suffix: '/cortex' },
  { label: 'Skills', icon: Sparkles, suffix: '/skills' },
  { label: 'Agent runs', icon: Bot, suffix: '/runs' },
  { label: 'Access', icon: KeyRound, suffix: '/access' },
];

const SERVER_NAV = [
  { label: 'Projects', icon: FolderTree, to: '/projects' },
  { label: 'Status', icon: Activity, to: '/status' },
  { label: 'Access', icon: Users, to: '/access' },
  { label: 'Settings', icon: Settings2, to: '/settings' },
  { label: 'Operations', icon: Wrench, to: '/operations' },
  { label: 'Notifications', icon: Bell, to: '/notifications' },
];

const linkClass = ({ isActive }: { isActive: boolean }) =>
  cn(
    'flex items-center gap-2 rounded-md px-2 py-1.5 font-sans text-sm transition-colors',
    isActive ? 'bg-surface-container-high text-on-surface' : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface',
  );

export function Layout() {
  const me = useMe();
  // Projects are read only for a member; a signed-in non-member sees the link instructions instead.
  const projects = useProjects({ enabled: me.data?.member != null });
  const params = useParams();
  const navigate = useNavigate();

  if (me.error instanceof SignedOutError) return <SignedOut />;
  if (me.data && me.data.member === null) return <NotAMember login={me.data.login} />;
  if (projects.error instanceof SignedOutError) return <SignedOut />;

  const all = projects.data?.projects ?? [];
  const current = params.projectId ? all.find((p) => p.projectId === params.projectId) : undefined;
  // Live projects, plus the archived one the page is on, so it stays navigable.
  const list = all.filter((p) => !isArchived(p) || p.projectId === current?.projectId);

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      <aside className="flex w-60 shrink-0 flex-col border-r border-outline-variant/20 bg-surface-container-low">
        <div className="flex h-12 items-center px-4 font-serif text-lg text-on-surface">Myco</div>

        <div className="px-3 pb-2">
          <label className="block font-sans text-[10px] uppercase tracking-wide text-on-surface-variant">Project</label>
          <select
            aria-label="Project"
            value={current?.projectId ?? ''}
            onChange={(e) => {
              const id = e.target.value;
              if (id === '') { navigate('/projects'); return; }
              rememberProject(id);
              navigate(`/p/${encodeURIComponent(id)}`);
            }}
            className="mt-1 w-full rounded-md border border-outline-variant/30 bg-surface-container px-2 py-1.5 font-sans text-sm text-on-surface"
          >
            <option value="">All projects…</option>
            {list.map((p) => (
              <option key={p.projectId} value={p.projectId}>{p.name}</option>
            ))}
          </select>
        </div>

        {current && (
          <nav aria-label="Project" className="flex flex-col gap-0.5 px-3 pb-3">
            {PROJECT_NAV.map((item) => {
              const Icon = item.icon;
              if (item.suffix === null) {
                return (
                  <span key={item.label} aria-disabled="true" title="Coming soon" className="flex items-center gap-2 rounded-md px-2 py-1.5 font-sans text-sm text-on-surface-variant/50">
                    <Icon className="h-4 w-4" />
                    {item.label}
                    <span className="ml-auto font-mono text-[10px] uppercase">soon</span>
                  </span>
                );
              }
              return (
                <NavLink key={item.label} to={`/p/${encodeURIComponent(current.projectId)}${item.suffix}`} end={item.suffix === ''} className={linkClass}>
                  <Icon className="h-4 w-4" />
                  {item.label}
                </NavLink>
              );
            })}
          </nav>
        )}

        <div className="px-3 pb-1 font-sans text-[10px] uppercase tracking-wide text-on-surface-variant">Server</div>
        <nav aria-label="Server" className="flex flex-col gap-0.5 px-3">
          {SERVER_NAV.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink key={item.to} to={item.to} className={linkClass}>
                <Icon className="h-4 w-4" />
                {item.label}
              </NavLink>
            );
          })}
        </nav>

        <div className="mt-auto border-t border-outline-variant/20 p-3">
          <div className="mb-2 font-sans text-[10px] uppercase tracking-wide text-on-surface-variant">Appearance</div>
          <AppearanceSection />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar projectName={current?.name} login={me.data?.login} />
        <main className="flex-1 p-6">
          <PageLoading isLoading={me.isPending || projects.isPending} error={me.error ?? projects.error}>
            <Outlet />
          </PageLoading>
        </main>
      </div>
    </div>
  );
}
