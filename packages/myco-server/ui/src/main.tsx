import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { applyCachedAppearance } from './lib/appearance-apply';
import { SignedOutError } from './lib/api';
import { AppearanceProvider } from './providers/appearance';
import './index.css';

// Paint this viewer's last-applied appearance before React mounts, so a hard
// reload does not flash the default theme.
applyCachedAppearance();

const queryClient: QueryClient = new QueryClient({
  // A session that ends while the dashboard is open surfaces as a 401 on some
  // later read; re-asking `/auth/me` hands the whole view back to the gate.
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof SignedOutError) void queryClient.invalidateQueries({ queryKey: ['me'] });
    },
  }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      // A missing session is a state to render, not a request to retry.
      retry: (count, error) => !(error instanceof SignedOutError) && count < 2,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppearanceProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </AppearanceProvider>
  </React.StrictMode>,
);
