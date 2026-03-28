import { Routes, Route } from 'react-router-dom';
import Layout from './layout/Layout';
import Dashboard from './pages/Dashboard';
import Sessions from './pages/Sessions';
import Mycelium from './pages/Mycelium';
import Agent from './pages/Agent';
import Settings from './pages/Settings';
import Operations from './pages/Operations';
import Team from './pages/Team';
import Logs from './pages/Logs';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/sessions" element={<Sessions />} />
        <Route path="/sessions/:id" element={<Sessions />} />
        <Route path="/mycelium" element={<Mycelium />} />
        <Route path="/agent" element={<Agent />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/operations" element={<Operations />} />
        <Route path="/team" element={<Team />} />
        <Route path="/logs" element={<Logs />} />
      </Route>
    </Routes>
  );
}
