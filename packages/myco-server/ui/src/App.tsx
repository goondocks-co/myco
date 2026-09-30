import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthGate } from './components/auth-gate';
import { AgentRuns } from './pages/AgentRuns';
import { Join } from './pages/Join';
import { LinkPage } from './pages/Link';
import { NotFound } from './pages/NotFound';
import { Projects } from './pages/Projects';
import { adminRoutes } from './routes/admin';
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
        {adminRoutes}
        <Route path="*" element={<NotFound />} />
      </Route>
      </Route>
    </Routes>
    </AuthGate>
  );
}
