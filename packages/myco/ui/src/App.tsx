import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import Layout from './layout/Layout';
import Dashboard from './pages/Dashboard';
import Sessions from './pages/Sessions';
import Cortex from './pages/Cortex';
import Mycelium from './pages/Mycelium';
import Agent from './pages/Agent';
import Skills from './pages/Skills';
import Settings from './pages/Settings';
import GroveDashboard from './pages/GroveDashboard';
import GroveMaintenance from './pages/GroveMaintenance';
import GroveSettings from './pages/GroveSettings';
import Logs from './pages/Logs';
import MachineDashboard from './pages/MachineDashboard';
import MachineSettings from './pages/MachineSettings';
import { TeamDashboard, TeamMaintenance } from './pages/Team';
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
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route element={<GlobalSelectionBoundary><Layout /></GlobalSelectionBoundary>}>
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/groves" element={<Groves />} />
        <Route path="/logs" element={<Logs />} />
        <Route path="/machine" element={<MachineDashboard />} />
        <Route path="/machine/settings" element={<MachineSettings />} />
        {/* Legacy /system → /machine/settings (the "System" page used
            to host every machine-tier setting; renamed during the
            sidebar regroup so all four sections share Dashboard +
            Settings + (specialized) shape). */}
        <Route path="/system" element={<Navigate to="/machine/settings" replace />} />
      </Route>
      <Route path="/g/:groveSlug/p/:projectSlug" element={<ProjectScopedLayout />}>
        <Route index element={<Dashboard />} />
        <Route path="sessions" element={<Sessions />} />
        <Route path="sessions/:id" element={<Sessions />} />
        <Route path="cortex" element={<Cortex />} />
        <Route path="mycelium" element={<Mycelium />} />
        <Route path="agent" element={<Agent />} />
        <Route path="skills" element={<Skills />} />
        <Route path="settings" element={<Settings />} />
        {/* Legacy project-scoped /operations → Grove-scoped /dashboard. */}
        <Route path="operations" element={<LegacyOperationsRedirect />} />
        {/* Legacy project-scoped /team → Grove-scoped /g/<slug>/team.
            Team config is Grove-tier; the project segment was vestigial. */}
        <Route path="team" element={<LegacyTeamRedirect />} />
      </Route>
      <Route path="/g/:groveSlug/dashboard" element={<GroveScopedLayout />}>
        <Route index element={<GroveDashboard />} />
      </Route>
      <Route path="/g/:groveSlug/maintenance" element={<GroveScopedLayout />}>
        <Route index element={<GroveMaintenance />} />
      </Route>
      <Route path="/g/:groveSlug/settings" element={<GroveScopedLayout />}>
        <Route index element={<GroveSettings />} />
      </Route>
      {/* Legacy /g/:slug/operations → /g/:slug/dashboard. Operations
          was the old combined informational + actions page; it split
          into Dashboard (informational) + Maintenance (actions) so
          every section shares the same shape. */}
      <Route path="/g/:groveSlug/operations" element={<LegacyGroveOperationsRedirect />} />
      <Route path="/g/:groveSlug/team" element={<GroveScopedLayout />}>
        <Route index element={<TeamDashboard />} />
        <Route path="maintenance" element={<TeamMaintenance />} />
      </Route>
      <Route path="/sessions" element={<LegacyProjectRedirect suffix="/sessions" />} />
      <Route path="/sessions/:id" element={<LegacyProjectRedirect suffixFromPath />} />
      <Route path="/cortex" element={<LegacyProjectRedirect suffix="/cortex" />} />
      <Route path="/mycelium" element={<LegacyProjectRedirect suffix="/mycelium" />} />
      <Route path="/agent" element={<LegacyProjectRedirect suffix="/agent" />} />
      <Route path="/skills" element={<LegacyProjectRedirect suffix="/skills" />} />
      <Route path="/settings" element={<LegacyProjectRedirect suffix="/settings" />} />
      <Route path="/operations" element={<LegacyGroveRedirect suffix="/dashboard" />} />
      <Route path="/team" element={<LegacyGroveRedirect suffix="/team" />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
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
 * Legacy project-scoped /operations → Grove-scoped /dashboard.
 * Operations was the combined "stats + actions" page that split
 * into Dashboard + Maintenance. Sends users to the Dashboard so
 * they land on read-only stats, not the action surface.
 */
function LegacyOperationsRedirect() {
  const { groveSlug } = useParams();
  if (!groveSlug) return <Navigate to="/" replace />;
  return <Navigate to={`/g/${groveSlug}/dashboard`} replace />;
}

/** Same as above but for the Grove-scoped /g/:slug/operations URL. */
function LegacyGroveOperationsRedirect() {
  const { groveSlug } = useParams();
  if (!groveSlug) return <Navigate to="/" replace />;
  return <Navigate to={`/g/${groveSlug}/dashboard`} replace />;
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
