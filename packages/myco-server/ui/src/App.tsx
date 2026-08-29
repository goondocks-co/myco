import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './layout/Layout';
import { readLastProject } from './lib/project-memory';
import { NotFound } from './pages/NotFound';
import { ProjectHome } from './pages/ProjectHome';
import { Projects } from './pages/Projects';
import { Status } from './pages/Status';

function RootRedirect() {
  const last = readLastProject();
  return <Navigate to={last ? `/p/${encodeURIComponent(last)}` : '/projects'} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/p/:projectId" element={<ProjectHome />} />
        <Route path="/status" element={<Status />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
