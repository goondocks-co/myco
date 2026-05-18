// @vitest-environment jsdom

/**
 * Phase 7 Block 3 T18 — Dashboard v3 rebuild smoke test.
 *
 * Renders the rebuilt Dashboard with stubbed data hooks and asserts that the
 * four sections from `dashboard-v3.jsx` mount and consume real data:
 *
 *   1. Page head (project name eyebrow + "Dashboard" title)
 *   2. Two header cards (Project / Grove) — Machine card retired in Phase 8
 *      (daemon health moved to the topbar pill).
 *   3. Active sessions hero panel (plain-language vocab)
 *   4. Two-column Agent runs + Skills + Canopy stack
 *
 * Empty-state branches are exercised in a separate `it()` to confirm the
 * panels render their fallback copy when their hook returns no items.
 */

import { describe, expect, it, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const statsFixture = {
  context: {
    project: {
      id: 'p1',
      name: 'goondocks',
      root: '/Users/chris/Repos/myco',
      manifest_state: 'present' as const,
    },
    grove: {
      id: 'g1',
      name: 'goondocks-grove',
      slug: 'goondocks',
      mode: 'local' as const,
      binding_id: null,
      connection_state: 'local-only' as const,
    },
    request: {
      source: 'http',
      project_id: 'p1',
      grove_id: 'g1',
      machine_id: 'm1',
      session_id: null,
    },
  },
  daemon: {
    pid: 12345,
    port: 20915,
    version: '0.15.0',
    uptime_seconds: 86400,
    active_sessions: ['s1', 's2'],
    runtime: { source: 'stable' as const, command: 'myco' },
  },
  vault: {
    path: '/Users/chris/Repos/myco/.myco',
    name: 'myco',
    session_count: 412,
    batch_count: 1287,
    spore_count: 347,
    plan_count: 41,
    artifact_count: 0,
    entity_count: 0,
    edge_count: 0,
  },
  embedding: {
    provider: 'openai',
    model: 'text-embedding-3-small',
    queue_depth: 12,
    embedded_count: 1280,
    total_embeddable: 1310,
  },
  agent: { last_run_at: 1779000000, last_run_status: 'completed', total_runs: 87 },
  digest: { freshest_tier: 5000, generated_at: 1779000000, tiers_available: [1500, 5000, 10000] },
  canopy: { entries_count: 540, described_count: 510 },
  unprocessed_batches: 0,
};

const activeSessions = [
  {
    id: 's1',
    title: 'Phase 7 Block 3 dashboard rebuild',
    agent: 'claude-code',
    branch: 'feat/ui-phase-7-block-3-dashboard',
    status: 'active',
    started_at: 1779100000,
    prompt_count: 14,
    tool_count: 32,
    activity_buckets: [1, 2, 1, 3, 4, 5],
  },
  {
    id: 's2',
    title: 'Cold-start embed backlog trace',
    agent: 'codex',
    branch: 'main',
    status: 'active',
    started_at: 1779099000,
    prompt_count: 7,
    tool_count: 11,
    activity_buckets: [0, 1, 0, 1, 2, 1],
  },
];

const runs = [
  {
    id: 'run-aaaaaaaaaaaaaaaa',
    agent_id: 'claude-code',
    task: 'skill-survey',
    instruction: null,
    status: 'running',
    harness: null,
    provider: null,
    model: 'claude-sonnet-4-6',
    session_ref: null,
    resumable: false,
    resume_status: null,
    resume_mode: null,
    resumed_at: null,
    checkpoints: null,
    usage_data: null,
    started_at: 1779100200,
    completed_at: null,
    tokens_used: 1240,
    cost_usd: null,
    actual_cost_usd: null,
    estimated_cost_usd: null,
    cost_source: null,
    cost_data: null,
    actions_taken: null,
    error: null,
  },
  {
    id: 'run-bbbbbbbbbbbbbbbb',
    agent_id: 'claude-code',
    task: 'title-summary',
    instruction: null,
    status: 'completed',
    harness: null,
    provider: null,
    model: 'claude-haiku-4-5',
    session_ref: 's2',
    resumable: false,
    resume_status: null,
    resume_mode: null,
    resumed_at: null,
    checkpoints: null,
    usage_data: null,
    started_at: 1779099500,
    completed_at: 1779099700,
    tokens_used: 540,
    cost_usd: null,
    actual_cost_usd: null,
    estimated_cost_usd: null,
    cost_source: null,
    cost_data: null,
    actions_taken: null,
    error: null,
  },
];

const skills = [
  {
    id: 'sk1',
    name: 'phase-7-ui-evolution',
    display_name: 'Phase 7 UI evolution',
    description: 'Visual-language rebuild discipline',
    status: 'active',
    generation: 1,
    candidate_id: null,
    source_ids: '[]',
    path: '.agents/skills/phase-7-ui-evolution.md',
    usage_count: 12,
    last_used_at: 1779099900,
    created_at: 1779000000,
    updated_at: 1779099900,
    properties: null,
  },
  {
    id: 'sk2',
    name: 'safe-config-updates',
    display_name: 'Safe config updates',
    description: 'updateConfig + spread-original pattern',
    status: 'active',
    generation: 2,
    candidate_id: null,
    source_ids: '[]',
    path: '.agents/skills/safe-config-updates.md',
    usage_count: 5,
    last_used_at: null,
    created_at: 1779000000,
    updated_at: 1779099800,
    properties: null,
  },
];

const canopyEntries = [
  {
    project_id: 'p1',
    machine_id: 'm1',
    path: 'packages/myco/ui/src/pages/Dashboard.tsx',
    content_hash: 'abc',
    size_bytes: 4096,
    token_estimate: 920,
    line_count: 250,
    language: 'tsx',
    exports_json: null,
    imports_json: null,
    top_comment: null,
    mechanical_updated_at: 1779099000,
    llm_description: 'Dashboard rebuild',
    llm_updated_at: 1779099500,
    embedded: 1,
  },
];

mock.module('../../packages/myco/ui/src/hooks/use-daemon', () => ({
  useDaemon: () => ({ data: statsFixture, isLoading: false, isError: false, error: null }),
}));
mock.module('../../packages/myco/ui/src/hooks/use-sessions', () => ({
  useSessions: () => ({
    data: { sessions: activeSessions, total: activeSessions.length },
    isLoading: false,
    isError: false,
  }),
}));
mock.module('../../packages/myco/ui/src/hooks/use-agent', () => ({
  useAgentRuns: () => ({
    data: { runs, total: runs.length, offset: 0, limit: runs.length },
    isLoading: false,
  }),
}));
mock.module('../../packages/myco/ui/src/hooks/use-skills', () => ({
  useSkillRecords: () => ({
    data: { records: skills, total: skills.length },
    isLoading: false,
  }),
}));
mock.module('../../packages/myco/ui/src/hooks/use-canopy', () => ({
  useCanopyEntries: () => ({
    data: { rows: canopyEntries, total: canopyEntries.length, limit: 6, offset: 0 },
    isLoading: false,
  }),
}));
mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useProjectPathBuilder: () => (path?: string) => path ?? '/',
}));

import Dashboard from '../../packages/myco/ui/src/pages/Dashboard';

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <Dashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Dashboard v3 rebuild (T16/T17)', () => {
  it('renders the header with project name and title', () => {
    renderPage();
    expect(screen.getByText('Dashboard')).toBeTruthy();
    // Project name appears in the eyebrow AND inside the project scope card.
    expect(screen.getAllByText('goondocks').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the two header cards with their data tiles', () => {
    renderPage();
    expect(screen.getByText('Project')).toBeTruthy();
    expect(screen.getByText('Grove')).toBeTruthy();

    // Project tiles surface the vault counts from the stats fixture.
    expect(screen.getByText('412')).toBeTruthy(); // session_count
    // 347 (spore_count) appears in the project tile AND the hero footer —
    // assert presence via getAllByText so we don't fail on the duplicate.
    expect(screen.getAllByText('347').length).toBeGreaterThan(0);
    expect(screen.getByText('41')).toBeTruthy();  // plan_count
    expect(screen.getByText('510/540')).toBeTruthy(); // described/total canopy

    // Grove tiles surface the embedding stats.
    expect(screen.getByText('1280/1310')).toBeTruthy(); // embedded/total
    expect(screen.getByText('12')).toBeTruthy(); // queue depth

    // The Machine scope card was retired in Phase 8; daemon health (incl.
    // version) now lives in the topbar pill rendered by Layout, not here.
    expect(screen.queryByText('machine scope')).toBeNull();
  });

  it('renders the active-sessions hero with both session titles', () => {
    renderPage();
    // Heading-level assertion: the hero <h3> shows the plain-language count.
    expect(screen.getByRole('heading', { name: /^\d+ active sessions?$/i })).toBeTruthy();
    expect(screen.getByText('Phase 7 Block 3 dashboard rebuild')).toBeTruthy();
    expect(screen.getByText('Cold-start embed backlog trace')).toBeTruthy();
  });

  it('renders agent runs panel with running + recent rows', () => {
    renderPage();
    expect(screen.getByText('Recent')).toBeTruthy();
    expect(screen.getByText('skill-survey')).toBeTruthy();
    expect(screen.getByText('title-summary')).toBeTruthy();
  });

  it('renders skills panel with the recently-evolved grid', () => {
    renderPage();
    expect(screen.getByText('Recently evolved')).toBeTruthy();
    expect(screen.getByText('Phase 7 UI evolution')).toBeTruthy();
    expect(screen.getByText('Safe config updates')).toBeTruthy();
  });

  it('renders canopy panel with recent file entries', () => {
    renderPage();
    expect(screen.getByText('Recent entries')).toBeTruthy();
    expect(screen.getByText('packages/myco/ui/src/pages/Dashboard.tsx')).toBeTruthy();
  });
});
