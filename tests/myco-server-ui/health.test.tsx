/**
 * Health as one page: its parts in order at their anchors, the addresses it
 * replaced leading to the right part with their query kept, what needs an
 * admin, the search index's upkeep, workers named by their machine, a restore
 * that asks before it adds a foreign Deployment's members, and no raw id
 * anywhere a reader sees.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../../packages/myco-server/ui/src/App';
import { AppearanceProvider } from '../../packages/myco-server/ui/src/providers/appearance';
import { rawIdsIn } from '../helpers/raw-ids';

const NOW = Date.now();
const ADMIN = { sub: '583231', login: 'octocat', member: { id: 'mem_q3Vb8xRk2LmT7wYz', label: 'Ada', role: 'admin' as const } };
const MEMBER = { sub: '770001', login: 'lin', member: { id: 'mem_Hn5-pC0dJfA9sE_u', label: 'mem_Hn5-pC0dJfA9sE_u', role: 'member' as const } };
const MYCO = 'proj_6d79636f3a3e1c0b8a2f4e7d9c150a11';
const ATLAS = 'proj_a71a5c0e2b9d4f8e6c3a1b7d5e9f0c22';
const PROJECTS = { projects: [
  { projectId: MYCO, name: 'Myco', createdAt: 0, sessionCount: 12, lastActivityAt: NOW - 60_000, archivedAt: null, archivedBy: null },
  { projectId: ATLAS, name: 'Atlas web', createdAt: 0, sessionCount: 3, lastActivityAt: NOW - 86_400_000, archivedAt: NOW - 3_600_000, archivedBy: 'mem_q3Vb8xRk2LmT7wYz' },
] };

const STUDIO_CREDENTIAL = 'mt_4Kp9Qs2Vx7Lm0Zb1';
const BUSY_CREDENTIAL = 'mt_Ws8Yt3Nq6Rc2Hd5E';
const STRAY_CREDENTIAL = 'mt_Pz1Ga7Ue4Oi9Kj3F';
const STATUS = {
  schema: { expected: 57, found: 57, matches: true }, target: 'bun',
  capabilities: [{ capability: 'blobs', label: 'Stored attachments and transcripts', present: true, operatorNames: ['MYCO_BLOBS'] }],
  workers: {
    available: true, workersBusy: 1, runsQueued: 2, recentWithinMs: 90_000,
    fleet: [
      { credentialId: STUDIO_CREDENTIAL, machineId: 'ada_5a2d54af', offers: [{ id: 'claude-code', authenticated: true }], capabilities: [], lastReason: 'no_work', lastSeenAt: NOW - 3_000, busy: null, eligible: true, recent: true },
      { credentialId: BUSY_CREDENTIAL, machineId: 'lin_9e8f7a6b', offers: [{ id: 'codex', authenticated: true }], capabilities: [], lastReason: 'claimed', lastSeenAt: NOW - 1_000, busy: { runId: 'run_4f1c9a2e7b', projectId: MYCO, task: 'extract-curate', leaseExpiresAt: NOW + 60_000 }, eligible: true, recent: true },
      { credentialId: STRAY_CREDENTIAL, machineId: null, offers: null, capabilities: null, lastReason: null, lastSeenAt: NOW - 3 * 86_400_000, busy: null, eligible: true, recent: false },
    ],
  },
  transcriptBacklog: { transcripts: 3, bytes: 4096, imported: { transcripts: 3, bytes: 4096 } },
  projects: [
    { projectId: MYCO, lastActivityAt: NOW - 60_000, sessionCount: 12, archivedAt: null },
    { projectId: ATLAS, lastActivityAt: NOW - 86_400_000, sessionCount: 3, archivedAt: NOW - 3_600_000 },
  ],
  capture: [],
};
const credential = (id: string, machineId: string, runtimeLabel: string | null, memberId = ADMIN.member.id) => ({
  id, memberId, machineId, runtimeLabel, expiresAt: NOW + 86_400_000, revokedAt: null, revokedBy: null, bytesWritten: 0,
  lineageRoot: id, lineageStartedAt: NOW - 86_400_000, firstUsedAt: null, live: true, purpose: 'member',
});
const BACKUP = { id: 'bk_7f3a9c0e21', key: 'backups/1.sqlite', created_at: NOW - 28 * 86_400_000, size_bytes: 48_213_504, counts_json: '{}', schema_version: 57, producer: 'mem_q3Vb8xRk2LmT7wYz', pinned: 0, present: true };

type Route = (init?: RequestInit) => Response;

const routes = (over: Record<string, Route> = {}): Record<string, Route> => ({
  '/auth/me': () => Response.json(ADMIN),
  '/api/projects': () => Response.json(PROJECTS),
  '/api/status': () => Response.json(STATUS),
  '/api/attention': () => Response.json({ items: [{ kind: 'backup_overdue', tone: 'warn', lastBackupAt: BACKUP.created_at, intervalHours: 24 }], unavailable: [] }),
  '/api/credentials': () => Response.json({ rows: [credential(STUDIO_CREDENTIAL, 'ada_5a2d54af', 'Ada’s studio Mac'), credential(BUSY_CREDENTIAL, 'lin_9e8f7a6b', 'Lin’s build box', 'mem_Hn5-pC0dJfA9sE_u')], cursor: null }),
  '/api/backups': () => Response.json({ backups: [BACKUP] }),
  '/api/recovery/exports': () => Response.json({ supported: false, reason: 'this Deployment runs no hosted recovery producer', schedule: { unreadable: 'not read' } }),
  '/api/work': () => Response.json({ window: { since: 0, until: 0 }, outcomes: [], runs: [], truncated: false, upkeep: { task: 'embedding-reconcile', lastSuccessAt: NOW - 3_600_000, failedInWindow: 2, unrecovered: null } }),
  '/api/maintenance': () => Response.json({ checks: [] }),
  '/api/kpis': () => Response.json({
    windowDays: 30, since: 0, contextPresent: { value: 0.5, sampleSize: 4 }, sporeServeRate: { value: null, sampleSize: 0 }, callsPerPrompt: { value: null, sampleSize: 0 },
    callsPerPromptByHarness: [], planReadsPerSession: { value: null, sampleSize: 0 }, firstInjectionMs: { value: null, sampleSize: 0 }, recallQuality: { value: null, sampleSize: 0 },
  }),
  ...over,
});

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

function server(table: Record<string, Route>): { asked: string[]; posts: Array<{ path: string; body: unknown }> } {
  const asked: string[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href, 'https://s');
    asked.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    if (init?.method === 'POST') posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return table[url.pathname]?.(init) ?? new Response(null, { status: 404 });
  }) as typeof fetch;
  return { asked, posts };
}

let seen = { pathname: '', search: '', hash: '' };
function Where() {
  const location = useLocation();
  seen = { pathname: location.pathname, search: location.search, hash: location.hash };
  return null;
}

function mount(path = '/status/health') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<AppearanceProvider><QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><App /><Where /></MemoryRouter></QueryClientProvider></AppearanceProvider>);
}

async function openMenu(name: string | RegExp, scope: HTMLElement = document.body) {
  fireEvent.keyDown(await within(scope).findByRole('button', { name }), { key: 'Enter' });
  return screen.findByRole('menu');
}

const PARTS = [['needs-you', 'Needs you'], ['status', 'Status'], ['workers', 'Workers'], ['backups', 'Backups'], ['upkeep', 'Upkeep'], ['measures', 'Measures']] as const;

describe('Health', () => {
  it('lists its parts in order, each at its anchor, with a jump to each', async () => {
    server(routes());
    mount();
    expect(await screen.findByRole('heading', { level: 1, name: 'Health' })).toBeTruthy();
    const page = document.querySelector('[data-admin-page="health"]')!;
    const sections = [...page.querySelectorAll(':scope > section')].map((s) => s.id);
    expect(sections).toEqual(PARTS.map(([id]) => id));
    for (const [id, name] of PARTS) expect(screen.getByRole('region', { name }).id).toBe(id);
    const jumps = within(screen.getByRole('navigation', { name: 'Parts of Health' })).getAllByRole('link');
    expect(jumps.map((a) => [a.getAttribute('href'), a.textContent])).toEqual(PARTS.map(([id, name]) => [`/status/health#${id}`, name]));
  });

  it('asks for its own reads at once, without waiting on the projects list', async () => {
    // The projects list never answers. Health's reads start beside it, so the page never waits a round trip on it.
    const { asked } = server(routes({ '/api/projects': () => new Promise<Response>(() => undefined) as unknown as Response }));
    mount();
    expect(await screen.findByRole('heading', { level: 1, name: 'Health' })).toBeTruthy();
    await waitFor(() => {
      const missing = ['/api/status', '/api/attention', '/api/backups', '/api/maintenance', '/api/kpis', '/api/recovery/exports']
        .filter((path) => !asked.some((line) => line === `GET ${path}` || line.startsWith(`GET ${path}?`)));
      expect(missing).toEqual([]);
    });
  });

  it('leads each address it replaced to its part, the query kept', async () => {
    server(routes());
    mount('/status');
    await waitFor(() => expect(seen).toEqual({ pathname: '/status/health', search: '', hash: '#status' }));
    cleanup();
    const again = server(routes());
    mount('/measures?window=7');
    await waitFor(() => expect(seen).toEqual({ pathname: '/status/health', search: '?window=7', hash: '#measures' }));
    await waitFor(() => expect(again.asked).toContain('GET /api/kpis?window=7'));
    cleanup();
    server(routes());
    mount('/operations');
    await waitFor(() => expect(seen).toEqual({ pathname: '/status/health', search: '', hash: '#upkeep' }));
  });

  it('shows what needs an admin, with its count beside Health in the nav', async () => {
    server(routes());
    mount();
    const needsYou = await screen.findByRole('region', { name: 'Needs you' });
    expect(await within(needsYou).findByText(/^Last backup was /)).toBeTruthy();
    expect(within(needsYou).getByRole('link', { name: /Open backups/ }).getAttribute('href')).toBe('/status/health#backups');
    const admin = screen.getByRole('navigation', { name: 'Admin' });
    expect(await within(admin).findByRole('link', { name: 'Health, 1 thing needs you' })).toBeTruthy();
  });

  it('says what the server holds and received, by project name, with the transcripts still waiting', async () => {
    server(routes());
    mount();
    const status = await screen.findByRole('region', { name: 'Status' });
    expect(await within(status).findByText('The database is at the version this server expects (57).')).toBeTruthy();
    expect(within(status).getByText('Stored attachments and transcripts')).toBeTruthy();
    expect(status.textContent).not.toContain('MYCO_BLOBS');
    const received = within(status).getByRole('group', { name: 'What each project last sent' });
    expect([...received.querySelectorAll('[data-health-project]')].map((row) => row.textContent)).toEqual([
      expect.stringContaining('Myco'),
      expect.stringMatching(/Atlas web.*Archived.*3 sessions/),
    ]);
    expect(within(status).getByTestId('transcript-backlog').textContent).toBe('3 transcripts (4.0 KB) waiting to be read into sessions.');
  });

  it('shows the search index’s upkeep over the last day in one line', async () => {
    const { asked } = server(routes());
    mount();
    const upkeep = await screen.findByRole('region', { name: 'Upkeep' });
    expect((await within(upkeep).findByText(/Search kept up to date/)).textContent).toBe('Search kept up to date · 1 h ago · 2 retries along the way');
    const work = asked.find((line) => line.startsWith('GET /api/work'))!;
    const params = new URL(work.slice(4), 'https://s').searchParams;
    expect(params.has('project')).toBe(false);
    expect(Number(params.get('until')) - Number(params.get('since'))).toBeGreaterThanOrEqual(24 * 3_600_000);
  });

  it('names each worker by its machine, never by an id, and says what it runs where', async () => {
    server(routes());
    mount();
    const workers = await screen.findByRole('region', { name: 'Workers' });
    const rows = await waitFor(() => {
      const found = [...workers.querySelectorAll('[data-health-worker]')].map((row) => row.textContent ?? '');
      expect(found[0]).toContain('Ada’s studio Mac');
      return found;
    });
    expect(rows[0]).toMatch(/^Ada’s studio Mac · Waiting for work · last checked in \d+s ago/);
    expect(rows[0]).toContain('Reports Claude Code signed in');
    expect(rows[0]).toContain('Last check for work: nothing it could take.');
    expect(rows[1]).toMatch(/^Lin’s build box · Running learning in Myco · due to check in within /);
    expect(rows[2]).toMatch(/^A machine · Not checking in now/);
    expect(within(workers).getByText(/^2 machines are running Myco’s work, 1 busy now\. 2 tasks are waiting\.$/)).toBeTruthy();
    for (const id of [STUDIO_CREDENTIAL, BUSY_CREDENTIAL, STRAY_CREDENTIAL, 'ada_5a2d54af', MYCO]) expect(workers.textContent).not.toContain(id);
  });

  it('says worker status is unknown when the server could not read it, never that there are none', async () => {
    server(routes({ '/api/status': () => Response.json({ ...STATUS, workers: { available: false, workersBusy: 0, runsQueued: 0, recentWithinMs: 90_000, fleet: [] } }) }));
    mount();
    const workers = await screen.findByRole('region', { name: 'Workers' });
    expect(await within(workers).findByText(/Whether machines are running Myco’s work is unknown/)).toBeTruthy();
    expect(workers.textContent).not.toContain('No machine is running');
  });

  it('shows the command that attaches a machine when none is running Myco’s work', async () => {
    server(routes({ '/api/status': () => Response.json({ ...STATUS, workers: { available: true, workersBusy: 0, runsQueued: 0, recentWithinMs: 90_000, fleet: [] } }) }));
    mount();
    const workers = await screen.findByRole('region', { name: 'Workers' });
    expect(await within(workers).findByText('myco worker install')).toBeTruthy();
    expect(workers.textContent).toContain('No machine is running Myco’s work.');
  });

  it('restores a backup only through its confirm, and one from another Deployment only once the switch is on', async () => {
    const { posts } = server(routes({
      '/api/backups/bk_7f3a9c0e21/restore-preview': () => Response.json({ header: { deploymentId: 'dep_other', schemaVersion: 57, createdAt: BACKUP.created_at, producer: 'x', counts: { sessions: 4, spores: 12, members: 0 } }, foreignLineage: true }),
      '/api/backups/bk_7f3a9c0e21/restore': () => Response.json({ applied: true, tables: { sessions: { rows: 4, inserted: 4 }, spores: { rows: 12, inserted: 1, skipped: 'newer rows are kept' } } }),
    }));
    mount();
    const list = await screen.findByRole('group', { name: 'Backups' });
    fireEvent.click(within(await openMenu(/^More for the backup of /, list)).getByRole('menuitem', { name: 'Restore…' }));
    const dialog = await screen.findByRole('dialog', { name: /^Restore the backup from / });
    expect(dialog.textContent).toContain('It holds sessions 4 · spores 12');
    expect(dialog.textContent).toContain('comes from another server');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('Turn on the switch');
    expect(posts.map((p) => p.path)).toEqual(['/api/backups/bk_7f3a9c0e21/restore-preview']);
    fireEvent.click(within(dialog).getByRole('switch'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(posts.at(-1)).toEqual({ path: '/api/backups/bk_7f3a9c0e21/restore', body: { allowForeignLineage: true } }));
    expect((await screen.findByText(/^Restored: /)).textContent).toBe('Restored: 5 records added.');
    expect(screen.getByText('spores: newer rows are kept')).toBeTruthy();
  });

  it('cancels a restore with nothing sent past the preview', async () => {
    const { posts } = server(routes({
      '/api/backups/bk_7f3a9c0e21/restore-preview': () => Response.json({ header: { deploymentId: 'dep_1', schemaVersion: 57, createdAt: BACKUP.created_at, producer: 'x', counts: { sessions: 4 } }, foreignLineage: false }),
    }));
    mount();
    const list = await screen.findByRole('group', { name: 'Backups' });
    fireEvent.click(within(await openMenu(/^More for the backup of /, list)).getByRole('menuitem', { name: 'Restore…' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('switch')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(posts.map((p) => p.path)).toEqual(['/api/backups/bk_7f3a9c0e21/restore-preview']);
  });

  it('shows no raw id anywhere a reader sees', async () => {
    server(routes());
    mount();
    const workers = await screen.findByRole('region', { name: 'Workers' });
    await waitFor(() => expect(workers.textContent).toContain('Ada’s studio Mac'));
    await screen.findByText(/Search kept up to date/);
    await screen.findByText(/^Last backup was /);
    await screen.findAllByTestId('measure-tile');
    expect(rawIdsIn(document.body)).toEqual([]);
    expect(document.body.textContent).not.toContain('bk_7f3a9c0e21');
  });

  it('shows a member who is not an admin that the page is an admin’s, and asks none of its reads', async () => {
    const { asked } = server(routes({ '/auth/me': () => Response.json(MEMBER) }));
    mount();
    expect(await screen.findByTestId('admin-only')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const path of ['/api/attention', '/api/backups', '/api/maintenance', '/api/recovery/exports', '/api/kpis']) {
      expect(asked.some((line) => line.includes(path))).toBe(false);
    }
  });
});

it('describes coded store diagnostics without quoting support, measurements, cadence or findings', async () => {
  const prose = 'server prose must stay off the page';
  server(routes({ '/api/maintenance': () => Response.json({ checks: [
    { check: 'optimize', support: { supported: false, reasonCode: 'check_unsupported', reason: prose }, cadence: { state: 'off' }, running: false, latest: null },
    { check: 'integrity', support: { supported: true, label: 'Checks stored records' }, cadence: { state: 'invalid', leaf: 'maintenance.auto_integrity_check', reason: prose }, running: false,
      latest: { runId: 'check1', trigger: 'owner', state: 'findings', startedAt: NOW, finishedAt: NOW, errorClass: null,
        findings: [prose], findingCodes: ['store_problem'], findingsOmitted: 0,
        measurements: [{ name: 'size', state: 'unavailable', reasonCode: 'measurement_unavailable', reason: prose }] } },
  ] }) }));
  mount();
  const upkeep = await screen.findByTestId('maintenance');
  await waitFor(() => expect(upkeep.textContent).toContain('The store check found a problem.'));
  expect(upkeep.textContent).toContain('Not available on this server.');
  expect(upkeep.textContent).toContain('Unavailable');
  expect(upkeep.textContent).toContain('Automatic runs are not scheduled: the saved setting is invalid.');
  expect(document.body.textContent).not.toContain(prose);
});

for (const [code, configured, ready, expected] of [
  ['backup_unsupported', false, false, 'Automatic recovery doesn’t run on this server.'],
  ['backup_off', false, true, 'Automatic recovery is off.'],
  ['backup_not_ready', true, false, 'It can’t run yet: this server is missing something it needs.'],
  ['backup_in_progress', true, true, 'The next one waits for the attempt or backup in progress to end.'],
  ['manual_backup_in_progress', true, true, 'The next one waits for the attempt or backup in progress to end.'],
] as const) {
  it(`describes ${code} without quoting the recovery reason`, async () => {
    const prose = 'server prose must stay off the page';
    server(routes({ '/api/recovery/exports': () => Response.json({ supported: code !== 'backup_unsupported',
      attempt: null, stage: 'idle', form: 'staging', error: null,
      schedule: { supported: code !== 'backup_unsupported', configured, ready, intervalHours: 24, dueAt: null, due: false,
        latest: null, available: { state: 'none' }, idleCode: code, idleBecause: prose },
    }) }));
    mount();
    await waitFor(() => expect(document.body.textContent).toContain(expected));
    expect(document.body.textContent).not.toContain(prose);
  });
}
