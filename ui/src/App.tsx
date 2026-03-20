import { Routes, Route } from 'react-router-dom';
import Layout from './layout/Layout';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route
          path="/"
          element={
            <div className="p-8">
              <h1 className="text-2xl font-bold">Dashboard</h1>
              <p className="text-muted-foreground">Coming in Task 10</p>
            </div>
          }
        />
        <Route
          path="/configuration"
          element={
            <div className="p-8">
              <h1 className="text-2xl font-bold">Configuration</h1>
            </div>
          }
        />
        <Route
          path="/operations"
          element={
            <div className="p-8">
              <h1 className="text-2xl font-bold">Operations</h1>
            </div>
          }
        />
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
