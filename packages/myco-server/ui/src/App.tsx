import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthGate } from './components/auth-gate';
import { readPendingLink } from './lib/pending-link';
import { readLastProject } from './lib/project-memory';
import { Access } from './pages/Access';
import { AgentRuns } from './pages/AgentRuns';
import { Join } from './pages/Join';
import { LinkPage } from './pages/Link';
import { ProjectAccess } from './pages/ProjectAccess';
import { NotFound } from './pages/NotFound';
import { Operations } from './pages/Operations';
import { Settings } from './pages/Settings';
import { ProjectHome } from './pages/ProjectHome';
import { Projects } from './pages/Projects';
import { Measures } from './pages/Measures';
import { Plans } from './pages/Plans';
import { Sessions } from './pages/Sessions';
import { Spores } from './pages/Spores';
import { Status } from './pages/Status';
import { Shell } from './routes/Shell';

/** `/` is where sign-in lands: a pending link resumes first, then the last project, then Projects. */
function RootRedirect() {
  if (readPendingLink() !== null) return <Navigate to="/link" replace />;
  const last = readLastProject();
  return <Navigate to={last ? `/p/${encodeURIComponent(last)}` : '/projects'} replace />;
}

export default function App() {
  return (
    <AuthGate>
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/link" element={<LinkPage />} />
      <Route path="/join" element={<Join />} />
      <Route path="/notifications" element={<Navigate to="/" replace />} />
      <Route element={<Shell />}>
        <Route path="/projects" element={<Projects />} />
        <Route path="/p/:projectId" element={<ProjectHome />} />
        <Route path="/p/:projectId/sessions" element={<Sessions />} />
        <Route path="/p/:projectId/sessions/:sessionId" element={<Sessions />} />
        <Route path="/p/:projectId/plans" element={<Plans />} />
        <Route path="/p/:projectId/spores" element={<Spores />} />
        <Route path="/p/:projectId/spores/:sporeId" element={<Spores />} />
        <Route path="/p/:projectId/runs" element={<AgentRuns />} />
        <Route path="/p/:projectId/runs/:runId" element={<AgentRuns />} />
        <Route path="/p/:projectId/access" element={<ProjectAccess />} />
        <Route path="/access" element={<Access />} />
        <Route path="/status" element={<Status />} />
        <Route path="/measures" element={<Measures />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/operations" element={<Operations />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
    </AuthGate>
  );
}
