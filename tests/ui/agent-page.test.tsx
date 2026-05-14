// @vitest-environment jsdom

import { describe, it, expect, mock } from 'bun:test';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Stub the heavy child components so the test can focus on the mount-time
// redirect logic in Agent.tsx without instantiating real queries or
// pulling in their transitive dependency graph.
mock.module('../../packages/myco/ui/src/components/agent/RunList', () => ({
  RunList: () => null,
}));
mock.module('../../packages/myco/ui/src/components/agent/RunDetail', () => ({
  RunDetail: () => null,
}));
mock.module('../../packages/myco/ui/src/components/agent/RunTaskDialog', () => ({
  RunTaskDialog: () => null,
}));
mock.module('../../packages/myco/ui/src/components/agent/TaskList', () => ({
  TaskList: () => null,
}));
mock.module('../../packages/myco/ui/src/components/agent/TaskDetail', () => ({
  TaskDetail: () => null,
}));
mock.module('../../packages/myco/ui/src/components/agent/AgentConfig', () => ({
  AgentConfig: () => null,
}));
mock.module('../../packages/myco/ui/src/components/agent/ComparisonView', () => ({
  ComparisonView: () => null,
}));
mock.module('../../packages/myco/ui/src/hooks/use-agent', () => ({
  useRunsByIds: () => ({ runs: [], isLoading: false, isError: false, errors: [] }),
}));

// useMediaQuery (used inside MasterDetailSplit) reaches for matchMedia
// which jsdom doesn't ship by default.
if (typeof window !== 'undefined' && !window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

const { default: Agent } = await import('../../packages/myco/ui/src/pages/Agent');

function LocationProbe({ onChange }: { onChange: (loc: string) => void }) {
  const loc = useLocation();
  onChange(`${loc.pathname}${loc.search}`);
  return null;
}

function renderAgent(initialEntry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let lastLocation = initialEntry;
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/agent" element={<Agent />} />
          <Route path="/agent/:id" element={<Agent />} />
        </Routes>
        <LocationProbe onChange={(l) => { lastLocation = l; }} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return () => lastLocation;
}

describe('Agent mount-time URL canonicalization', () => {
  it('migrates ?run=<id>&tab=evaluations to /agent/<id>?tab=comparisons atomically', () => {
    const getLocation = renderAgent('/agent?run=abc&tab=evaluations');
    expect(getLocation()).toBe('/agent/abc?tab=comparisons');
  });

  it('migrates ?run=<id> alone to /agent/<id>', () => {
    const getLocation = renderAgent('/agent?run=abc');
    expect(getLocation()).toBe('/agent/abc');
  });

  it('canonicalizes ?tab=evaluations alone to ?tab=comparisons', () => {
    const getLocation = renderAgent('/agent?tab=evaluations');
    expect(getLocation()).toBe('/agent?tab=comparisons');
  });
});
