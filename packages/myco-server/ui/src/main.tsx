import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { applyCachedAppearance } from './lib/appearance-apply';
import { createQueryClient } from './lib/query-client';
import { AppearanceProvider } from './providers/appearance';
import './index.css';

// Paint this viewer's last-applied appearance before React mounts, so a hard
// reload does not flash the default theme.
applyCachedAppearance();

const queryClient = createQueryClient();

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
