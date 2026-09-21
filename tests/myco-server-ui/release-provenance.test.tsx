import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ReleaseChip } from '../../packages/myco-server/ui/src/components/release/ReleaseChip';
import { ReleaseTracking, checkSummary } from '../../packages/myco-server/ui/src/components/release/ReleaseTracking';
import type { ReleaseProvenanceRow } from '../../packages/myco-server/ui/src/hooks/use-release-provenance';

const NOW = Date.now();
const TOKEN = 'ghp_fixturetokenvalue1234567890';
const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

const row = (over: Partial<ReleaseProvenanceRow> = {}): ReleaseProvenanceRow => ({
  enabled: true, githubRepo: 'goondocks-co/myco', productionRefs: ['refs/tags/myco/v*'], integrationRefs: ['main'],
  packageMap: [{ pathGlob: 'packages/myco/', tagPattern: 'refs/tags/myco/v*' }], includeUnknown: true, maxLookups: 50,
  revision: 'rev_1', updatedAt: NOW, updatedBy: 'mem_1',
  credential: { configured: true, purpose: 'Reads release tags and pull requests for this Project. It is not used for code tasks.' },
  suggestedRepo: 'goondocks-co/myco', problem: null,
  check: { requestedAt: null, startedAt: NOW - 60_000, finishedAt: NOW - 60_000, status: 'complete', failure: null,
    counts: { checked: 48, changed: 3, unchanged: 43, unknown: 2, unavailable: 0, deferred: 0 }, lookups: 20, lastCompleteAt: NOW - 60_000 },
  ...over,
});

function mount(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('the session release chip', () => {
  it('names each state in fixed words, the ref people use, and nothing for a session without a state', () => {
    const cases: Array<[string, string | null, string]> = [
      ['released', 'refs/tags/myco/v2.0.3', 'Released· myco/v2.0.3'],
      ['merged_unreleased', 'main', 'Merged, not released· main'],
      ['not_on_release_line', null, 'Not on a release line'],
      ['unknown', null, 'Release unknown'],
    ];
    for (const [state, ref, text] of cases) {
      mount(<ReleaseChip release={{ state, confidence: 'high', ref, reason: 'r', checkedAt: NOW, latestCheck: null }} />);
      expect(screen.getByTestId('release-chip').textContent).toBe(text);
      cleanup();
    }
    mount(<ReleaseChip release={null} />);
    expect(screen.queryByTestId('release-chip')).toBeNull();
  });

  it('says when the latest check failed after the state shown, and how old the state is', () => {
    mount(<ReleaseChip release={{ state: 'merged_unreleased', confidence: 'medium', ref: 'main', reason: 'In main', checkedAt: NOW - 7_200_000,
      latestCheck: { status: 'unavailable', failure: 'credential_rejected', finishedAt: NOW - 60_000 } }} />);
    const chip = screen.getByTestId('release-chip');
    expect(chip.textContent).toContain('latest check unavailable');
    expect(chip.getAttribute('title')).toContain('GitHub refused the credential');
    expect(chip.getAttribute('title')).toContain('Checked 2h ago');
  });
});

describe('release tracking in project settings', () => {
  it('shows the configuration, whether a credential is configured and its purpose, never any of the token, and requests a check', async () => {
    const sent: Array<{ method: string; path: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input), 'https://s').pathname;
      if (init?.method && init.method !== 'GET') sent.push({ method: init.method, path });
      return Response.json(path.endsWith('/check') ? { requested: true } : { releaseProvenance: row() });
    }) as typeof fetch;
    const { container } = mount(<ReleaseTracking projectId="x" />);
    await waitFor(() => expect(screen.getByTestId('release-check')).toBeTruthy());
    expect(container.textContent).toContain('goondocks-co/myco');
    expect(container.textContent).toContain('packages/myco/ → refs/tags/myco/v*');
    expect(container.textContent).toContain('Lookup credential: configured · Reads release tags and pull requests');
    expect(container.textContent).not.toContain('ghp_');
    expect(container.textContent).not.toContain(TOKEN.slice(-4));
    expect(screen.getByTestId('release-check').textContent).toContain('48 checked · 3 changed · 2 unknown · 0 not reached');
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(sent).toEqual([{ method: 'POST', path: '/api/projects/x/release-provenance/check' }]));
  });

  it('names a failed check and unreadable stored settings honestly', () => {
    expect(checkSummary(row({ check: { ...row().check!, status: 'unavailable', failure: 'rate_limited',
      counts: { checked: 0, changed: 0, unchanged: 0, unknown: 0, unavailable: 1, deferred: 4 } } }).check))
      .toContain('stopped: GitHub rate limit reached. Earlier states are kept.');
    expect(checkSummary(null)).toBe('Not checked yet');
  });

  it('says when the stored settings cannot be read', async () => {
    globalThis.fetch = (async () => Response.json({ releaseProvenance: row({ problem: 'stored_settings_unreadable', productionRefs: [], packageMap: [] }) })) as unknown as typeof fetch;
    mount(<ReleaseTracking projectId="x" />);
    expect((await screen.findByRole('alert')).textContent).toContain('cannot be read');
  });

  it('saves the form as one write with the credential only when a new token is typed', async () => {
    const puts: unknown[] = [];
    globalThis.fetch = (async (_: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') puts.push(JSON.parse(String(init.body)));
      return Response.json({ releaseProvenance: row() });
    }) as typeof fetch;
    mount(<ReleaseTracking projectId="x" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit release tracking' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save release tracking' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({ revision: 'rev_1', enabled: true, githubRepo: 'goondocks-co/myco', productionRefs: ['refs/tags/myco/v*'],
      integrationRefs: ['main'], packageMap: [{ pathGlob: 'packages/myco/', tagPattern: 'refs/tags/myco/v*' }], maxLookups: 50, includeUnknown: true });
  });
});
