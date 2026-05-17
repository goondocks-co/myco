import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import Layout from './layout/Layout';
import { ToastViewport } from './components/groves/toast';
import Dashboard from './pages/Dashboard';
import Sessions from './pages/Sessions';
import Cortex from './pages/Cortex';
import Mycelium from './pages/Mycelium';
import Agent from './pages/Agent';
import Skills from './pages/Skills';
import Settings from './pages/Settings';
import GroveDashboard from './pages/GroveDashboard';
import Operations from './pages/Operations';
import Logs from './pages/Logs';
import MachineDashboard from './pages/MachineDashboard';
import TeamPage from './pages/Team';
import Onboarding from './pages/Onboarding';
import Groves from './pages/Groves';
import { useGroves } from './hooks/use-groves';
import { GlobalSelectionBoundary, ProjectSelectionBoundary } from './hooks/use-project-selection';
import {
  defaultSelection,
  findSelection,
  projectPath,
  selectionFromLast,
} from './lib/selection';

export default function App() {
  return (
    <>
    <ToastViewport />
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route element={<GlobalSelectionBoundary><Layout /></GlobalSelectionBoundary>}>
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/groves" element={<Groves />} />
        <Route path="/logs" element={<Logs />} />
        <Route path="/machine" element={<MachineDashboard />} />
        {/* Unified Settings page owns /settings. The wrapper binds a
            ProjectSelectionBoundary to the last-known project so substrate
            hooks (useGroveConfig, useScopedConfig) resolve the right scope
            — without it, every grove-tier field on the page reads as
            undefined because the grove query is keyed off URL selection. */}
        <Route path="/settings" element={<SettingsRoute />} />
        {/* Legacy machine-scoped Settings URL — redirect to the unified
            page anchored at the logging group, which surfaces the most
            machine-tier fields. */}
        <Route path="/machine/settings" element={<LegacyMachineSettingsRedirect />} />
        {/* Legacy /system → /settings#logging (the "System" page used
            to host machine-tier settings; folded into the unified page). */}
        <Route path="/system" element={<Navigate to="/settings#logging" replace />} />
      </Route>
      <Route path="/g/:groveSlug/p/:projectSlug" element={<ProjectScopedLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="sessions" element={<Sessions />} />
        <Route path="sessions/:id" element={<Sessions />} />
        <Route path="cortex" element={<Cortex />} />
        <Route path="mycelium" element={<Mycelium />} />
        <Route path="agent" element={<Agent />} />
        <Route path="agent/:id" element={<Agent />} />
        <Route path="skills" element={<Skills />} />
        {/* Project-scoped /settings is consolidated into the unified
            /settings page. Forward inbound bookmarks, preserving the
            `?configField=`/`?configSection=` deep-link params so the
            global focus highlighter still lands on the right row. */}
        <Route path="settings" element={<LegacyProjectScopedSettingsRedirect />} />
        {/* Legacy project-scoped /operations → Grove-scoped /dashboard. */}
        <Route path="operations" element={<LegacyOperationsRedirect />} />
        {/* Legacy project-scoped /team → Grove-scoped /g/<slug>/team.
            Team config is Grove-tier; the project segment was vestigial. */}
        <Route path="team" element={<LegacyTeamRedirect />} />
      </Route>
      <Route path="/g/:groveSlug/dashboard" element={<GroveScopedLayout />}>
        <Route index element={<GroveDashboard />} />
      </Route>
      <Route path="/g/:groveSlug/operations" element={<GroveScopedLayout />}>
        <Route index element={<Operations />} />
      </Route>
      {/* Legacy Grove-scoped Settings URL → unified /settings anchored at
          the backup group (the section with the most Grove-tier fields
          that the old GroveSettings page surfaced). */}
      <Route path="/g/:groveSlug/settings" element={<LegacyGroveSettingsRedirect />} />
      {/* Phase 4 unifies operations under /operations; /maintenance redirects forward. */}
      <Route path="/g/:groveSlug/maintenance" element={<LegacyMaintenanceRedirect />} />
      <Route path="/g/:groveSlug/team" element={<GroveScopedLayout />}>
        <Route index element={<TeamPage />} />
        <Route path="maintenance" element={<TeamMaintenanceRedirect />} />
      </Route>
      <Route path="/sessions" element={<LegacyProjectRedirect suffix="/sessions" />} />
      <Route path="/sessions/:id" element={<LegacyProjectRedirect suffixFromPath />} />
      <Route path="/cortex" element={<LegacyProjectRedirect suffix="/cortex" />} />
      <Route path="/mycelium" element={<LegacyProjectRedirect suffix="/mycelium" />} />
      <Route path="/agent" element={<LegacyProjectRedirect suffix="/agent" />} />
      <Route path="/agent/:id" element={<LegacyProjectRedirect suffixFromPath />} />
      <Route path="/skills" element={<LegacyProjectRedirect suffix="/skills" />} />
      <Route path="/operations" element={<LegacyGroveRedirect suffix="/operations" />} />
      <Route path="/team" element={<LegacyGroveRedirect suffix="/team" />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  );
}

function RootRedirect() {
  const { data, isLoading, error } = useGroves();
  if (isLoading) return <RouteLoading text="Loading projects..." />;
  if (error) return <RouteLoading text={error.message} />;
  const groves = data?.groves ?? [];
  const selection = selectionFromLast(groves) ?? defaultSelection(groves);
  return selection
    ? <Navigate to={projectPath(selection)} replace />
    : <Navigate to="/onboarding" replace />;
}

function LegacyProjectRedirect({
  suffix,
  suffixFromPath = false,
}: {
  suffix?: string;
  suffixFromPath?: boolean;
}) {
  const location = useLocation();
  const { data, isLoading, error } = useGroves();
  if (isLoading) return <RouteLoading text="Loading projects..." />;
  if (error) return <RouteLoading text={error.message} />;
  const selection = selectionFromLast(data?.groves ?? []) ?? defaultSelection(data?.groves ?? []);
  if (!selection) return <Navigate to="/onboarding" replace />;
  return <Navigate to={projectPath(selection, suffixFromPath ? location.pathname : suffix)} replace />;
}

/**
 * Legacy Grove-scoped redirect: resolves the active Grove (via last-selection
 * or default) and forwards to `/g/<grove-slug><suffix>`. Used for pages that
 * P8 lifted from project-scoped to Grove-scoped (Operations).
 */
function LegacyGroveRedirect({ suffix }: { suffix: string }) {
  const { data, isLoading, error } = useGroves();
  if (isLoading) return <RouteLoading text="Loading Grove..." />;
  if (error) return <RouteLoading text={error.message} />;
  const groves = data?.groves ?? [];
  const selection = selectionFromLast(groves) ?? defaultSelection(groves);
  // Fall back to the first Grove that exists at all, even if it has no
  // projects — the Grove-scoped route will redirect onward to /onboarding
  // if needed.
  const grove = selection?.grove ?? groves[0];
  if (!grove) return <Navigate to="/onboarding" replace />;
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  return <Navigate to={`/g/${grove.slug}${normalizedSuffix}`} replace />;
}

/**
 * Internal redirect for the legacy project-scoped Team route. Reads
 * the current `:groveSlug` from the parent route params and bounces
 * to `/g/<grove>/team`. Used for inbound `/g/<g>/p/<p>/team` URLs
 * that pre-date the Team-as-Grove-section move.
 */
function LegacyTeamRedirect() {
  const { groveSlug } = useParams();
  if (!groveSlug) return <Navigate to="/" replace />;
  return <Navigate to={`/g/${groveSlug}/team`} replace />;
}

/**
 * Legacy Grove-scoped /g/:slug/team/maintenance → /g/:slug/team?tab=sync.
 * Phase 6 collapses TeamDashboard + TeamMaintenance into a single tabbed
 * TeamPage; the Maintenance route forwards to the Sync tab.
 */
function TeamMaintenanceRedirect() {
  const { groveSlug } = useParams();
  if (!groveSlug) return <Navigate to="/" replace />;
  return <Navigate to={`/g/${groveSlug}/team?tab=sync`} replace />;
}

/**
 * Legacy project-scoped /operations → Grove-scoped /operations.
 * Operations is a Grove-tier surface; the project segment was vestigial.
 */
function LegacyOperationsRedirect() {
  const { groveSlug } = useParams();
  if (!groveSlug) return <Navigate to="/" replace />;
  return <Navigate to={`/g/${groveSlug}/operations`} replace />;
}

/**
 * Grove-scoped /g/:slug/maintenance → /g/:slug/operations.
 * Phase 4 collapses Maintenance into Operations; legacy bookmarks
 * forward to the new canonical URL.
 */
function LegacyMaintenanceRedirect() {
  const { groveSlug } = useParams();
  if (!groveSlug) return <Navigate to="/" replace />;
  return <Navigate to={`/g/${groveSlug}/operations`} replace />;
}

/**
 * Legacy Grove-scoped /g/:slug/settings → unified /settings#backup.
 * The unified page surfaces Grove-tier fields alongside Project and
 * Machine fields; the `#backup` anchor matches the section with the
 * most Grove-tier content from the old GroveSettings page.
 */
function LegacyGroveSettingsRedirect() {
  return <Navigate to="/settings#backup" replace />;
}

/**
 * Legacy machine-scoped /machine/settings → unified /settings#logging.
 * The unified page now owns every Machine-tier field.
 */
function LegacyMachineSettingsRedirect() {
  return <Navigate to="/settings#logging" replace />;
}

/**
 * Legacy project-scoped /g/:g/p/:p/settings → unified /settings.
 * Preserves any deep-link query params (`?configField=`, `?configSection=`)
 * so old links from `buildConfigFocusLink` still highlight the right row.
 */
function LegacyProjectScopedSettingsRedirect() {
  const location = useLocation();
  const target = `/settings${location.search}${location.hash}`;
  return <Navigate to={target} replace />;
}

/**
 * Wrapper for `/settings` — the unified Settings page renders Project,
 * Grove, and Machine fields together but the URL carries no `:groveSlug`
 * or `:projectSlug`, so substrate hooks (`useGroveConfig`,
 * `useScopedConfig`) would read undefined without a selection. Resolve
 * the last-known project (same fallback `RootRedirect` and
 * `LegacyProjectRedirect` use) and bind it through
 * `ProjectSelectionBoundary` so every scope's read path sees a real
 * scope. When no projects exist yet, fall back to
 * `GlobalSelectionBoundary` and let the page render its
 * "no project" banner with only Machine-tier fields editable.
 */
function SettingsRoute() {
  const { data, isLoading, error } = useGroves();
  if (isLoading) return <RouteLoading text="Loading settings..." />;
  if (error) return <RouteLoading text={error.message} />;
  const groves = data?.groves ?? [];
  const selection = selectionFromLast(groves) ?? defaultSelection(groves);
  if (selection) {
    return (
      <ProjectSelectionBoundary selection={selection}>
        <Settings />
      </ProjectSelectionBoundary>
    );
  }
  return (
    <GlobalSelectionBoundary>
      <Settings />
    </GlobalSelectionBoundary>
  );
}

function ProjectScopedLayout() {
  const { groveSlug, projectSlug } = useParams();
  const { data, isLoading, error } = useGroves();
  if (isLoading) return <RouteLoading text="Loading project..." />;
  if (error) return <RouteLoading text={error.message} />;
  const selection = findSelection(data?.groves ?? [], groveSlug, projectSlug);
  if (!selection) return <Navigate to="/" replace />;
  return (
    <ProjectSelectionBoundary selection={selection}>
      <Layout />
    </ProjectSelectionBoundary>
  );
}

/**
 * Grove-scoped routes (Grove Settings) — bind a ProjectSelection to the
 * Grove's first project so request headers carry x-myco-grove-id and the
 * page can render through ProjectSelectionBoundary. Grove-tier endpoints
 * only need groveId; the project binding is incidental.
 */
function GroveScopedLayout() {
  const { groveSlug } = useParams();
  const { data, isLoading, error } = useGroves();
  if (isLoading) return <RouteLoading text="Loading Grove..." />;
  if (error) return <RouteLoading text={error.message} />;
  const groves = data?.groves ?? [];
  const grove = groves.find((g) => g.slug === groveSlug);
  if (!grove) return <Navigate to="/" replace />;
  const project = grove.projects[0];
  if (!project) return <Navigate to="/onboarding" replace />;
  return (
    <ProjectSelectionBoundary selection={{ grove, project }}>
      <Layout />
    </ProjectSelectionBoundary>
  );
}

function RouteLoading({ text }: { text: string }) {
  return (
    <div className="flex h-screen items-center justify-center bg-surface text-sm text-on-surface-variant">
      {text}
    </div>
  );
}
