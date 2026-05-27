import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { PowerProvider } from './providers/power';
import App from './App';
import { STALE_TIME } from './lib/constants';
import './index.css';
import { getBasePath } from './lib/base-path';
import { applyCachedAppearance } from './lib/appearance-apply';

// Paint the user's last-applied theme synchronously before React mounts
// so a hard reload doesn't flash the default sage/dark before the
// `/config/merged` fetch returns the real values. No-op on first visit.
applyCachedAppearance();

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: STALE_TIME } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PowerProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename={getBasePath() || undefined}>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </PowerProvider>
  </React.StrictMode>,
);
