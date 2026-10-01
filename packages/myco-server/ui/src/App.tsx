import { useRoutes } from 'react-router-dom';
import { AuthGate } from './components/auth-gate';
import { ROUTES } from './routes/table';

function Pages() {
  return useRoutes(ROUTES);
}

export default function App() {
  return (
    <AuthGate>
      <Pages />
    </AuthGate>
  );
}
