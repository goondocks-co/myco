/**
 * Health's upkeep and backups, as an admin reads them on `/status/health`:
 * backups made here and their refusals, housekeeping run on demand, the
 * transcripts still waiting to be read, automatic recovery in every state it
 * can be in, and the store's routine checks.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { availableWords, backlogWords, cadenceWords, latestWords, reportWords } from '../../packages/myco-server/ui/src/features/admin/health/words';

const ME = { sub: '583231', login: 'octocat', member: { id: 'mem_1', label: 'chris', role: 'admin' as const } };
const PROJECTS = { projects: [{ projectId: 'x', name: 'Project X', createdAt: 0, sessionCount: 2, lastActivityAt: null, archivedAt: null, archivedBy: null }] };
const STATUS = {
  schema: { expected: 57, found: 57, matches: true }, target: 'bun', capabilities: [],
  workers: { available: true, workersBusy: 0, runsQueued: 0, recentWithinMs: 90_000, fleet: [] },
  transcriptBacklog: null, projects: [], capture: [],
};

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

type Route = (init?: RequestInit) => Response;

/** The answers every mount of Health needs; each test overrides what it is about. */
const base: Record<string, Route> = {
  '/auth/me': () => Response.json(ME),
  '/api/projects': () => Response.json(PROJECTS),
  '/api/status': () => Response.json(STATUS),
  '/api/attention': () => Response.json({ items: [], unavailable: [] }),
  '/api/backups': () => Response.json({ backups: [] }),
  '/api/maintenance': () => Response.json({ checks: [] }),
  '/api/credentials': () => Response.json({ rows: [], cursor: null }),
};

function server(routes: Record<string, Route>): { requested: string[] } {
  const requested: string[] = [];
  const all = { ...base, ...routes };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    requested.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    return all[url.pathname]?.(init) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return { requested };
}

function mount(path = '/status/health') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

/** Opens a ⋯ menu by its name and answers the menu. */
async function openMenu(name: string | RegExp, scope: HTMLElement = document.body) {
  const trigger = await within(scope).findByRole('button', { name });
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return screen.findByRole('menu');
}

describe('backups on Health', () => {
  it('shows a refused backup reason and the operator recovery path', async () => {
    const reason = 'The assembled backup is past the supported byte bound.';
    server({
      '/api/backups': (init) => init?.method === 'POST'
        ? Response.json({ error: 'bad_request', reason }, { status: 400 })
        : Response.json({ backups: [] }),
    });
    mount('/operations');
    fireEvent.click(await screen.findByRole('button', { name: 'Create backup' }));
    expect(await screen.findByText(reason)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'operator backup and recovery procedure' }).getAttribute('href'))
      .toBe('https://github.com/goondocks-co/myco/blob/main/docs/architecture/deployment-recovery.md');
    expect(screen.getByText('No backups yet. The first one is a click away.')).toBeTruthy();
  });

  it('lists a backup by when it was made, with its size, and downloads, pins and restores it from its menu', async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    let pinned = 0;
    const row = () => ({ id: 'bk_7f3a9c0e21', key: 'backups/1.sqlite', created_at: Date.parse('2026-09-01T12:00:00Z'), size_bytes: 3 * 1024 * 1024, counts_json: '{}', schema_version: 57, producer: 'mem_1', pinned, present: true });
    server({
      '/api/backups': () => Response.json({ backups: [row()] }),
      '/api/backups/bk_7f3a9c0e21/pin': (init) => { const body = JSON.parse(String(init!.body)); posts.push({ path: 'pin', body }); pinned = body.pinned ? 1 : 0; return Response.json({ pinned: body.pinned }); },
    });
    mount();
    const list = await screen.findByRole('group', { name: 'Backups' });
    expect(list.textContent).toContain('3.0 MB · schema version 57');
    expect(list.textContent).not.toContain('bk_7f3a9c0e21');
    expect(within(list).getByRole('link', { name: 'Download' }).getAttribute('href')).toBe('/api/backups/bk_7f3a9c0e21/artifact');
    fireEvent.click(within(await openMenu(/^More for the backup of /, list)).getByRole('menuitem', { name: 'Pin' }));
    await waitFor(() => expect(posts).toEqual([{ path: 'pin', body: { pinned: true } }]));
    expect(await within(list).findByText('Pinned')).toBeTruthy();
  });

  it('marks a backup whose file is missing, and offers no download or restore for it', async () => {
    server({ '/api/backups': () => Response.json({ backups: [{ id: 'bk_old', key: 'k', created_at: 0, size_bytes: 2048, counts_json: '{}', schema_version: 50, producer: 'selfhosted', pinned: 0, present: false }] }) });
    mount();
    const list = await screen.findByRole('group', { name: 'Backups' });
    expect(within(list).getByText('File missing')).toBeTruthy();
    expect(within(list).queryByRole('link', { name: 'Download' })).toBeNull();
    const restore = within(await openMenu(/^More for the backup of /, list)).getByRole('menuitem', { name: 'Restore…' });
    expect(restore.getAttribute('data-disabled')).not.toBeNull();
  });
});

describe('housekeeping on Health', () => {
  it('runs the tick on the button and says what it did in the reader\'s words', async () => {
    const { requested } = server({
      '/api/wake': () => Response.json({ state: 'sleep', heldBy: null, idleMs: 2_000_000, jobs: [{ name: 'agent-run-retention', changed: 3, failed: null }, { name: 'run-stale-sweep', changed: 1, failed: null }], nextWakeMs: 300_000 }),
    });
    mount('/operations');
    const button = await screen.findByRole('button', { name: 'Run housekeeping now' });
    expect(screen.getByText(/Old run records are removed/).textContent).toContain('on the server\'s own clock');
    fireEvent.click(button);
    expect((await screen.findByText(/The server is asleep/)).textContent).toBe('The server is asleep. Removed 3 old run records; closed 1 run whose runtime went away. Next wake in 5 min.');
    expect(requested).toContain('POST /api/wake');
  });

  it('says how many transcripts, and how many bytes, are still waiting to be read, from the count the tick reads', async () => {
    server({ '/api/status': () => Response.json({ ...STATUS, transcriptBacklog: { transcripts: 470, bytes: 2_390_000_000, imported: { transcripts: 460, bytes: 2_380_000_000 } } }) });
    mount('/operations');
    expect((await screen.findByTestId('transcript-backlog')).textContent).toBe('470 transcripts (2.2 GB) waiting to be read into sessions.');
  });

  it('says nothing is waiting where nothing is, and words a chained wake in seconds', () => {
    expect(backlogWords({ transcripts: 0, bytes: 0, imported: { transcripts: 0, bytes: 0 } })).toBeNull();
    expect(backlogWords(null)).toBeNull();
    expect(backlogWords({ transcripts: 1, bytes: 2048, imported: { transcripts: 1, bytes: 2048 } })).toBe('1 transcript (2.0 KB) waiting to be read into sessions.');
    expect(reportWords({ state: 'idle', heldBy: null, idleMs: 400_000, jobs: [{ name: 'transcript-parse', changed: 120, failed: null, more: true }], nextWakeMs: 2_000 }))
      .toBe('The server is idle. Read 120 rows from transcripts, with more still to read. Next wake in 2 s.');
  });

  it('says when the server could not run its housekeeping', async () => {
    server({ '/api/wake': () => new Response(null, { status: 503 }) });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Run housekeeping now' }));
    expect(await screen.findByText('The server could not run its housekeeping right now.')).toBeTruthy();
  });

  it('words every state, a held state, a failed job, and deep sleep', () => {
    expect(reportWords({ state: 'idle', heldBy: 'run:live', idleMs: 1, jobs: [], nextWakeMs: 60_000 })).toBe('The server is idle while a run is live. Nothing was due. Next wake in 1 min.');
    expect(reportWords({ state: 'deep_sleep', heldBy: null, idleMs: null, jobs: [], nextWakeMs: null })).toBe('The server is in deep sleep. Nothing was due. No wake is scheduled while it sleeps this deeply.');
    expect(reportWords({ state: 'active', heldBy: null, idleMs: 0, jobs: [{ name: 'agent-run-retention', changed: 0, failed: 'db' }, { name: 'run-stale-sweep', changed: 0, failed: null }], nextWakeMs: 60_000 }))
      .toBe('The server is in use. Old run records could not be removed; closed 0 runs whose runtime went away. Next wake in 1 min.');
  });

  it('offers the diagnostics file from the admin route', async () => {
    server({});
    mount();
    expect((await screen.findByTestId('download-diagnostics')).getAttribute('href')).toBe('/api/diagnostics');
  });
});

/**
 * What the Deployment's owner is told about automatic recovery. The words
 * matter as much as the state: a complete staging is not a backup an owner
 * can restore from, and Health must never imply it is.
 */
describe('automatic recovery on Health', () => {
  const RECOVERY = (schedule: Record<string, unknown>) => ({
    attempt: schedule.latest === null ? null : 1, stage: 'idle', recoverable: false, schedule,
  });
  const recoveryBase = { supported: true, configured: true, ready: true, intervalHours: 6, dueAt: null, due: false, latest: null, available: { state: 'none' }, idleBecause: null };

  it('tells an owner the cadence, the last attempt and what is available', async () => {
    const startedAt = Date.parse('2026-09-18T12:00:00.000Z');
    server({
      '/api/recovery/exports': () => Response.json(RECOVERY({
        ...recoveryBase,
        dueAt: Date.now() + 3 * 60 * 60 * 1000,
        latest: { attempt: 7, stage: 'complete', startedAt, failure: null },
        available: { state: 'staged', attempt: 7, prefix: 'staging/7', needs: 'an operator materializes this staging into a verified recovery artifact; a staging alone is not one' },
      })),
    });
    mount();
    expect((await screen.findByTestId('recovery-cadence')).textContent).toContain('Every 6 h');
    expect(screen.getByTestId('recovery-cadence').textContent).toContain('Next due in 3h');
    expect(screen.getByTestId('recovery-latest').textContent).toContain('Attempt 7');
    const available = screen.getByTestId('recovery-available').textContent ?? '';
    expect(available).toContain('complete staging');
    // The claim Health must never make.
    expect(available).toContain('not a recovery artifact yet');
    expect(available).not.toContain('recoverable');
  });

  it('says automatic recovery is off, and unavailable where no producer runs', async () => {
    server({ '/api/recovery/exports': () => Response.json(RECOVERY({ ...recoveryBase, configured: false, intervalHours: null, idleBecause: 'automatic recovery is off: set "Back up every" to schedule it' })) });
    mount();
    expect((await screen.findByTestId('recovery-cadence')).textContent).toContain('Automatic recovery is off');
    cleanup();

    server({ '/api/recovery/exports': () => Response.json({ error: 'bad_request', reason: 'this Deployment runs no hosted recovery producer' }, { status: 400 }) });
    mount();
    expect((await screen.findByTestId('recovery-unavailable')).textContent).toContain('Automatic recovery doesn’t run on this server');
  });

  it('shows a failed attempt as failed, with the producer\'s own reason', async () => {
    server({
      '/api/recovery/exports': () => Response.json(RECOVERY({
        ...recoveryBase, due: true, dueAt: Date.now(),
        latest: { attempt: 3, stage: 'failed', startedAt: Date.parse('2026-09-18T09:00:00.000Z'), failure: 'provider_refused' },
        available: { state: 'none' },
      })),
    });
    mount();
    expect((await screen.findByTestId('recovery-latest')).textContent).toContain('failed: provider refused');
    expect(screen.getByTestId('recovery-cadence').textContent).toContain('Due now');
    expect(screen.getByTestId('recovery-available').textContent).toContain('No recovery data exists yet');
  });

  it('offers to forget an earlier export only where the last attempt failed waiting on it, behind a confirm (#1493 G3)', async () => {
    const failed = (error: string, unsettledExport?: { attempt: number; forgettableAt: number }) => ({
      ...RECOVERY({ ...recoveryBase, latest: { attempt: 4, stage: 'failed', startedAt: Date.parse('2026-09-18T09:00:00.000Z'), failure: error } }),
      attempt: 4, stage: 'failed', error, ...(unsettledExport === undefined ? {} : { unsettledExport }),
    });
    server({ '/api/recovery/exports': () => Response.json(failed('provider_refused')) });
    mount();
    await screen.findByTestId('recovery-latest');
    expect(screen.queryByTestId('recovery-unsettled')).toBeNull();
    cleanup();

    // Reported running too recently: the page says from when, and offers nothing to act on until then.
    server({ '/api/recovery/exports': () => Response.json(failed('export_unsettled', { attempt: 3, forgettableAt: Date.now() + 15 * 60_000 })) });
    mount();
    const waiting = await screen.findByTestId('recovery-unsettled');
    expect(waiting.textContent).toContain('it can be forgotten in 1');
    const early = within(await openMenu('More for automatic recovery', waiting)).getByRole('menuitem', { name: 'Forget the earlier export' });
    expect(early.getAttribute('data-disabled')).not.toBeNull();
    cleanup();

    const seen = server({
      '/api/recovery/exports': () => Response.json(failed('export_unsettled', { attempt: 3, forgettableAt: Date.now() - 1 })),
      '/api/recovery/exports/forget-unsettled': () => Response.json({ forgotten: { attempt: 3, requestedAt: 900 } }),
    });
    mount();
    const offered = await screen.findByTestId('recovery-unsettled');
    expect(offered.textContent).toContain('never said it ended');
    expect(offered.textContent).toContain('long enough to take it as ended');
    fireEvent.click(within(await openMenu('More for automatic recovery', offered)).getByRole('menuitem', { name: 'Forget the earlier export' }));
    const dialog = await screen.findByRole('dialog', { name: 'Forget the earlier export?' });
    // Cancelling sends nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(seen.requested).not.toContain('POST /api/recovery/exports/forget-unsettled');
    fireEvent.click(within(await openMenu('More for automatic recovery', offered)).getByRole('menuitem', { name: 'Forget the earlier export' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Forget it' }));
    expect((await within(offered).findByText(/attempt 3 requested is forgotten/)).textContent).toContain('the next attempt starts its own');
    expect(seen.requested).toContain('POST /api/recovery/exports/forget-unsettled');
  });

  it('tells an owner a read failed, rather than calling the Deployment unsupported', async () => {
    // A 503 says nothing about whether a producer exists.
    server({ '/api/recovery/exports': () => Response.json({ error: 'unavailable', message: 'the Deployment did not answer' }, { status: 503 }) });
    mount();
    expect((await screen.findByTestId('recovery-unreadable')).textContent).toContain('could not be read');
    expect(screen.queryByTestId('recovery-unavailable')).toBeNull();
  });

  it('shows an unreadable schedule beside the attempt the producer did answer', async () => {
    server({
      '/api/recovery/exports': () => Response.json({
        attempt: 7, stage: 'export', recoverable: false,
        schedule: { unreadable: 'whether automatic recovery is configured could not be read; a running export pauses its database' },
      }),
    });
    mount();
    expect((await screen.findByTestId('recovery-unreadable')).textContent).toContain('could not be read');
    expect(screen.getByTestId('recovery-latest').textContent).toContain('Attempt 7 is export');
    expect(screen.queryByTestId('recovery-cadence')).toBeNull();
  });

  it('says a configured schedule cannot run yet when this Deployment cannot admit one', async () => {
    server({
      '/api/recovery/exports': () => Response.json(RECOVERY({
        ...recoveryBase, intervalHours: 24, ready: false, due: false,
        idleBecause: 'automatic recovery cannot run: this Deployment carries no recovery configuration; update it so its deploy config renders one',
      })),
    });
    mount();
    const said = (await screen.findByTestId('recovery-cadence')).textContent ?? '';
    expect(said).toContain('Every 24 h');
    expect(said).toContain('cannot run yet');
    expect(said).toContain('no recovery configuration');
  });

  it('never calls a staging recoverable, at any state', () => {
    for (const available of [
      { state: 'none' as const },
      { state: 'incomplete' as const, attempt: 2, stage: 'copy' },
      { state: 'staged' as const, attempt: 2, prefix: 'staging/2', needs: 'an operator materializes this staging into a verified recovery artifact; a staging alone is not one' },
    ]) {
      const words = availableWords(available);
      expect(words).not.toContain('recoverable');
      expect(words.length).toBeGreaterThan(10);
    }
    expect(cadenceWords({ ...recoveryBase, supported: false, configured: false } as never, Date.now())).toContain('doesn’t run on this server');
    expect(latestWords({ ...recoveryBase, latest: null } as never)).toContain('No attempt has run yet');
  });

  it('shows a self-hosted Deployment its own artifact, and the operator step that target actually has', async () => {
    const startedAt = Date.parse('2026-09-18T12:00:00.000Z');
    const at = '/home/.myco/server/local-recovery/dep_1/1789750654766';
    server({
      '/api/recovery/exports': () => Response.json({
        attempt: 1789750654766, stage: 'complete', form: 'artifact', recoverable: false,
        schedule: {
          ...recoveryBase, intervalHours: 24, dueAt: startedAt + 86_400_000,
          latest: { attempt: 1789750654766, stage: 'complete', startedAt, failure: null },
          available: { state: 'artifact', attempt: 1789750654766, at, needs: 'restoring it also needs the wrapping key for its stored credentials, which is kept outside the artifact' },
        },
      }),
    });
    mount();
    const available = (await screen.findByTestId('recovery-available')).textContent ?? '';
    expect(available).toContain('verified recovery artifact');
    expect(available).toContain(at);
    expect(available).toContain('wrapping key');
    expect(available).not.toContain('materializ');
    const latest = (await screen.findByTestId('recovery-latest')).textContent ?? '';
    expect(latest).toContain('The last attempt');
    expect(latest).not.toContain('1789750654766');
  });

  it('calls a complete artifact what it is, names where it is, and says what a restore still needs', () => {
    const words = availableWords({
      state: 'artifact', attempt: 1789750654766, at: '/home/.myco/server/local-recovery/dep_1/1789750654766',
      needs: 'restoring it also needs the wrapping key for its stored credentials, which is kept outside the artifact',
    });
    expect(words).toContain('verified recovery artifact');
    expect(words).toContain('/home/.myco/server/local-recovery/dep_1/1789750654766');
    expect(words).toContain('wrapping key');
    expect(words).not.toContain('materializ');
    expect(words).not.toContain('staging');
  });

  it('names an artifact attempt by when it started, not by an instant read as a number', () => {
    const latest = { attempt: 1789750654766, stage: 'complete', startedAt: 1789750654766, failure: null };
    const artifact = latestWords({ ...recoveryBase, latest } as never, 'artifact');
    expect(artifact).toContain('The last attempt');
    expect(artifact).toContain('wrote a complete artifact');
    expect(artifact).not.toContain('1789750654766');
    expect(latestWords({ ...recoveryBase, latest: { ...latest, attempt: 7 } } as never)).toContain('Attempt 7');
    expect(latestWords({ ...recoveryBase, latest: { ...latest, attempt: 7 } } as never)).toContain('staged everything it named');
  });

  it('says an attempt waits on an unsettled export, never that a transient it spent failed it (#1484)', () => {
    const waiting = { attempt: 3, stage: 'export', startedAt: null, failure: 'provider_unavailable' };
    expect(latestWords({ ...recoveryBase, latest: { ...waiting, waiting: 'earlier_export' } } as never)).toBe('Attempt 3 is waiting for an earlier export to end before it starts its own.');
    expect(latestWords({ ...recoveryBase, latest: { ...waiting, waiting: 'own_request' } } as never)).toBe('Attempt 3 is waiting to learn whether the export it asked for started.');
    expect(latestWords({ ...recoveryBase, latest: { ...waiting, stage: 'failed', failure: 'export_unanswered', waiting: null } } as never)).toContain('failed: export unanswered');
  });

  it('names a failure only once the attempt failed, and says how long a wait has lasted (#1484 F7, F1)', () => {
    const advancing = { attempt: 3, stage: 'export', startedAt: null, failure: 'provider_unavailable', waiting: null };
    expect(latestWords({ ...recoveryBase, latest: advancing } as never)).toBe('Attempt 3 is export.');
    const since = Date.now() - 35 * 60_000;
    expect(latestWords({ ...recoveryBase, latest: { ...advancing, waiting: 'earlier_export', waitingSince: since } } as never)).toContain('(requested 35m ago)');
  });
});

describe('store checks on Health', () => {
  const hostedStatus = {
    checks: [
      {
        check: 'optimize', support: { supported: true, label: 'Refreshes the statistics queries are planned from' },
        cadence: { state: 'not_configured', leaf: 'maintenance.auto_optimize' }, dueAt: null, running: false, latest: null,
      },
      {
        check: 'integrity', support: { supported: true, label: 'A quick check of every table and index, and of every link between records' },
        cadence: { state: 'on', intervalHours: 168 }, dueAt: 0, running: false,
        latest: {
          runId: 'run_9c1e0b7a44', trigger: 'schedule', state: 'findings', startedAt: 0, finishedAt: 1, errorClass: null,
          findings: ['foreign key: smoke_child row 1 names a missing smoke_parent'], findingsOmitted: 2,
          measurements: [
            { name: 'size', state: 'measured', value: 2 * 1024 * 1024, unit: 'bytes' },
            { name: 'daily_quota', state: 'unavailable', reason: 'reported only by account analytics' },
          ],
        },
      },
    ],
  };

  it('shows each check\'s findings, what it could not measure, and an unset schedule as unset', async () => {
    server({ '/api/maintenance': () => Response.json(hostedStatus) });
    mount();
    const integrity = await screen.findByTestId('maintenance-integrity');
    expect(within(integrity).getByText('foreign key: smoke_child row 1 names a missing smoke_parent')).toBeTruthy();
    expect(within(integrity).getByText('…and 2 more not kept')).toBeTruthy();
    expect(within(integrity).getByText('Unavailable — reported only by account analytics')).toBeTruthy();
    expect(within(integrity).getByText('2.0 MB')).toBeTruthy();
    expect(integrity.textContent).not.toContain('run_9c1e0b7a44');
    const optimize = screen.getByTestId('maintenance-optimize');
    expect(within(optimize).getByText('Never run.')).toBeTruthy();
    expect(within(optimize).getByText(/Automatic runs are not set up/)).toBeTruthy();
  });

  it('runs a check on the button and shows a refusal in the server\'s words', async () => {
    const { requested } = server({
      '/api/maintenance': () => Response.json(hostedStatus),
      '/api/maintenance/optimize/run': () => Response.json({ error: 'refused', refusal: 'already_running', reason: 'an optimize run is already in progress' }, { status: 409 }),
    });
    mount();
    const optimize = await screen.findByTestId('maintenance-optimize');
    fireEvent.click(within(optimize).getByRole('button', { name: 'Run now' }));
    expect((await within(optimize).findByRole('alert')).textContent).toBe('an optimize run is already in progress');
    expect(requested).toContain('POST /api/maintenance/optimize/run');
  });

  it('words a running record the server no longer runs as interrupted and offers a run, and a live one as running', async () => {
    const runningRecord = { runId: 'r2', trigger: 'schedule', state: 'running', startedAt: 0, finishedAt: null, errorClass: null, findings: [], findingsOmitted: 0, measurements: [] };
    const supported = { supported: true, label: 'Checks every table, index and page' };
    server({
      '/api/maintenance': () => Response.json({
        checks: [
          { check: 'integrity', support: supported, cadence: { state: 'off' }, dueAt: null, running: false, latest: runningRecord },
          { check: 'optimize', support: supported, cadence: { state: 'off' }, dueAt: null, running: true, latest: { ...runningRecord, runId: 'r3' } },
        ],
      }),
    });
    mount();
    const integrity = await screen.findByTestId('maintenance-integrity');
    expect(within(integrity).getByTestId('maintenance-integrity-outcome').textContent).toMatch(/^Interrupted: started .+ \(scheduled\) and ended without recording an outcome\.$/);
    expect(within(integrity).getByRole('button', { name: 'Run now' }).hasAttribute('disabled')).toBe(false);
    const optimize = screen.getByTestId('maintenance-optimize');
    expect(within(optimize).getByTestId('maintenance-optimize-outcome').textContent).toMatch(/^Running since /);
    expect(within(optimize).getByRole('button', { name: 'Running…' }).hasAttribute('disabled')).toBe(true);
  });

  it('takes a run answered with its running claim as running, with no error, and reads the status again', async () => {
    const supported = { supported: true, label: 'Checks every table, index and page' };
    const claim = { runId: 'r4', trigger: 'owner', state: 'running', startedAt: 0, finishedAt: null, errorClass: null, findings: [], findingsOmitted: 0, measurements: [] };
    let running = false;
    const { requested } = server({
      '/api/maintenance': () => Response.json({ checks: [{ check: 'integrity', support: supported, cadence: { state: 'off' }, dueAt: null, running, latest: running ? claim : null }] }),
      '/api/maintenance/integrity/run': () => { running = true; return Response.json(claim); },
    });
    mount();
    const integrity = await screen.findByTestId('maintenance-integrity');
    expect(within(integrity).getByTestId('maintenance-integrity-outcome').textContent).toBe('Never run.');
    fireEvent.click(within(integrity).getByRole('button', { name: 'Run now' }));
    expect(await within(integrity).findByText(/^Running since /)).toBeTruthy();
    expect(within(integrity).getByRole('button', { name: 'Running…' }).hasAttribute('disabled')).toBe(true);
    expect(within(integrity).queryByRole('alert')).toBeNull();
    expect(requested.filter((r) => r === 'GET /api/maintenance').length).toBeGreaterThanOrEqual(2);
  });

  it('offers no run for a check this server cannot perform', async () => {
    server({ '/api/maintenance': () => Response.json({ checks: [{ check: 'integrity', support: { supported: false, reason: 'this Deployment has no store maintenance' }, cadence: { state: 'off' }, dueAt: null, running: false, latest: null }] }) });
    mount();
    const integrity = await screen.findByTestId('maintenance-integrity');
    expect(within(integrity).getByText('Not available on this server: this Deployment has no store maintenance.')).toBeTruthy();
    expect(within(integrity).queryByRole('button')).toBeNull();
  });
});
