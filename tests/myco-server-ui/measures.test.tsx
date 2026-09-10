/**
 * The measures page: no figure without its sample.
 *
 * The gate is the first test. It collects every measure the page renders and
 * asserts each one carries a sample line, and that a measure with no rows shows
 * the absent-sample words in place of a figure. A tile that rendered a value and
 * no sample would let a share drawn from eight sessions read like a share drawn
 * from eight thousand, which is the exact mistake the page exists to prevent.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';

const ME = { sub: '583231', login: 'octocat', member: { id: 'mem_1', label: 'chris' } };
const PROJECTS = { projects: [{ projectId: 'x', name: 'Project X', createdAt: 0, sessionCount: 0, lastActivityAt: null, archivedAt: null, archivedBy: null }] };

/** Every measure a served report carries, each overridable by name. */
const report = (over: Record<string, unknown> = {}) => ({
  windowDays: 30,
  since: 0,
  contextPresent: { value: null, sampleSize: 0 },
  sporeServeRate: { value: null, sampleSize: 0 },
  callsPerPrompt: { value: null, sampleSize: 0 },
  callsPerPromptByHarness: [],
  planReadsPerSession: { value: null, sampleSize: 0 },
  firstInjectionMs: { value: null, sampleSize: 0 },
  evalPassRate: { value: null, sampleSize: 0 },
  ...over,
});

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

function server(routes: Record<string, () => Response>): { requested: string[] } {
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    requested.push(url.pathname + url.search);
    return routes[url.pathname + url.search]?.() ?? routes[url.pathname]?.() ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return { requested };
}

const base = (extra: Record<string, () => Response> = {}) => ({
  '/auth/me': () => Response.json(ME),
  '/api/projects': () => Response.json(PROJECTS),
  ...extra,
});

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

/** Every measure the page rendered, as the reader sees it: the figure, the sample line, and whether it said there was no sample. */
async function tiles(): Promise<Array<{ label: string; value: string | null; sample: string; noSample: boolean }>> {
  await screen.findAllByTestId('measure-tile');
  return screen.getAllByTestId('measure-tile').map((tile) => ({
    label: tile.getAttribute('aria-label') ?? '',
    value: within(tile).queryByTestId('measure-value')?.textContent ?? null,
    sample: within(tile).getByTestId('measure-sample').textContent ?? '',
    noSample: within(tile).queryByTestId('measure-no-sample') !== null,
  }));
}

describe('the measures page', () => {
  it('renders no measure without its sample, whatever the report holds', async () => {
    server(base({
      '/api/kpis?window=30': () => Response.json(report({
        contextPresent: { value: 0.625, sampleSize: 8 },
        sporeServeRate: { value: 0.25, sampleSize: 8 },
        callsPerPrompt: { value: 1.5, sampleSize: 8 },
        callsPerPromptByHarness: [{ harness: 'claude-code', value: 1.5, sampleSize: 8 }],
        planReadsPerSession: { value: 0.5, sampleSize: 4 },
        firstInjectionMs: { value: 90_000, sampleSize: 2 },
      })),
    }));
    mount('/measures');
    const rendered = await tiles();

    // Six measures, and every one of them carries a sample line.
    expect(rendered).toHaveLength(6);
    for (const tile of rendered) {
      expect({ label: tile.label, hasSample: /^n = [\d,]+ \w+s?$/.test(tile.sample) }).toEqual({ label: tile.label, hasSample: true });
      // A figure and an absent-sample note are mutually exclusive on every path.
      expect({ label: tile.label, exclusive: (tile.value !== null) !== tile.noSample }).toEqual({ label: tile.label, exclusive: true });
    }
  });

  it('shows the measured figures and the sample each one stands on', async () => {
    server(base({
      '/api/kpis?window=30': () => Response.json(report({
        contextPresent: { value: 0.625, sampleSize: 8 },
        sporeServeRate: { value: 0.25, sampleSize: 8 },
        callsPerPrompt: { value: 1.5, sampleSize: 8 },
        planReadsPerSession: { value: 0.5, sampleSize: 4 },
        firstInjectionMs: { value: 90_000, sampleSize: 1 },
      })),
    }));
    mount('/measures');
    const byLabel = new Map((await tiles()).map((t) => [t.label, t]));
    expect(byLabel.get('Prompts that arrived with context')).toEqual({
      label: 'Prompts that arrived with context', value: '63%', sample: 'n = 8 prompts', noSample: false,
    });
    expect(byLabel.get('Time to first context')).toEqual({
      label: 'Time to first context', value: '1m 30s', sample: 'n = 1 machine', noSample: false,
    });
    expect(byLabel.get('Plan reads per session')!.value).toBe('0.50');
  });

  it('says there are no evaluations rather than showing a pass rate of zero', async () => {
    server(base({ '/api/kpis?window=30': () => Response.json(report({ contextPresent: { value: 1, sampleSize: 3 } })) }));
    mount('/measures');
    const byLabel = new Map((await tiles()).map((t) => [t.label, t]));
    const evals = byLabel.get('Evaluation pass rate')!;
    expect({ value: evals.value, sample: evals.sample, noSample: evals.noSample })
      .toEqual({ value: null, sample: 'n = 0 checks', noSample: true });
    expect(screen.getByText(/No evaluations recorded/)).toBeTruthy();
  });

  it('splits the diagnostic by agent, each split carrying its own sample', async () => {
    server(base({
      '/api/kpis?window=30': () => Response.json(report({
        callsPerPrompt: { value: 1, sampleSize: 3 },
        callsPerPromptByHarness: [
          { harness: 'claude-code', value: 1.5, sampleSize: 2 },
          { harness: 'unrecorded', value: 0, sampleSize: 1 },
          { harness: 'codex', value: null, sampleSize: 0 },
        ],
      })),
    }));
    mount('/measures');
    const body = await screen.findByLabelText('Calls per prompt by agent');
    const rows = [...body.querySelectorAll('tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
    // A split with no prompts behind it shows no figure, the same rule the tiles follow.
    expect(rows).toEqual([
      ['Claude Code', '1.50', 'n = 2 prompts'],
      ['Agent not recorded', '0.00', 'n = 1 prompts'],
      ['Codex', '—', 'n = 0 prompts'],
    ]);
  });

  it('says there is nothing to split when the window holds no prompt', async () => {
    server(base({ '/api/kpis?window=30': () => Response.json(report()) }));
    mount('/measures');
    expect(await screen.findByText(/nothing to split by agent/)).toBeTruthy();
  });

  it('carries the window in the URL and reads the server again for it', async () => {
    const { requested } = server(base({
      '/api/kpis?window=30': () => Response.json(report()),
      '/api/kpis?window=7': () => Response.json(report({ windowDays: 7, contextPresent: { value: 1, sampleSize: 2 } })),
    }));
    mount('/measures');
    await screen.findAllByTestId('measure-tile');
    fireEvent.click(screen.getByRole('tab', { name: 'Last 7 days' }));
    await waitFor(() => expect(requested).toContain('/api/kpis?window=7'));
    const byLabel = new Map((await tiles()).map((t) => [t.label, t]));
    expect(byLabel.get('Prompts that arrived with context')!.sample).toBe('n = 2 prompts');
  });

  it('says the server could not be reached rather than rendering empty measures', async () => {
    server(base({ '/api/kpis?window=30': () => new Response(null, { status: 503 }) }));
    mount('/measures');
    expect(await screen.findByText(/Could not reach the server/)).toBeTruthy();
    expect(screen.queryAllByTestId('measure-tile')).toEqual([]);
  });
});
