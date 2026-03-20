import { Routes, Route } from 'react-router-dom';
import Layout from './layout/Layout';
import Dashboard from './pages/Dashboard';
import Configuration from './pages/Configuration';
import Operations from './pages/Operations';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/configuration" element={<Configuration />} />
        <Route path="/operations" element={<Operations />} />
        <Route
          path="/logs"
          element={
            <div className="p-8">
              <h1 className="text-2xl font-bold">Logs</h1>
            </div>
          }
        />
      </Route>
    </Routes>
  );
}
