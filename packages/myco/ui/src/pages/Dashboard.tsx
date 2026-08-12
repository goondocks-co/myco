import { Link, useNavigate } from 'react-router-dom';
import { Layout, Trees, ArrowRight, Sparkles, FileCode } from 'lucide-react';
import { CAPTURE_ONLY_BADGE } from '../lib/capability-badges';
import { capabilitiesPanelLink, capabilityEnabled, isCaptureOnly } from '@myco/config/capabilities';
import type { MycoConfig } from '@myco/config/schema';
import { useDaemon, type StatsResponse } from '../hooks/use-daemon';
import { useSessions, type SessionSummary } from '../hooks/use-sessions';
import { useAgentRuns, type RunRow } from '../hooks/use-agent';
import { useSkillRecords, type SkillRecord } from '../hooks/use-skills';
import { useCanopyEntries, type CanopyEntryRow } from '../hooks/use-canopy';
import { useScopedConfig } from '../hooks/use-scoped-config';
import { useProjectPathBuilder, useActiveProjectSelection } from '../hooks/use-project-selection';
import { PageLoading } from '../components/ui/page-loading';
import { PageContainer } from '../components/ui/page-container';
import { AccentSurface } from '../components/ui/accent-surface';
import { Panel } from '../components/ui/panel';
import { MetricCard } from '../components/ui/metric-card';
import { Eyebrow } from '../components/ui/eyebrow';
import { StatusDot, type StatusTone } from '../components/ui/status-dot';
import { Sparkline } from '../components/ui/sparkline';
import { formatEpochAgo, basename } from '../lib/format';
import { cn } from '../lib/cn';
import { agentRunSuffix, sessionSuffix } from '../lib/entity-routes';

// Daemon health renders in the topbar pill (DaemonStatusPill), not here.

const ACTIVE_SESSIONS_LIMIT = 6;
const RUNS_LIMIT = 6;
const SKILLS_LIMIT = 6;
const CANOPY_LIMIT = 6;

function runStatusTone(status: string): StatusTone {
  if (status === 'running') return 'sage';
  if (status === 'failed' || status === 'error') return 'terracotta';
  if (status === 'completed' || status === 'succeeded') return 'outline';
  return 'ochre';
}

export default function Dashboard() {
  const { data: stats, isLoading, isError, error } = useDaemon();
  const { data: activeSessionsData } = useSessions({ status: 'active', limit: ACTIVE_SESSIONS_LIMIT });
  // Most recent session (any status) for the capture-health signal.
  const { data: recentSessionData } = useSessions({ limit: 1 });
  const { data: runsData } = useAgentRuns({ limit: RUNS_LIMIT });
  const { data: skillsData } = useSkillRecords({ limit: SKILLS_LIMIT });
  const { data: canopyData } = useCanopyEntries({
    limit: CANOPY_LIMIT,
    sort_by: 'llm_updated_at',
    sort_dir: 'desc',
  });
  // Capability awareness for honest empty states. Two guards:
  //  - unresolved config reads as "everything off" (capabilityEnabled is
  //    fail-closed), so nothing capability-aware renders until it loads;
  //  - an attached (Team-Host-served) project's capabilities are
  //    host-authoritative — the locally-merged config would misreport, so
  //    the dashboard stays capability-silent for it (same rule as the
  //    Groves list, which omits the badge strip for attached rows).
  const { effective } = useScopedConfig();
  const selection = useActiveProjectSelection();
  const capabilityAware = !!effective && selection?.project.attached !== true;
  const config = effective as MycoConfig | undefined;
  const captureOnly = capabilityAware && !!config && isCaptureOnly(config);
  const skillsOff = capabilityAware && !!config && !capabilityEnabled(config, 'skills');
  const canopyOff = capabilityAware && !!config && !capabilityEnabled(config, 'canopy');
  const capabilitiesLink = capabilitiesPanelLink(selection?.project.project_id);

  return (
    <PageLoading
      isLoading={isLoading}
      error={isError ? (error instanceof Error ? error : new Error('Unable to reach daemon')) : null}
      loadingText="Connecting to daemon..."
    >
      {stats && (
        <PageContainer className="gap-8">
          <DashboardHead
            stats={stats}
            activeSessionCount={activeSessionsData?.total ?? 0}
            inFlightRunCount={(runsData?.runs ?? []).filter((r) => r.status === 'running').length}
            lastSession={recentSessionData?.sessions?.[0]}
            captureOnly={captureOnly}
            capabilitiesLink={capabilitiesLink}
          />
          <ScopeRow stats={stats} />
          <ActiveSessionsHero
            sessions={activeSessionsData?.sessions ?? []}
            totalSporeCount={stats.vault.spore_count}
            totalActiveCount={activeSessionsData?.total ?? 0}
          />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <AgentRunsPanel runs={runsData?.runs ?? []} captureOnly={captureOnly} capabilitiesLink={capabilitiesLink} />
            <div className="flex flex-col gap-6">
              <SkillsPanel skills={skillsData?.records ?? []} skillsOff={skillsOff} capabilitiesLink={capabilitiesLink} />
              <CanopyPanel entries={canopyData?.rows ?? []} canopyOff={canopyOff} capabilitiesLink={capabilitiesLink} />
            </div>
          </div>
        </PageContainer>
      )}
    </PageLoading>
  );
}

/* ---------- Header ---------- */

function DashboardHead({
  stats,
  activeSessionCount,
  inFlightRunCount,
  lastSession,
  captureOnly,
  capabilitiesLink,
}: {
  stats: StatsResponse;
  activeSessionCount: number;
  inFlightRunCount: number;
  lastSession: SessionSummary | undefined;
  captureOnly: boolean;
  capabilitiesLink: string;
}) {
  const projectName = stats.context.project.name || basename(stats.context.project.root);
  const sub = describeActivity(activeSessionCount, inFlightRunCount, stats.embedding.queue_depth);
  return (
    <header className="flex items-start justify-between gap-4 flex-wrap">
      <div className="flex flex-col gap-1 min-w-0">
        <Eyebrow>{projectName}</Eyebrow>
        <h1 className="myco-display-lg text-on-surface m-0">Dashboard</h1>
        <p className="font-sans text-sm text-on-surface-variant m-0">{sub}</p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        {captureOnly && <CaptureOnlyChip to={capabilitiesLink} />}
        <CaptureHealthPill
          lastSession={lastSession}
          activeCount={activeSessionCount}
          totalSessions={stats.vault.session_count}
        />
      </div>
    </header>
  );
}

/**
 * Mode indicator for a project with every capability off. Clicking
 * deep-links to the capability panel — the single place capabilities are
 * toggled. Renders only while every gate is off.
 */
function CaptureOnlyChip({ to }: { to: string }) {
  return (
    <Link
      to={to}
      data-testid="dashboard-capture-only-chip"
      title={`${CAPTURE_ONLY_BADGE.title} — manage capabilities in Grove management.`}
      className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant/40 bg-surface-container/40 px-2.5 py-1 font-sans text-xs text-on-surface-variant transition-colors hover:bg-surface-container-high"
    >
      <StatusDot tone="outline" />
      <span>{CAPTURE_ONLY_BADGE.label}</span>
    </Link>
  );
}

/** Seconds within which the last capture counts as "fresh". */
const CAPTURE_FRESH_WINDOW_S = 7 * 24 * 60 * 60;

/**
 * At-a-glance capture health for the current project — the dashboard twin of
 * the `myco doctor` Capture check. "Capturing now" while a session is live;
 * otherwise the time of the LAST CAPTURE (a session's end, not its start),
 * green when recent and amber when stale (the silent-capture-loss signature);
 * neutral for a project that hasn't captured anything yet.
 */
function CaptureHealthPill({
  lastSession,
  activeCount,
  totalSessions,
}: {
  lastSession: SessionSummary | undefined;
  activeCount: number;
  totalSessions: number;
}) {
  let tone: StatusTone;
  let label: string;
  if (activeCount > 0) {
    tone = 'sage';
    label = 'Capturing now';
  } else if (totalSessions === 0 || !lastSession) {
    tone = 'outline';
    label = 'No sessions captured yet';
  } else {
    // Last capture = when the most recent session ENDED (its last batch
    // landed), falling back to its start for a session with no recorded end.
    const lastCaptureAt = lastSession.ended_at ?? lastSession.started_at;
    const fresh = Date.now() / 1000 - lastCaptureAt <= CAPTURE_FRESH_WINDOW_S;
    tone = fresh ? 'sage' : 'ochre';
    label = fresh
      ? `Last captured ${formatEpochAgo(lastCaptureAt)}`
      : `No capture in 7 days · last ${formatEpochAgo(lastCaptureAt)}`;
  }
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant/40 bg-surface-container/40 px-2.5 py-1 font-sans text-xs text-on-surface-variant"
      title="Capture health for this project — when a session last landed"
    >
      <StatusDot tone={tone} />
      <span>{label}</span>
    </span>
  );
}

function describeActivity(activeSessions: number, runs: number, embedQueue: number): string {
  const parts: string[] = [];
  if (activeSessions > 0) parts.push(`${activeSessions} ${activeSessions === 1 ? 'active session' : 'active sessions'}`);
  if (runs > 0) parts.push(`${runs} ${runs === 1 ? 'run' : 'runs'} running`);
  if (embedQueue > 0) parts.push(`${embedQueue} in the embed queue`);
  if (parts.length === 0) return 'Quiet right now — nothing running.';
  return parts.join(' · ');
}

/* ---------- Scope row ---------- */

function ScopeRow({ stats }: { stats: StatsResponse }) {
  return (
    <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <ProjectHeaderCard stats={stats} />
      <GroveHeaderCard stats={stats} />
    </section>
  );
}

function HeaderCard({
  accent,
  Icon,
  eyebrow,
  name,
  sub,
  children,
}: {
  accent: 'sage' | 'ochre' | 'terra';
  Icon: typeof Layout;
  eyebrow: string;
  name: string;
  sub: string;
  children: React.ReactNode;
}) {
  const iconTone =
    accent === 'sage' ? 'text-sage' : accent === 'ochre' ? 'text-ochre' : 'text-terracotta';
  const eyebrowTone = accent === 'sage' ? 'sage' : accent === 'ochre' ? 'ochre' : 'default';
  return (
    <AccentSurface accent={accent} className="p-5 flex flex-col gap-3">
      <div className="flex flex-col gap-1 min-w-0">
        <div className="flex items-center gap-2">
          <Icon className={cn('h-3.5 w-3.5', iconTone)} />
          <Eyebrow tone={eyebrowTone}>{eyebrow}</Eyebrow>
        </div>
        <div className="myco-display-md text-on-surface truncate" title={name}>{name}</div>
        <div className="font-mono text-[10px] text-outline truncate" title={sub}>{sub}</div>
      </div>
      <div className="grid grid-cols-2 gap-2">{children}</div>
    </AccentSurface>
  );
}

function ProjectHeaderCard({ stats }: { stats: StatsResponse }) {
  const name = stats.context.project.name || basename(stats.context.project.root);
  return (
    <HeaderCard
      accent="sage"
      Icon={Layout}
      eyebrow="Project"
      name={name}
      sub={stats.context.project.root}
    >
      <MetricCard label="Sessions" value={stats.vault.session_count.toLocaleString()} tone="sage" />
      <MetricCard label="Spores" value={stats.vault.spore_count.toLocaleString()} />
      <MetricCard label="Plans" value={stats.vault.plan_count.toLocaleString()} />
      <MetricCard
        label="Canopy"
        value={`${stats.canopy.described_count}/${stats.canopy.entries_count}`}
        sub="described"
        mono
      />
    </HeaderCard>
  );
}

function GroveHeaderCard({ stats }: { stats: StatsResponse }) {
  const grove = stats.context.grove;
  const name = grove.name ?? 'Local only';
  const sub = grove.slug ? `${grove.mode ?? 'local'} · ${grove.connection_state}` : 'no grove bound';
  const embedTotal = stats.embedding.total_embeddable;
  const embedDone = stats.embedding.embedded_count;
  const queue = stats.embedding.queue_depth;
  return (
    <HeaderCard
      accent="ochre"
      Icon={Trees}
      eyebrow="Grove"
      name={name}
      sub={sub}
    >
      <MetricCard
        label="Embeddings"
        value={embedTotal > 0 ? `${embedDone}/${embedTotal}` : '—'}
        sub={embedTotal > 0 ? 'embedded' : 'no items'}
        mono
        tone="ochre"
      />
      <MetricCard
        label="Embed queue"
        value={queue.toLocaleString()}
        sub={queue > 0 ? 'pending' : 'idle'}
      />
    </HeaderCard>
  );
}

/* ---------- Active sessions hero ---------- */

function ActiveSessionsHero({
  sessions,
  totalSporeCount,
  totalActiveCount,
}: {
  sessions: SessionSummary[];
  totalSporeCount: number;
  totalActiveCount: number;
}) {
  const navigate = useNavigate();
  const projectPath = useProjectPathBuilder();
  const headline =
    totalActiveCount === 0
      ? 'No active sessions'
      : `${totalActiveCount} ${totalActiveCount === 1 ? 'active session' : 'active sessions'}`;

  return (
    <Panel tone="sage" eyebrow={`Active sessions · ${totalActiveCount}`} title={headline}>
      {sessions.length === 0 ? (
        <p className="font-sans text-sm text-on-surface-variant m-0">
          Sessions appear here when a symbiont starts a new conversation.
        </p>
      ) : (
        <div className="space-y-2">
          {sessions.map((s, i) => (
            <ActiveSessionRow
              key={s.id}
              session={s}
              accent={(['sage', 'ochre', 'terra'] as const)[i % 3] ?? 'sage'}
              onClick={() => navigate(projectPath(sessionSuffix(s.id)))}
            />
          ))}
        </div>
      )}
      <div className="mt-4 flex items-center justify-between border-t border-[var(--ghost-border)] pt-3 text-xs font-mono text-outline">
        <span>
          <span className="text-on-surface tabular-nums">{totalSporeCount.toLocaleString()}</span> spores total
        </span>
        <button
          type="button"
          onClick={() => navigate(projectPath('/sessions'))}
          className="inline-flex items-center gap-1 text-sage hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40 rounded"
        >
          View session archive
          <ArrowRight className="h-3 w-3" />
        </button>
      </div>
    </Panel>
  );
}

function ActiveSessionRow({
  session,
  accent,
  onClick,
}: {
  session: SessionSummary;
  accent: 'sage' | 'ochre' | 'terra';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full text-left rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest px-4 py-3 transition-colors',
        'hover:bg-surface-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40',
        accent === 'sage' && 'border-l-2 border-l-sage',
        accent === 'ochre' && 'border-l-2 border-l-ochre',
        accent === 'terra' && 'border-l-2 border-l-terracotta',
      )}
    >
      <div className="flex items-center gap-2">
        <StatusDot
          tone={session.status === 'active' ? 'sage' : 'ochre'}
          pulse={session.status === 'active'}
        />
        <span className="font-serif italic text-sm text-on-surface truncate flex-1 min-w-0">
          {session.title || 'Untitled session'}
        </span>
        <span className="font-mono text-[10px] text-outline whitespace-nowrap">
          {formatEpochAgo(session.started_at)}
        </span>
      </div>
      <div className="mt-1 font-mono text-[11px] text-on-surface-variant flex items-center gap-3 flex-wrap">
        <span>{session.agent}</span>
        {session.branch && <span>· {session.branch}</span>}
        <span>· {session.prompt_count}p · {session.tool_count}t</span>
        {session.activity_buckets && session.activity_buckets.length > 1 && (
          <span className="ml-auto">
            <Sparkline data={session.activity_buckets} widthPx={64} heightPx={14} />
          </span>
        )}
      </div>
    </button>
  );
}

/* ---------- Agent runs panel ---------- */

/** Empty-state line for a panel whose feature is off for this project. */
function CapabilityOffNote({ children, link }: { children: React.ReactNode; link: string }) {
  return (
    <p className="font-sans text-sm text-on-surface-variant m-0">
      {children}{' '}
      <Link to={link} className="text-primary underline underline-offset-2 hover:text-primary/80">
        Turn it on in Grove management
      </Link>{' '}
      — or leave it off if capture is all you want here.
    </p>
  );
}

function AgentRunsPanel({ runs, captureOnly, capabilitiesLink }: { runs: RunRow[]; captureOnly: boolean; capabilitiesLink: string }) {
  const navigate = useNavigate();
  const projectPath = useProjectPathBuilder();
  const sorted = [...runs].sort((a, b) => {
    if (a.status === 'running' && b.status !== 'running') return -1;
    if (a.status !== 'running' && b.status === 'running') return 1;
    return (b.started_at ?? 0) - (a.started_at ?? 0);
  });
  return (
    <Panel
      tone="terra"
      eyebrow="Agent runs"
      title="Recent"
      actions={
        <button
          type="button"
          onClick={() => navigate(projectPath('/agent'))}
          className="inline-flex items-center gap-1 text-xs font-sans text-on-surface-variant hover:text-on-surface"
        >
          All runs <ArrowRight className="h-3 w-3" />
        </button>
      }
    >
      {sorted.length === 0 ? (
        captureOnly ? (
          <CapabilityOffNote link={capabilitiesLink}>
            This project is capture-only, so scheduled intelligence tasks are off.
          </CapabilityOffNote>
        ) : (
          <p className="font-sans text-sm text-on-surface-variant m-0">
            No agent runs yet for this project.
          </p>
        )
      ) : (
        <ul className="m-0 p-0 list-none flex flex-col gap-2">
          {sorted.map((run) => (
            <RunMiniRow
              key={run.id}
              run={run}
              onClick={() => navigate(projectPath(agentRunSuffix(run.id)))}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function RunMiniRow({ run, onClick }: { run: RunRow; onClick: () => void }) {
  const tone = runStatusTone(run.status);
  const taskLabel = run.task ?? 'untitled task';
  const tokens = run.tokens_used ?? 0;
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className="w-full text-left rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest px-3 py-2 transition-colors hover:bg-surface-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40"
      >
        <div className="flex items-center gap-2">
          <StatusDot tone={tone} pulse={run.status === 'running'} />
          <span className="font-sans text-sm text-on-surface truncate flex-1 min-w-0">{taskLabel}</span>
          {run.dry_run && (
            <span className="font-mono text-[9px] uppercase tracking-wider text-ochre bg-ochre/10 px-1.5 rounded">
              dry
            </span>
          )}
          <span className="font-mono text-[10px] text-outline whitespace-nowrap">{run.status}</span>
        </div>
        <div className="mt-1 font-mono text-[10px] text-outline flex items-center gap-2 flex-wrap">
          <span>{run.id.slice(0, 8)}</span>
          {run.started_at && <span>· {formatEpochAgo(run.started_at)}</span>}
          {tokens > 0 && <span>· {tokens.toLocaleString()} tok</span>}
          {run.model && <span>· {run.model}</span>}
        </div>
      </button>
    </li>
  );
}

/* ---------- Skills panel ---------- */

function SkillsPanel({ skills, skillsOff, capabilitiesLink }: { skills: SkillRecord[]; skillsOff: boolean; capabilitiesLink: string }) {
  const navigate = useNavigate();
  const projectPath = useProjectPathBuilder();
  const sorted = [...skills].sort((a, b) => b.updated_at - a.updated_at);
  return (
    <Panel
      tone="sage"
      eyebrow="Skills"
      title="Recently evolved"
      actions={
        <button
          type="button"
          onClick={() => navigate(projectPath('/skills'))}
          className="inline-flex items-center gap-1 text-xs font-sans text-on-surface-variant hover:text-on-surface"
        >
          Curate <ArrowRight className="h-3 w-3" />
        </button>
      }
    >
      {sorted.length === 0 ? (
        skillsOff ? (
          <CapabilityOffNote link={capabilitiesLink}>
            Skills are off for this project, so no candidates will be surfaced.
          </CapabilityOffNote>
        ) : (
          <p className="font-sans text-sm text-on-surface-variant m-0">
            No skills yet. The agent surfaces candidates as you work.
          </p>
        )
      ) : (
        <ul className="m-0 p-0 list-none grid grid-cols-1 sm:grid-cols-2 gap-2">
          {sorted.map((skill) => (
            <li
              key={skill.id}
              className="rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest px-3 py-2"
            >
              <div className="flex items-center gap-1.5">
                <Sparkles className="h-3 w-3 text-sage shrink-0" />
                <span className="font-sans text-xs font-medium text-on-surface truncate" title={skill.display_name}>
                  {skill.display_name || skill.name}
                </span>
                <span className="ml-auto font-mono text-[9px] uppercase tracking-wider text-ochre bg-ochre/10 px-1.5 rounded shrink-0">
                  gen {skill.generation}
                </span>
              </div>
              <div className="mt-1 font-mono text-[10px] text-outline">
                {formatEpochAgo(skill.updated_at)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* ---------- Canopy panel ---------- */

function CanopyPanel({ entries, canopyOff, capabilitiesLink }: { entries: CanopyEntryRow[]; canopyOff: boolean; capabilitiesLink: string }) {
  const navigate = useNavigate();
  const projectPath = useProjectPathBuilder();
  return (
    <Panel
      tone="ochre"
      eyebrow="Canopy"
      title="Recent entries"
      actions={
        <button
          type="button"
          onClick={() => navigate(projectPath('/cortex?tab=canopy'))}
          className="inline-flex items-center gap-1 text-xs font-sans text-on-surface-variant hover:text-on-surface"
        >
          Open Cortex <ArrowRight className="h-3 w-3" />
        </button>
      }
    >
      {entries.length === 0 ? (
        canopyOff ? (
          <CapabilityOffNote link={capabilitiesLink}>
            Canopy is off for this project, so files won&rsquo;t be summarized.
          </CapabilityOffNote>
        ) : (
          <p className="font-sans text-sm text-on-surface-variant m-0">
            Canopy hasn&rsquo;t summarized any files yet.
          </p>
        )
      ) : (
        <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
          {entries.map((entry) => (
            <li
              key={entry.path}
              className="flex items-center gap-2 text-xs"
            >
              <FileCode className="h-3 w-3 text-outline shrink-0" />
              <span className="font-mono truncate flex-1 min-w-0 text-on-surface" title={entry.path}>
                {entry.path}
              </span>
              {entry.language && (
                <span className="font-mono text-[10px] text-outline whitespace-nowrap">
                  {entry.language}
                </span>
              )}
              <span className="font-mono text-[10px] text-outline whitespace-nowrap">
                {entry.llm_updated_at
                  ? formatEpochAgo(entry.llm_updated_at)
                  : formatEpochAgo(entry.mechanical_updated_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
