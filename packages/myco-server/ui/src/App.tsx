import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './layout/Layout';
import { readPendingLink } from './lib/pending-link';
import { readLastProject } from './lib/project-memory';
import { LinkPage } from './pages/Link';
import { NotFound } from './pages/NotFound';
import { ProjectHome } from './pages/ProjectHome';
import { Projects } from './pages/Projects';
import { Status } from './pages/Status';

/** `/` is where sign-in lands: a pending link resumes first, then the last project, then Projects. */
function RootRedirect() {
  if (readPendingLink() !== null) return <Navigate to="/link" replace />;
  const last = readLastProject();
  return <Navigate to={last ? `/p/${encodeURIComponent(last)}` : '/projects'} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path="/link" element={<LinkPage />} />
      <Route element={<Layout />}>
        <Route path="/projects" element={<Projects />} />
        <Route path="/p/:projectId" element={<ProjectHome />} />
        <Route path="/status" element={<Status />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
