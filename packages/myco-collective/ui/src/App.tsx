import { useQuery } from '@tanstack/react-query';
import { LockKeyhole, ShieldCheck } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { Badge } from './components/ui/badge';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import { Input } from './components/ui/input';
import { PageLoading } from './components/ui/page-loading';
import Layout from './layout/Layout';
import {
  ApiError,
  clearStoredAdminToken,
  getStoredAdminToken,
  setStoredAdminToken,
  verifyAdminToken,
} from './lib/api';
import { formatCollectiveName } from './lib/format';
import Dashboard from './pages/Dashboard';
import Mcp from './pages/Mcp';
import Projects from './pages/Projects';
import Search from './pages/Search';
import Settings from './pages/Settings';

function AuthGate({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [token, setToken] = useState(getStoredAdminToken());
  const [message, setMessage] = useState<string | null>(null);
  const authQuery = useQuery({
    queryKey: ['auth-submit', token],
    queryFn: verifyAdminToken,
    enabled: false,
    retry: false,
  });

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    setStoredAdminToken(token);

    try {
      const result = await authQuery.refetch();
      if (result.error) throw result.error;
      onAuthenticated();
    } catch (error) {
      clearStoredAdminToken();
      setMessage(error instanceof Error ? error.message : 'Authentication failed.');
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <Card className="w-full max-w-2xl overflow-hidden p-6 md:p-8">
        <Badge variant="outline">
          <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
          Collective Admin Access
        </Badge>
        <h1 className="mt-5 max-w-2xl font-serif text-3xl text-on-surface md:text-4xl">
          Operator access for the hosted Collective.
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-on-surface-variant">
          Authenticate once, then manage project registration, settings distribution, and cross-project search inside the same Myco UI language used by the daemon dashboard.
        </p>

        <form className="mt-8 space-y-5" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <label className="text-sm text-on-surface-variant">Admin bearer token</label>
            <Input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Paste the bootstrap admin token"
              required
            />
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={authQuery.isFetching}>
              <LockKeyhole className="mr-2 h-4 w-4" />
              Authenticate
            </Button>
            <span className="text-sm text-on-surface-variant">
              The token is stored locally in your browser for this operator surface.
            </span>
          </div>
        </form>

        {message && <p className="mt-4 text-sm text-tertiary">{message}</p>}
      </Card>
    </div>
  );
}

export default function App() {
  const [authGeneration, setAuthGeneration] = useState(0);
  const storedToken = getStoredAdminToken();
  const authQuery = useQuery({
    queryKey: ['auth', authGeneration, storedToken],
    queryFn: verifyAdminToken,
    enabled: storedToken.length > 0,
    retry: false,
  });

  useEffect(() => {
    if (authQuery.error instanceof ApiError && authQuery.error.status === 401) {
      clearStoredAdminToken();
      setAuthGeneration((value) => value + 1);
    }
  }, [authQuery.error]);

  // Keep document.title in sync with the collective name so browser tabs
  // remain distinguishable when a user has multiple Collective UIs open.
  // Tabs truncate from the right, so the collective name must lead.
  const collectiveName = authQuery.data?.collective_name ?? null;
  useEffect(() => {
    const formatted = collectiveName ? formatCollectiveName(collectiveName) : null;
    document.title = formatted ? `${formatted} \u2014 Myco Collective` : 'Myco Collective';
  }, [collectiveName]);

  if (!storedToken) {
    return <AuthGate onAuthenticated={() => setAuthGeneration((value) => value + 1)} />;
  }

  if (authQuery.isLoading) {
    return (
      <PageLoading isLoading error={null} loadingText="Verifying Collective admin token…">
        {null}
      </PageLoading>
    );
  }

  if (authQuery.isError || !authQuery.data?.authenticated) {
    return <AuthGate onAuthenticated={() => setAuthGeneration((value) => value + 1)} />;
  }

  const handleLogout = () => {
    clearStoredAdminToken();
    setAuthGeneration((value) => value + 1);
  };

  return (
    <Routes>
      <Route element={<Layout collectiveName={formatCollectiveName(authQuery.data.collective_name)} onLogout={handleLogout} />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/mcp-settings" element={<Mcp />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/search" element={<Search />} />
      </Route>
    </Routes>
  );
}
