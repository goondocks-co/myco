import { Routes, Route, Navigate, useLocation, useParams } from 'react-router-dom';
import Layout from './layout/Layout';
import Dashboard from './pages/Dashboard';
import Sessions from './pages/Sessions';
import Cortex from './pages/Cortex';
import Mycelium from './pages/Mycelium';
import Agent from './pages/Agent';
import Skills from './pages/Skills';
import Settings from './pages/Settings';
import Operations from './pages/Operations';
import Team from './pages/Team';
import GroveSettings from './pages/GroveSettings';
import Logs from './pages/Logs';
import System from './pages/System';
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
        <Route path="/system" element={<System />} />
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
        <Route path="operations" element={<Operations />} />
        <Route path="team" element={<Team />} />
      </Route>
      <Route path="/g/:groveSlug/settings" element={<GroveScopedLayout />}>
        <Route index element={<GroveSettings />} />
      </Route>
      <Route path="/sessions" element={<LegacyProjectRedirect suffix="/sessions" />} />
      <Route path="/sessions/:id" element={<LegacyProjectRedirect suffixFromPath />} />
      <Route path="/cortex" element={<LegacyProjectRedirect suffix="/cortex" />} />
      <Route path="/mycelium" element={<LegacyProjectRedirect suffix="/mycelium" />} />
      <Route path="/agent" element={<LegacyProjectRedirect suffix="/agent" />} />
      <Route path="/skills" element={<LegacyProjectRedirect suffix="/skills" />} />
      <Route path="/settings" element={<LegacyProjectRedirect suffix="/settings" />} />
      <Route path="/operations" element={<LegacyProjectRedirect suffix="/operations" />} />
      <Route path="/team" element={<LegacyProjectRedirect suffix="/team" />} />
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
