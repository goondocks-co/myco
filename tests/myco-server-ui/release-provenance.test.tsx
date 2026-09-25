import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ReleaseChip } from '../../packages/myco-server/ui/src/components/release/ReleaseChip';
import { ReleaseTracking, checkSummary } from '../../packages/myco-server/ui/src/components/release/ReleaseTracking';
import { checkPending, RELEASE_CHECK_REFRESH_MS, type ReleaseProvenanceRow } from '../../packages/myco-server/ui/src/hooks/use-release-provenance';

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

describe('a lookup token, by the target this Deployment runs on', () => {
  /** A Deployment whose status names `target` (or fails), whose release tracking has no token, and whose last check stopped with `failure`. */
  function deployment(target: string | null, failure = 'rate_limited_without_credential') {
    const stopped = row({ credential: { ...row().credential, configured: false },
      check: { ...row().check!, status: 'unavailable', failure, lookups: 1,
        counts: { checked: 0, changed: 0, unchanged: 0, unknown: 0, unavailable: 1, deferred: 47 } } });
    globalThis.fetch = (async (input: RequestInfo | URL) => new URL(String(input), 'https://s').pathname === '/api/status'
      ? (target === null ? new Response(null, { status: 503 }) : Response.json({ target }))
      : Response.json({ releaseProvenance: stopped })) as typeof fetch;
    mount(<ReleaseTracking projectId="x" />);
  }
  const openForm = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Edit release tracking' }));
    return screen.findByLabelText(/Lookup token/);
  };

  it('on Cloudflare says a token is needed even for a public repository, in the row and the form', async () => {
    deployment('cloudflare');
    await waitFor(() => expect(screen.getByTestId('release-credential').textContent).toContain('one is needed here even for a public repository'));
    expect((await openForm()).getAttribute('placeholder')).toBe('Needed here, even for a public repository');
    expect(screen.getByText(/on Cloudflare that address is shared/)).toBeTruthy();
  });

  it('on the native target keeps the token optional for a public repository', async () => {
    deployment('bun');
    await waitFor(() => expect(screen.getByTestId('release-check')).toBeTruthy());
    expect(await openForm().then((input) => input.getAttribute('placeholder'))).toBe('Optional for a public repository');
    expect(screen.getByText(/optional for a public one/)).toBeTruthy();
    expect(screen.getByTestId('release-credential').textContent).toStartWith('Lookup credential: none · ');
    expect(document.body.textContent).not.toContain('Cloudflare');
  });

  it('says nothing either way about a public repository while the target is unknown', async () => {
    deployment(null);
    await waitFor(() => expect(screen.getByTestId('release-check')).toBeTruthy());
    expect((await openForm()).getAttribute('placeholder')).toBe('Needed for a private repository');
    expect(screen.getByTestId('release-credential').textContent).toStartWith('Lookup credential: none · ');
    expect(document.body.textContent).not.toMatch(/public/);
  });

  it('names the remedy when the check GitHub rate-limited ran without a token', async () => {
    deployment('bun');
    await waitFor(() => expect(screen.getByTestId('release-check').textContent)
      .toContain('stopped: GitHub rate limit reached without a lookup token. Earlier states are kept. Add a read-only lookup token'));
  });

  it('names no token remedy when the rate-limited check had one, even if it was removed since', async () => {
    deployment('bun', 'rate_limited');
    await waitFor(() => expect(screen.getByTestId('release-check').textContent).toContain('stopped: GitHub rate limit reached. Earlier states are kept.'));
    expect(screen.getByTestId('release-check').textContent).not.toContain('Add a read-only lookup token');
  });
});
