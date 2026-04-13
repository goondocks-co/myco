import { useQuery } from '@tanstack/react-query';
import { LockKeyhole, Sparkles } from 'lucide-react';
import { FormEvent, useEffect, useState } from 'react';
import { Route, Routes } from 'react-router-dom';
import { Button } from './components/ui/button';
import { Card } from './components/ui/card';
import { Input } from './components/ui/input';
import Layout from './layout/Layout';
import { ApiError, clearStoredAdminToken, getStoredAdminToken, setStoredAdminToken, verifyAdminToken } from './lib/api';
import Dashboard from './pages/Dashboard';
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
      <Card className="w-full max-w-2xl overflow-hidden p-8 md:p-10">
        <div className="inline-flex items-center gap-2 rounded-full border border-[rgba(255,231,208,0.10)] bg-[rgba(255,248,240,0.04)] px-3 py-1 font-mono text-[11px] uppercase tracking-[0.28em] text-[#d2b29a]">
          <Sparkles className="h-3.5 w-3.5" />
          Admin authentication
        </div>
        <h1 className="mt-6 font-display text-5xl text-[#fff4e8] md:text-6xl">Unlock the Collective.</h1>
        <p className="mt-4 max-w-xl text-base leading-7 text-[#ccb6a6]">
          The admin UI uses the Collective bearer token directly. This keeps the surface package-owned and self-contained while the backend still uses explicit bearer validation.
        </p>

        <form className="mt-8 space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <label className="text-sm text-[#ccb6a6]">Admin bearer token</label>
            <Input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="Paste the bootstrap admin token"
              required
            />
          </div>

          <Button type="submit" disabled={authQuery.isFetching}>
            <LockKeyhole className="mr-2 h-4 w-4" />
            Authenticate
          </Button>
        </form>

        {message ? <p className="mt-4 text-sm text-[#ffc7bb]">{message}</p> : null}
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

  if (!storedToken) {
    return <AuthGate onAuthenticated={() => setAuthGeneration((value) => value + 1)} />;
  }

  if (authQuery.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-[#d5bba8]">
        Verifying Collective admin token…
      </div>
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
      <Route element={<Layout collectiveName={authQuery.data.collective_name} onLogout={handleLogout} />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/search" element={<Search />} />
      </Route>
    </Routes>
  );
}
