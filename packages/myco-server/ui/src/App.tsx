import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthGate } from './components/auth-gate';
import { Access } from './pages/Access';
import { AgentRuns } from './pages/AgentRuns';
import { Join } from './pages/Join';
import { LinkPage } from './pages/Link';
import { ProjectAccess } from './pages/ProjectAccess';
import { NotFound } from './pages/NotFound';
import { Operations } from './pages/Operations';
import { Settings } from './pages/Settings';
import { Projects } from './pages/Projects';
import { Measures } from './pages/Measures';
import { Status } from './pages/Status';
import { knowledgeRoutes } from './routes/knowledge';
import { sessionRoutes } from './routes/sessions';
import { Shell } from './routes/Shell';
import { ResumePendingLink, Today } from './routes/today';

export default function App() {
  return (
    <AuthGate>
    <Routes>
      <Route path="/link" element={<LinkPage />} />
      <Route path="/join" element={<Join />} />
      <Route path="/notifications" element={<Navigate to="/" replace />} />
      <Route element={<ResumePendingLink />}>
      <Route element={<Shell />}>
        <Route path="/" element={<Today />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/p/:projectId" element={<Today />} />
        {sessionRoutes}
        {knowledgeRoutes}
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
      </Route>
    </Routes>
    </AuthGate>
  );
}
