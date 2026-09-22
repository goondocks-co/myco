import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { reportWords } from '../../packages/myco-server/ui/src/components/operations/WakePanel';
import { policyWords, progressWords } from '../../packages/myco-server/ui/src/components/operations/TitlingBackfillPanel';
import { availableWords, cadenceWords, latestWords } from '../../packages/myco-server/ui/src/components/operations/RecoveryPanel';

const ME = { sub: '583231', login: 'octocat', member: { id: 'mem_1', label: 'chris' } };
const PROJECTS = { projects: [{ projectId: 'x', name: 'Project X', createdAt: 0, sessionCount: 2, lastActivityAt: null }] };

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

function server(routes: Record<string, (init?: RequestInit) => Response>): { requested: string[] } {
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    requested.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    return routes[url.pathname]?.(init) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return { requested };
}

function mount(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

describe('housekeeping on the Operations page', () => {
  it('shows a refused backup reason and the operator recovery path', async () => {
    const reason = 'The assembled backup is past the supported byte bound.';
    server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/backups': (init) => init?.method === 'POST'
        ? Response.json({ error: 'bad_request', reason }, { status: 400 })
        : Response.json({ backups: [] }),
    });
    mount('/operations');
    fireEvent.click(await screen.findByRole('button', { name: 'Create backup' }));
    expect(await screen.findByText(reason)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'operator backup and recovery procedure' }).getAttribute('href'))
      .toBe('https://github.com/goondocks-co/myco/blob/main/docs/architecture/deployment-recovery.md');
  });

  it('runs the tick on the button and says what it did in the reader\'s words', async () => {
    const { requested } = server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/wake': () => Response.json({ state: 'sleep', heldBy: null, idleMs: 2_000_000, jobs: [{ name: 'agent-run-retention', changed: 3, failed: null }, { name: 'run-stale-sweep', changed: 1, failed: null }], nextWakeMs: 300_000 }),
    });
    mount('/operations');
    const button = await screen.findByRole('button', { name: 'Run housekeeping now' });
    expect(screen.getByText(/Old run records are removed/).textContent).toContain('on the server\'s own clock');
    fireEvent.click(button);
    expect((await screen.findByText(/The server is asleep/)).textContent).toBe('The server is asleep. Removed 3 old run records; closed 1 run whose runtime went away. Next wake in 5 min.');
    expect(requested).toContain('POST /api/wake');
  });

  it('says when the server could not run its housekeeping', async () => {
    server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/wake': () => new Response(null, { status: 503 }),
    });
    mount('/operations');
    fireEvent.click(await screen.findByRole('button', { name: 'Run housekeeping now' }));
    expect(await screen.findByText('The server could not run its housekeeping right now.')).toBeTruthy();
  });

  it('words every state, a held state, a failed job, and deep sleep', () => {
    expect(reportWords({ state: 'idle', heldBy: 'run:live', idleMs: 1, jobs: [], nextWakeMs: 60_000 })).toBe('The server is idle while a run is live. Nothing was due. Next wake in 1 min.');
    expect(reportWords({ state: 'deep_sleep', heldBy: null, idleMs: null, jobs: [], nextWakeMs: null })).toBe('The server is in deep sleep. Nothing was due. No wake is scheduled while it sleeps this deeply.');
    expect(reportWords({ state: 'active', heldBy: null, idleMs: 0, jobs: [{ name: 'agent-run-retention', changed: 0, failed: 'db' }, { name: 'run-stale-sweep', changed: 0, failed: null }], nextWakeMs: 60_000 }))
      .toBe('The server is in use. Old run records could not be removed; closed 0 runs whose runtime went away. Next wake in 1 min.');
  });

  it('shows where the imported-session backfill stands and starts or stops it through its own route', async () => {
    let progress = { scheduledTasksEnabled: true, backfillEnabled: false, runsPerDay: 24, intervalSeconds: 900, runIn: ['active', 'idle'], overlap: 'queue', enabled: false, remaining: 12, usedToday: 0, inFlight: 0, completedToday: 0, failedToday: 0 };
    const puts: unknown[] = [];
    const { requested } = server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/titling-backfill': (init) => {
        if (init?.method === 'PUT') {
          puts.push(JSON.parse(String(init.body)));
          progress = { ...progress, backfillEnabled: true, enabled: true, usedToday: 5, inFlight: 5 };
        }
        return Response.json(progress);
      },
    });
    mount('/operations');
    expect((await screen.findByText(/12 fully parsed imported sessions waiting for a first title attempt/)).textContent).toContain('The backfill is stopped.');
    fireEvent.click(await screen.findByRole('button', { name: 'Start backfill' }));
    expect((await screen.findByText(/Today: 5 of 24 started/)).textContent).toContain('Dispatches while the server is in use or idle, at most once every 15 min. Today: 5 of 24 started, 5 in flight, 0 titled, 0 failed.');
    expect(puts).toEqual([{ enabled: true }]);
    expect(await screen.findByRole('button', { name: 'Stop backfill' })).toBeTruthy();
    expect(requested).toContain('PUT /api/titling-backfill');
  });

  it('says when the backfill cannot be read and reads it again on request, and says when a switch was refused and retries it', async () => {
    let reads = 0;
    let puts = 0;
    const progress = { scheduledTasksEnabled: true, backfillEnabled: false, runsPerDay: 24, intervalSeconds: 900, runIn: ['active', 'idle'], overlap: 'queue', enabled: false, remaining: 3, usedToday: 0, inFlight: 0, completedToday: 0, failedToday: 0 };
    server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/titling-backfill': (init) => {
        if (init?.method === 'PUT') { puts++; return puts === 1 ? new Response(null, { status: 503 }) : Response.json({ ...progress, backfillEnabled: true, enabled: true }); }
        reads++;
        return reads === 1 ? new Response(null, { status: 503 }) : Response.json(progress);
      },
      '/api/maintenance': () => Response.json({ checks: [] }),
    });
    mount('/operations');
    expect(await screen.findByText(/could not report on the backfill/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText(/3 fully parsed imported sessions waiting/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start backfill' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('did not start the backfill');
    expect(screen.getByRole('button', { name: 'Start backfill' })).toBeTruthy();
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Stop backfill' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(puts).toBe(2);
  });

  it('words the backfill in every state, and its policy', () => {
    const base = { scheduledTasksEnabled: true, backfillEnabled: true, runsPerDay: 24, intervalSeconds: 900, runIn: ['active', 'idle'], overlap: 'queue' as const, enabled: true, remaining: 0, usedToday: 3, inFlight: 1, completedToday: 2, failedToday: 0 };
    expect(progressWords(base)).toBe('No fully parsed imported sessions are waiting for a first title attempt. Dispatches while the server is in use or idle, at most once every 15 min. Today: 3 of 24 started, 1 in flight, 2 titled, 0 failed.');
    expect(progressWords({ ...base, remaining: 1, runsPerDay: null, runIn: ['idle'], intervalSeconds: 60 })).toBe('1 fully parsed imported session waiting for a first title attempt. Dispatches while the server is idle, at most once every 1 min. Today: 3 started, 1 in flight, 2 titled, 0 failed.');
    expect(progressWords({ ...base, scheduledTasksEnabled: false, enabled: false })).toBe('No fully parsed imported sessions are waiting for a first title attempt. The backfill is on but runs only while scheduled intelligence is on; turn that on in Settings.');
    expect(progressWords({ ...base, backfillEnabled: false, enabled: false, remaining: 2 })).toBe('2 fully parsed imported sessions waiting for a first title attempt. The backfill is stopped.');
    expect(policyWords({ runIn: ['active', 'idle', 'sleep'], intervalSeconds: 3600 })).toBe('Dispatches while the server is in use, idle or asleep, at most once every 60 min.');
    expect(policyWords({ runIn: [], intervalSeconds: 10 })).toBe('Dispatches in no state, at most once every 1 min.');
  });
});

/**
 * What the Deployment's owner is told about automatic recovery.
 *
 * The words matter as much as the state here: a complete staging is not a backup an owner can restore from, and
 * the panel must never imply it is. These check the rendered page, and the wording functions directly.
 */
describe('automatic recovery on the Operations page', () => {
  const RECOVERY = (schedule: Record<string, unknown>) => ({
    attempt: schedule.latest === null ? null : 1, stage: 'idle', recoverable: false, schedule,
  });
  const base = { supported: true, configured: true, ready: true, intervalHours: 6, dueAt: null, due: false, latest: null, available: { state: 'none' }, idleBecause: null };

  it('tells an owner the cadence, the last attempt and what is available', async () => {
    const startedAt = Date.parse('2026-09-18T12:00:00.000Z');
    server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/backups': () => Response.json({ backups: [] }),
      '/api/recovery/exports': () => Response.json(RECOVERY({
        ...base,
        dueAt: Date.now() + 3 * 60 * 60 * 1000,
        latest: { attempt: 7, stage: 'complete', startedAt, failure: null },
        available: { state: 'staged', attempt: 7, prefix: 'staging/7', needs: 'an operator materializes this staging into a verified recovery artifact; a staging alone is not one' },
      })),
    });
    mount('/operations');

    expect((await screen.findByTestId('recovery-cadence')).textContent).toContain('Every 6 h');
    expect(screen.getByTestId('recovery-cadence').textContent).toContain('Next due in 3 h');
    expect(screen.getByTestId('recovery-latest').textContent).toContain('Attempt 7');
    const available = screen.getByTestId('recovery-available').textContent ?? '';
    expect(available).toContain('complete staging');
    // The claim this panel must never make.
    expect(available).toContain('not a recovery artifact yet');
    expect(available).not.toContain('recoverable');
  });

  it('says automatic recovery is off, and unavailable where no producer runs', async () => {
    server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/backups': () => Response.json({ backups: [] }),
      '/api/recovery/exports': () => Response.json(RECOVERY({ ...base, configured: false, intervalHours: null, idleBecause: 'automatic recovery is off: set "Back up every" to schedule it' })),
    });
    mount('/operations');
    expect((await screen.findByTestId('recovery-cadence')).textContent).toContain('Automatic recovery is off');
    cleanup();

    server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/backups': () => Response.json({ backups: [] }),
      '/api/recovery/exports': () => Response.json({ error: 'bad_request', reason: 'this Deployment runs no hosted recovery producer' }, { status: 400 }),
    });
    mount('/operations');
    expect((await screen.findByTestId('recovery-unavailable')).textContent).toContain('no hosted recovery producer');
  });

  it('shows a failed attempt as failed, with the producer\'s own reason', async () => {
    server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/backups': () => Response.json({ backups: [] }),
      '/api/recovery/exports': () => Response.json(RECOVERY({
        ...base, due: true, dueAt: Date.now(),
        latest: { attempt: 3, stage: 'failed', startedAt: Date.parse('2026-09-18T09:00:00.000Z'), failure: 'provider_refused' },
        available: { state: 'none' },
      })),
    });
    mount('/operations');
    expect((await screen.findByTestId('recovery-latest')).textContent).toContain('failed: provider refused');
    expect(screen.getByTestId('recovery-cadence').textContent).toContain('Due now');
    expect(screen.getByTestId('recovery-available').textContent).toContain('No recovery data exists yet');
  });

  it('tells an owner a read failed, rather than calling the Deployment unsupported', async () => {
    // A 503 says nothing about whether a producer exists. Claiming it does would tell an owner their backups are
    // impossible whenever the server was busy.
    server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/backups': () => Response.json({ backups: [] }),
      '/api/recovery/exports': () => Response.json({ error: 'unavailable', message: 'the Deployment did not answer' }, { status: 503 }),
    });
    mount('/operations');
    const said = (await screen.findByTestId('recovery-unreadable')).textContent ?? '';
    expect(said).toContain('could not be read');
    expect(screen.queryByTestId('recovery-unavailable')).toBeNull();
  });

  it('shows an unreadable schedule beside the attempt the producer did answer', async () => {
    server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/backups': () => Response.json({ backups: [] }),
      '/api/recovery/exports': () => Response.json({
        attempt: 7, stage: 'export', recoverable: false,
        schedule: { unreadable: 'whether automatic recovery is configured could not be read; a running export pauses its database' },
      }),
    });
    mount('/operations');
    expect((await screen.findByTestId('recovery-unreadable')).textContent).toContain('could not be read');
    // The producer answered; only the cadence is unavailable.
    expect(screen.getByTestId('recovery-latest').textContent).toContain('Attempt 7 is export');
    expect(screen.queryByTestId('recovery-cadence')).toBeNull();
  });

  it('says a configured schedule cannot run yet when this Deployment cannot admit one', async () => {
    server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/backups': () => Response.json({ backups: [] }),
      '/api/recovery/exports': () => Response.json(RECOVERY({
        ...base, intervalHours: 24, ready: false, due: false,
        idleBecause: 'automatic recovery cannot run: this Deployment carries no recovery configuration; update it so its deploy config renders one',
      })),
    });
    mount('/operations');
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
    expect(cadenceWords({ ...base, supported: false, configured: false } as never, Date.now())).toContain('cannot run here');
    expect(latestWords({ ...base, latest: null } as never)).toContain('No attempt has run yet');
  });

  it('shows a self-hosted Deployment its own artifact, and the operator step that target actually has', async () => {
    const startedAt = Date.parse('2026-09-18T12:00:00.000Z');
    const at = '/home/.myco/server/local-recovery/dep_1/1789750654766';
    server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/backups': () => Response.json({ backups: [] }),
      '/api/recovery/exports': () => Response.json({
        attempt: 1789750654766, stage: 'complete', form: 'artifact', recoverable: false,
        schedule: {
          ...base, intervalHours: 24, dueAt: startedAt + 86_400_000,
          latest: { attempt: 1789750654766, stage: 'complete', startedAt, failure: null },
          available: { state: 'artifact', attempt: 1789750654766, at, needs: 'restoring it also needs the wrapping key for its stored credentials, which is kept outside the artifact' },
        },
      }),
    });
    mount('/operations');
    const available = (await screen.findByTestId('recovery-available')).textContent ?? '';
    expect(available).toContain('verified recovery artifact');
    expect(available).toContain(at);
    expect(available).toContain('wrapping key');
    expect(available).not.toContain('materializ');
    const latest = (await screen.findByTestId('recovery-latest')).textContent ?? '';
    expect(latest).toContain('The last attempt');
    expect(latest).not.toContain('1789750654766');
  });

  /**
   * A Deployment that writes verified artifacts rather than stagings is described in its own words. The staging
   * sentence would be untrue of it, and its own sentence would be untrue of a staging.
   */
  it('calls a complete artifact what it is, names where it is, and says what a restore still needs', () => {
    const words = availableWords({
      state: 'artifact', attempt: 1789750654766, at: '/home/.myco/server/local-recovery/dep_1/1789750654766',
      needs: 'restoring it also needs the wrapping key for its stored credentials, which is kept outside the artifact',
    });
    expect(words).toContain('verified recovery artifact');
    expect(words).toContain('/home/.myco/server/local-recovery/dep_1/1789750654766');
    expect(words).toContain('wrapping key');
    // Not a staging, and never described as one.
    expect(words).not.toContain('materializ');
    expect(words).not.toContain('staging');
  });

  it('names an artifact attempt by when it started, not by an instant read as a number', () => {
    const latest = { attempt: 1789750654766, stage: 'complete', startedAt: 1789750654766, failure: null };
    const artifact = latestWords({ ...base, latest } as never, 'artifact');
    expect(artifact).toContain('The last attempt');
    expect(artifact).toContain('wrote a complete artifact');
    expect(artifact).not.toContain('1789750654766');
    // A producer whose attempts are numbered still names the number.
    expect(latestWords({ ...base, latest: { ...latest, attempt: 7 } } as never)).toContain('Attempt 7');
    expect(latestWords({ ...base, latest: { ...latest, attempt: 7 } } as never)).toContain('staged everything it named');
  });
});

describe('store maintenance on the Operations page', () => {
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
          runId: 'r1', trigger: 'schedule', state: 'findings', startedAt: 0, finishedAt: 1, errorClass: null,
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
    server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/maintenance': () => Response.json(hostedStatus),
    });
    mount('/operations');
    const integrity = await screen.findByTestId('maintenance-integrity');
    expect(within(integrity).getByText('foreign key: smoke_child row 1 names a missing smoke_parent')).toBeTruthy();
    expect(within(integrity).getByText('…and 2 more not kept')).toBeTruthy();
    expect(within(integrity).getByText('Unavailable — reported only by account analytics')).toBeTruthy();
    expect(within(integrity).getByText('2.0 MB')).toBeTruthy();
    const optimize = screen.getByTestId('maintenance-optimize');
    expect(within(optimize).getByText('Never run.')).toBeTruthy();
    expect(within(optimize).getByText(/Automatic runs are not set up/)).toBeTruthy();
  });

  it('runs a check on the button and shows a refusal in the server\'s words', async () => {
    const { requested } = server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/maintenance': () => Response.json(hostedStatus),
      '/api/maintenance/optimize/run': () => Response.json({ error: 'refused', refusal: 'already_running', reason: 'an optimize run is already in progress' }, { status: 409 }),
    });
    mount('/operations');
    const optimize = await screen.findByTestId('maintenance-optimize');
    fireEvent.click(within(optimize).getByRole('button', { name: 'Run now' }));
    expect(await within(optimize).findByRole('alert')).toBeTruthy();
    expect(within(optimize).getByRole('alert').textContent).toBe('an optimize run is already in progress');
    expect(requested).toContain('POST /api/maintenance/optimize/run');
  });

  it('words a running record the server no longer runs as interrupted and offers a run, and a live one as running', async () => {
    const runningRecord = {
      runId: 'r2', trigger: 'schedule', state: 'running', startedAt: 0, finishedAt: null, errorClass: null,
      findings: [], findingsOmitted: 0, measurements: [],
    };
    const supported = { supported: true, label: 'Checks every table, index and page' };
    server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/maintenance': () => Response.json({
        checks: [
          { check: 'integrity', support: supported, cadence: { state: 'off' }, dueAt: null, running: false, latest: runningRecord },
          { check: 'optimize', support: supported, cadence: { state: 'off' }, dueAt: null, running: true, latest: { ...runningRecord, runId: 'r3' } },
        ],
      }),
    });
    mount('/operations');
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
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/maintenance': () => Response.json({
        checks: [{ check: 'integrity', support: supported, cadence: { state: 'off' }, dueAt: null, running, latest: running ? claim : null }],
      }),
      '/api/maintenance/integrity/run': () => { running = true; return Response.json(claim); },
    });
    mount('/operations');
    const integrity = await screen.findByTestId('maintenance-integrity');
    expect(within(integrity).getByTestId('maintenance-integrity-outcome').textContent).toBe('Never run.');
    fireEvent.click(within(integrity).getByRole('button', { name: 'Run now' }));
    expect(await within(integrity).findByText(/^Running since /)).toBeTruthy();
    expect(within(integrity).getByRole('button', { name: 'Running…' }).hasAttribute('disabled')).toBe(true);
    expect(within(integrity).queryByRole('alert')).toBeNull();
    expect(requested.filter((r) => r === 'GET /api/maintenance').length).toBeGreaterThanOrEqual(2);
  });

  it('offers no run for a check this server cannot perform', async () => {
    server({
      '/auth/me': () => Response.json(ME),
      '/api/projects': () => Response.json(PROJECTS),
      '/api/maintenance': () => Response.json({ checks: [{ check: 'integrity', support: { supported: false, reason: 'this Deployment has no store maintenance' }, cadence: { state: 'off' }, dueAt: null, running: false, latest: null }] }),
    });
    mount('/operations');
    const integrity = await screen.findByTestId('maintenance-integrity');
    expect(within(integrity).getByText('Not available on this server: this Deployment has no store maintenance.')).toBeTruthy();
    expect(within(integrity).queryByRole('button')).toBeNull();
  });
});
