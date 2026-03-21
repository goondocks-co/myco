import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from './providers/theme';
import { FontProvider } from './providers/font';
import { PowerProvider } from './providers/power';
import App from './App';
import { STALE_TIME } from './lib/constants';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: STALE_TIME } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <FontProvider>
        <PowerProvider>
          <QueryClientProvider client={queryClient}>
            <BrowserRouter>
              <App />
            </BrowserRouter>
          </QueryClientProvider>
        </PowerProvider>
      </FontProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
