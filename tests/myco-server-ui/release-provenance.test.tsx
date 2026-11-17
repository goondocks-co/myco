import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

import { ReleaseTracking, checkSummary } from '../../packages/myco-server/ui/src/features/admin/project/ReleaseTracking';
import { checkPending, RELEASE_CHECK_REFRESH_MS, type ReleaseProvenanceRow } from '../../packages/myco-server/ui/src/hooks/use-release-provenance';

const NOW = Date.now();
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

const row = (over: Partial<ReleaseProvenanceRow> = {}): ReleaseProvenanceRow => ({
  enabled: true, productionRefs: ['refs/tags/myco/v*'], integrationRefs: ['main'],
  packageMap: [{ pathGlob: 'packages/myco/', tagPattern: 'refs/tags/myco/v*' }], includeUnknown: true, maxLookups: 50,
  revision: 'rev_1', updatedAt: NOW, updatedBy: 'mem_1', repository: { url: 'https://github.com/goondocks-co/myco', branch: 'main' },
  problem: null, building: false, unresolvedStates: 0,
  check: { requestedAt: null, startedAt: NOW - 60_000, finishedAt: NOW - 60_000, status: 'complete', failure: null,
    counts: { checked: 48, changed: 3, unchanged: 43, unknown: 2, unavailable: 0, deferred: 0 }, lookups: 20, lastCompleteAt: NOW - 60_000 },
  ...over,
});

function mount(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
}

describe('release tracking in project settings', () => {
  it('shows the configuration and the connected repository it reads, and requests a check', async () => {
    const sent: Array<{ method: string; path: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'https://s').pathname;
      if (init?.method && init.method !== 'GET') sent.push({ method: init.method, path });
      return Response.json(path.endsWith('/check') ? { requested: true } : { releaseProvenance: row() });
    }) as typeof fetch;
    const { container } = mount(<ReleaseTracking projectId="x" />);
    await waitFor(() => expect(screen.getByTestId('release-check')).toBeTruthy());
    expect(screen.getByTestId('release-repository').textContent).toBe('https://github.com/goondocks-co/myco');
    expect(container.textContent).toContain('packages/myco/ → refs/tags/myco/v*');
    expect(screen.getByTestId('release-check').textContent).toContain('48 checked · 3 changed · 2 unknown · 0 not reached');
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(sent).toEqual([{ method: 'POST', path: '/api/projects/x/release-provenance/check' }]));
  });

  it('reads the settings again until a requested check finishes, then stops', async () => {
    const requested = row({ check: { ...row().check!, requestedAt: NOW } });
    const finished = row({ check: { ...row().check!, requestedAt: NOW, startedAt: NOW + 1, finishedAt: NOW + 1,
      counts: { checked: 0, changed: 0, unchanged: 0, unknown: 0, unavailable: 0, deferred: 0 } } });
    let reads = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => new URL(String(input), 'https://s').pathname === '/api/status'
      ? Response.json({ target: 'bun' })
      : Response.json({ releaseProvenance: reads++ === 0 ? requested : finished })) as typeof fetch;
    mount(<ReleaseTracking projectId="x" />);
    await waitFor(() => expect(screen.getByTestId('release-check').textContent).toContain('check requested'));
    await waitFor(() => expect(screen.getByTestId('release-check').textContent).toContain('0 checked'), { timeout: RELEASE_CHECK_REFRESH_MS * 2 });
    expect(screen.getByTestId('release-check').textContent).not.toContain('check requested');
    expect(checkPending(finished.check)).toBe(false);
    expect(checkPending({ ...finished.check!, finishedAt: null })).toBe(true);
    expect(reads).toBe(2);
  });

  it('names a failed check in the reader’s words, including a refusal of the App’s access', () => {
    const stopped = (failure: string) => checkSummary(row({ check: { ...row().check!, status: 'unavailable', failure,
      counts: { checked: 0, changed: 0, unchanged: 0, unknown: 0, unavailable: 1, deferred: 4 } } }).check);
    expect(stopped('rate_limited')).toContain('stopped: GitHub rate limit reached; it resets within the hour. Earlier states are kept.');
    expect(stopped('account_not_approved')).toContain('stopped: the account that installed the App is not approved here.');
    expect(stopped('repository_not_connected')).toContain('no repository is connected; connect one under Repository');
    expect(checkSummary(null)).toBe('Not checked yet');
  });

  it('leads to Repository when no repository is connected', async () => {
    globalThis.fetch = (async () => Response.json({ releaseProvenance: row({ repository: null }) })) as unknown as typeof fetch;
    mount(<ReleaseTracking projectId="x" />);
    expect((await screen.findByRole('link', { name: 'Connect a repository to check releases' })).getAttribute('href')).toBe('/p/x/settings?connect=repository#repository');
  });

  it('says while release history is being prepared, and how many older records were kept aside', async () => {
    globalThis.fetch = (async () => Response.json({ releaseProvenance: row({ building: true, unresolvedStates: 3 }) })) as unknown as typeof fetch;
    mount(<ReleaseTracking projectId="x" />);
    expect((await screen.findByTestId('release-building')).textContent).toContain('still being prepared');
    expect(screen.getByTestId('release-unresolved').textContent).toBe('3 older release records could not be matched to one record and were kept as found');
  });

  it('shows neither line once history is ready and every record was placed', async () => {
    globalThis.fetch = (async () => Response.json({ releaseProvenance: row() })) as unknown as typeof fetch;
    mount(<ReleaseTracking projectId="x" />);
    await screen.findByTestId('release-check');
    expect(screen.queryByTestId('release-building')).toBeNull();
    expect(screen.queryByTestId('release-unresolved')).toBeNull();
  });

  it('says when the stored settings cannot be read', async () => {
    globalThis.fetch = (async () => Response.json({ releaseProvenance: row({ problem: 'stored_settings_unreadable', productionRefs: [], packageMap: [] }) })) as unknown as typeof fetch;
    mount(<ReleaseTracking projectId="x" />);
    expect((await screen.findByRole('alert')).textContent).toContain('cannot be read');
  });

  it('saves the form as one write naming refs and rules, never a repository or a token', async () => {
    const puts: unknown[] = [];
    globalThis.fetch = (async (_: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') puts.push(JSON.parse(String(init.body)));
      return Response.json({ releaseProvenance: row() });
    }) as typeof fetch;
    mount(<ReleaseTracking projectId="x" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit release tracking' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save release tracking' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ revision: 'rev_1', enabled: true, productionRefs: ['refs/tags/myco/v*'],
      integrationRefs: ['main'], packageMap: [{ pathGlob: 'packages/myco/', tagPattern: 'refs/tags/myco/v*' }], maxLookups: 50, includeUnknown: true });
  });
});
