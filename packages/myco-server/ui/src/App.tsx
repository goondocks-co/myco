import { Route, Routes } from 'react-router-dom';
import { AuthGate } from './components/auth-gate';
import { Join } from './pages/Join';
import { LinkPage } from './pages/Link';
import { NotFound } from './pages/NotFound';
import { Projects } from './pages/Projects';
import { adminRoutes } from './routes/admin';
import { knowledgeRoutes } from './routes/knowledge';
import { movedRoutes } from './routes/moved';
import { sessionRoutes } from './routes/sessions';
import { Shell } from './routes/Shell';
import { ResumePendingLink, Today } from './routes/today';
import { workRoutes } from './routes/work';

export default function App() {
  return (
    <AuthGate>
    <Routes>
      <Route path="/link" element={<LinkPage />} />
      <Route path="/join" element={<Join />} />
      {movedRoutes}
      <Route element={<ResumePendingLink />}>
      <Route element={<Shell />}>
        <Route path="/" element={<Today />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/p/:projectId" element={<Today />} />
        {sessionRoutes}
        {knowledgeRoutes}
        {workRoutes}
        {adminRoutes}
        <Route path="*" element={<NotFound />} />
      </Route>
      </Route>
    </Routes>
    </AuthGate>
  );
}
