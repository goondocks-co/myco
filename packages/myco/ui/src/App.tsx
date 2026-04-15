import { useEffect } from 'react';
import { Routes, Route } from 'react-router-dom';
import Layout from './layout/Layout';
import Dashboard from './pages/Dashboard';
import Sessions from './pages/Sessions';
import Mycelium from './pages/Mycelium';
import Agent from './pages/Agent';
import Skills from './pages/Skills';
import Settings from './pages/Settings';
import Operations from './pages/Operations';
import Team from './pages/Team';
import Logs from './pages/Logs';
import { useDaemon } from './hooks/use-daemon';

/**
 * Keep `document.title` in sync with the active vault's project name so browser
 * tabs remain distinguishable when a user runs multiple daemons side-by-side.
 * Tabs truncate from the right, so the project name must lead.
 */
function useDocumentTitle() {
  const { data } = useDaemon();
  const name = data?.vault.name ?? null;
  useEffect(() => {
    document.title = name ? `${name} \u2014 Myco` : 'Myco';
  }, [name]);
}

export default function App() {
  useDocumentTitle();
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/sessions" element={<Sessions />} />
        <Route path="/sessions/:id" element={<Sessions />} />
        <Route path="/mycelium" element={<Mycelium />} />
        <Route path="/agent" element={<Agent />} />
        <Route path="/skills" element={<Skills />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/operations" element={<Operations />} />
        <Route path="/team" element={<Team />} />
        <Route path="/logs" element={<Logs />} />
      </Route>
    </Routes>
  );
}
