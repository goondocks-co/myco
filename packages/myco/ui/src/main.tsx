import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { PowerProvider } from './providers/power';
import { AppearanceProvider } from './providers/appearance';
import App from './App';
import { STALE_TIME } from './lib/constants';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: STALE_TIME } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PowerProvider>
      <QueryClientProvider client={queryClient}>
        <AppearanceProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AppearanceProvider>
      </QueryClientProvider>
    </PowerProvider>
  </React.StrictMode>,
);
