import { Routes, Route } from 'react-router-dom';

export default function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <div className="p-8">
            <h1 className="text-2xl font-bold text-primary">
              Myco Dashboard
            </h1>
            <p className="text-muted-foreground mt-2">Coming soon...</p>
          </div>
        }
      />
    </Routes>
  );
}
