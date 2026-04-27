import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Brain, Check, Copy, Database, Sparkles, Trees } from 'lucide-react';
import { CONFIG_FOCUS_TAB_PARAM, CONFIG_SECTION_IDS } from '@myco/config/focus';
import { useAgentRuns } from '../hooks/use-agent';
import { useScopedConfig } from '../hooks/use-scoped-config';
import { useSymbionts, type SymbiontInfo } from '../hooks/use-symbionts';
import { PageHeader } from '../components/ui/page-header';
import { Surface } from '../components/ui/surface';
import { SectionHeader } from '../components/ui/section-header';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Switch } from '../components/ui/switch';
import { MarkdownContent } from '../components/ui/markdown-content';
import { ScopedField } from '../components/config/ScopedField';
import { DigestView } from '../components/mycelium/DigestView';
import { CanopyEntriesPanel } from '../components/canopy/CanopyEntriesPanel';
import { ProjectMapPanel } from '../components/canopy/ProjectMapPanel';
import { TabSwitcher } from '../components/ui/tab-switcher';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../components/ui/dialog';
import { fetchJson, postJson } from '../lib/api';
import {
  DEFAULT_DIGEST_TIER,
  DEFAULT_MAX_SPORES,
  POLL_INTERVALS,
} from '../lib/constants';
import { formatDuration, formatEpochAbsolute, formatEpochRelative, shortSession, truncate } from '../lib/format';

type ActiveTab = 'instructions' | 'builder' | 'digest' | 'canopy';
type CanopySection = 'overview' | 'entries' | 'map';

const CANOPY_SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'entries', label: 'Entries' },
  { id: 'map', label: 'Map' },
] as const;
const VALID_CANOPY_SECTIONS = new Set<CanopySection>(CANOPY_SECTIONS.map((s) => s.id));
const CANOPY_SECTION_PARAM = 'section';

/**
 * Legacy sub-tab IDs that mapped to today's nested Canopy sections. Existing
 * bookmarks use these; the redirect shim below rewrites them to the new
 * `?tab=canopy&section=...` shape on first navigation so people land where
 * they expect without a 404 detour.
 */
const LEGACY_TAB_TO_CANOPY_SECTION: Record<string, CanopySection> = {
  'canopy-entries': 'entries',
  'project-map': 'map',
};

interface CortexInstructionsResponse {
  content: string;
  generatedAt: number | null;
  sourceRunId: string | null;
  enabled: boolean;
  stored: boolean;
}

interface CortexBuilderResponse {
  runId: string;
  status: string;
  prompt: string;
  reports: Array<{
    id: number;
    action: string;
    summary: string;
    created_at: number;
  }>;
  error?: string | null;
}

interface CortexBuilderStartResponse {
  started: boolean;
  runId: string | null;
  inlineInstructions: boolean;
  targetSymbiont: SymbiontInfo | null;
}

interface CortexRefreshResponse {
  started: boolean;
  reason?: string;
  runId?: string | null;
}

interface ParsedBuilderInstruction {
  goal: string;
  targetSymbiontName: string | null;
  targetSymbiontDisplayName: string | null;
  inlineInstructions: boolean | null;
}

const CORTEX_TABS = [
  { id: 'instructions', label: 'Instructions' },
  { id: 'builder', label: 'Builder' },
  { id: 'digest', label: 'Digest' },
  { id: 'canopy', label: 'Canopy' },
] as const;
const VALID_TABS = new Set<ActiveTab>(CORTEX_TABS.map((tab) => tab.id));
const CORTEX_TERMINAL_STATUSES = new Set(['completed', 'failed', 'skipped']);
const CORTEX_BUILDER_HISTORY_LIMIT = 12;
const CORTEX_BUILDER_GOAL_PREVIEW_CHARS = 140;
const DIGEST_TIERS = [
  { value: '1500', label: '1.5K - Executive briefing' },
  { value: '5000', label: '5K - Deep onboarding' },
  { value: '10000', label: '10K - Full institutional' },
] as const;

function resolveActiveTab(search: string): ActiveTab {
  const params = new URLSearchParams(search);
  const raw = params.get(CONFIG_FOCUS_TAB_PARAM);
  if (!raw) return 'instructions';
  // Legacy aliases redirect to the unified Canopy tab; the section is
  // resolved separately in resolveCanopySection().
  if (raw in LEGACY_TAB_TO_CANOPY_SECTION) return 'canopy';
  return VALID_TABS.has(raw as ActiveTab) ? (raw as ActiveTab) : 'instructions';
}

function resolveCanopySection(search: string): CanopySection {
  const params = new URLSearchParams(search);
  const tab = params.get(CONFIG_FOCUS_TAB_PARAM);
  // Honor a legacy alias as long as the explicit `section` param isn't set.
  if (tab && tab in LEGACY_TAB_TO_CANOPY_SECTION) {
    const aliasTarget = LEGACY_TAB_TO_CANOPY_SECTION[tab];
    if (aliasTarget) return aliasTarget;
  }
  const raw = params.get(CANOPY_SECTION_PARAM);
  return raw && VALID_CANOPY_SECTIONS.has(raw as CanopySection)
    ? (raw as CanopySection)
    : 'overview';
}

function formatTimestamp(epochSeconds: number | null): string {
  if (!epochSeconds) return 'Not generated yet';
  return new Date(epochSeconds * 1000).toLocaleString();
}

function formatRefreshReason(reason?: string): string {
  switch (reason) {
    case 'event-tasks-disabled':
      return 'event-driven tasks are disabled';
    case 'provider-not-configured':
      return 'no provider is configured for Cortex instructions';
    case 'agent-module-unavailable':
      return 'the agent runtime is unavailable';
    default:
      return reason ?? 'unknown reason';
  }
}

function parseJsonSection<T>(instruction: string, sectionTitle: string): T | null {
  const escapedTitle = sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = instruction.match(new RegExp(`## ${escapedTitle}\\n([\\s\\S]*?)\\n\\n## `));
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]) as T;
  } catch {
    return null;
  }
}

function parseBuilderInstruction(instruction: string | null): ParsedBuilderInstruction {
  if (!instruction) {
    return {
      goal: '',
      targetSymbiontName: null,
      targetSymbiontDisplayName: null,
      inlineInstructions: null,
    };
  }

  const goalMatch = instruction.match(/^Goal:\n([\s\S]*?)\n\n## Target symbiont\n/);
  const targetSymbiont = parseJsonSection<{
    name?: string;
    displayName?: string;
  } | null>(instruction, 'Target symbiont');
  const deliveryContract = parseJsonSection<{
    inline_instructions?: boolean;
  }>(instruction, 'Delivery contract');

  return {
    goal: goalMatch?.[1]?.trim() ?? '',
    targetSymbiontName: targetSymbiont?.name ?? null,
    targetSymbiontDisplayName: targetSymbiont?.displayName ?? null,
    inlineInstructions: typeof deliveryContract?.inline_instructions === 'boolean'
      ? deliveryContract.inline_instructions
      : null,
  };
}

function statusBadgeVariant(status: string | undefined): 'default' | 'secondary' | 'warning' | 'destructive' {
  switch (status) {
    case 'completed':
      return 'default';
    case 'failed':
      return 'destructive';
    case 'running':
      return 'warning';
    default:
      return 'secondary';
  }
}

function deliveryModeLabel(inlineInstructions: boolean | null): string | null {
  if (inlineInstructions === null) return null;
  return inlineInstructions ? 'Instructions included in prompt' : 'Uses session-start instructions';
}

function useCortexInstructions() {
  return useQuery<CortexInstructionsResponse>({
    queryKey: ['cortex-instructions'],
    queryFn: ({ signal }) => fetchJson<CortexInstructionsResponse>('/cortex/instructions', { signal }),
    staleTime: 60_000,
  });
}

function useCortexBuilderResult(runId: string | null) {
  return useQuery<CortexBuilderResponse>({
    queryKey: ['cortex-prompt-builder', runId],
    queryFn: ({ signal }) => fetchJson<CortexBuilderResponse>(`/cortex/prompt-builder/${runId}`, { signal }),
    enabled: Boolean(runId),
    staleTime: 0,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && CORTEX_TERMINAL_STATUSES.has(status)
        ? false
        : POLL_INTERVALS.PROGRESS;
    },
  });
}

export default function Cortex() {
  const location = useLocation();
  const navigate = useNavigate();
  const activeTab = resolveActiveTab(location.search);
  const canopySection = resolveCanopySection(location.search);

  const handleTabChange = useCallback((tabId: string) => {
    if (!VALID_TABS.has(tabId as ActiveTab)) return;
    const params = new URLSearchParams(location.search);
    if (tabId === 'instructions') {
      params.delete(CONFIG_FOCUS_TAB_PARAM);
    } else {
      params.set(CONFIG_FOCUS_TAB_PARAM, tabId);
    }
    // Switching tabs always drops the section param — sections only make
    // sense within the Canopy tab and they default to 'overview' anyway.
    if (tabId !== 'canopy') params.delete(CANOPY_SECTION_PARAM);
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '' }, { replace: true });
  }, [location.pathname, location.search, navigate]);

  const handleCanopySectionChange = useCallback((sectionId: string) => {
    if (!VALID_CANOPY_SECTIONS.has(sectionId as CanopySection)) return;
    const params = new URLSearchParams(location.search);
    // Migrate any legacy alias on the way out — keep the URL canonical.
    const rawTab = params.get(CONFIG_FOCUS_TAB_PARAM);
    if (rawTab && rawTab in LEGACY_TAB_TO_CANOPY_SECTION) {
      params.set(CONFIG_FOCUS_TAB_PARAM, 'canopy');
    } else {
      params.set(CONFIG_FOCUS_TAB_PARAM, 'canopy');
    }
    if (sectionId === 'overview') {
      params.delete(CANOPY_SECTION_PARAM);
    } else {
      params.set(CANOPY_SECTION_PARAM, sectionId);
    }
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '' }, { replace: true });
  }, [location.pathname, location.search, navigate]);

  // Deep links from before the unification — `?tab=canopy-entries` and
  // `?tab=project-map` — are accepted by the resolvers above. On first
  // render we rewrite the URL so the browser shows the canonical shape;
  // resolvers stay tolerant for any other consumer (e.g. saved bookmarks).
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const rawTab = params.get(CONFIG_FOCUS_TAB_PARAM);
    if (rawTab && rawTab in LEGACY_TAB_TO_CANOPY_SECTION) {
      const target = LEGACY_TAB_TO_CANOPY_SECTION[rawTab];
      params.set(CONFIG_FOCUS_TAB_PARAM, 'canopy');
      if (target && target !== 'overview') {
        params.set(CANOPY_SECTION_PARAM, target);
      } else {
        params.delete(CANOPY_SECTION_PARAM);
      }
      const search = params.toString();
      navigate({ pathname: location.pathname, search: search ? `?${search}` : '' }, { replace: true });
    }
    // Run once per pathname/search change.
  }, [location.pathname, location.search, navigate]);

  return (
    <div className="p-6">
      <PageHeader
        title="Cortex"
        subtitle="Manage session-start context, prompt building, and digest access for connected symbionts."
        tabs={CORTEX_TABS.map((tab) => ({ id: tab.id, label: tab.label }))}
        activeTab={activeTab}
        onTabChange={handleTabChange}
      />

      {activeTab === 'digest' ? (
        <DigestTab />
      ) : activeTab === 'builder' ? (
        <BuilderTab />
      ) : activeTab === 'canopy' ? (
        <CanopyTabUnified
          section={canopySection}
          onSectionChange={handleCanopySectionChange}
          searchParams={location.search}
        />
      ) : (
        <InstructionsTab />
      )}
    </div>
  );
}

interface CanopyTabUnifiedProps {
  section: CanopySection;
  onSectionChange: (section: string) => void;
  searchParams: string;
}

function CanopyTabUnified({ section, onSectionChange, searchParams }: CanopyTabUnifiedProps) {
  return (
    <div className="space-y-6">
      <TabSwitcher
        tabs={CANOPY_SECTIONS.map((s) => ({ id: s.id, label: s.label }))}
        activeTab={section}
        onTabChange={onSectionChange}
      />

      {section === 'entries' ? (
        (() => {
          const pathFromUrl = new URLSearchParams(searchParams).get('path') ?? undefined;
          return (
            <CanopyEntriesPanel
              key={pathFromUrl ?? 'no-path'}
              defaultPath={pathFromUrl}
            />
          );
        })()
      ) : section === 'map' ? (
        <ProjectMapPanel />
      ) : (
        <CanopyTab />
      )}
    </div>
  );
}

function InstructionsTab() {
  const { effective, isLoading } = useScopedConfig();
  const instructionsQuery = useCortexInstructions();
  const [refreshing, setRefreshing] = useState(false);
  const [instructionsExpanded, setInstructionsExpanded] = useState(false);
  const [refreshState, setRefreshState] = useState<CortexRefreshResponse | null>(null);

  const refreshInstructions = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await postJson<CortexRefreshResponse>('/cortex/instructions/refresh', {});
      setRefreshState(result);
      await instructionsQuery.refetch();
    } finally {
      setRefreshing(false);
    }
  }, [instructionsQuery]);

  if (isLoading || !effective) {
    return <p className="font-sans text-sm text-on-surface-variant">Loading...</p>;
  }

  const instructions = instructionsQuery.data;

  return (
    <div className="space-y-6">
      <Surface level="low" className="rounded-lg border border-primary/15 p-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="rounded-md bg-primary/10 p-2 text-primary">
            <Brain className="h-4 w-4" />
          </div>
          <div className="space-y-1">
            <p className="font-sans text-sm font-medium text-on-surface">
              Session-start instructions for Myco-enabled symbionts.
            </p>
            <p className="max-w-3xl font-sans text-sm text-on-surface-variant">
              Review the stored instructions, control whether they inject alongside the digest, and
              refresh the stored guidance when project context changes.
            </p>
          </div>
        </div>
      </Surface>

      <Surface
        id={CONFIG_SECTION_IDS.cortexInstructions}
        level="low"
        className="rounded-lg border border-outline-variant/20 p-6 space-y-5"
      >
        <SectionHeader>Instructions Settings</SectionHeader>

        <div className="grid gap-4 lg:grid-cols-2">
          <ScopedField
            path="context.cortex_enabled"
            label="Inject session-start instructions"
            defaultScope="project"
          >
            {({ value, onChange }) => (
              <Switch checked={value ?? true} onCheckedChange={onChange} />
            )}
          </ScopedField>

          <ScopedField
            path="context.session_start_digest_enabled"
            label="Inject preferred digest"
            defaultScope="project"
          >
            {({ value, onChange }) => (
              <Switch checked={value ?? false} onCheckedChange={onChange} />
            )}
          </ScopedField>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <ScopedField
            path="context.prompt_search"
            label="Prompt-time spore retrieval"
            defaultScope="project"
          >
            {({ value, onChange }) => (
              <Switch checked={value ?? true} onCheckedChange={onChange} />
            )}
          </ScopedField>

          <ScopedField
            path="context.prompt_max_spores"
            label="Max spores per prompt"
            defaultScope="project"
          >
            {({ value, onChange }) => (
              <Input
                type="number"
                min={0}
                max={10}
                value={String(value ?? DEFAULT_MAX_SPORES)}
                onChange={(event) => onChange(Number(event.target.value))}
              />
            )}
          </ScopedField>
        </div>
      </Surface>

      <Surface level="low" className="rounded-lg border border-outline-variant/20 p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <SectionHeader>Current Instructions</SectionHeader>
            <p className="font-sans text-sm text-on-surface-variant">
              Stored Markdown generated by the Myco agent for session-start injection.
            </p>
            {refreshState ? (
              <p className="mt-2 font-sans text-sm text-on-surface-variant">
                {refreshState.started
                  ? `Refresh started${refreshState.runId ? ` — run ${refreshState.runId}` : ''}. The stored artifact updates when that run completes.`
                  : `Refresh did not start${refreshState.reason ? ` — ${formatRefreshReason(refreshState.reason)}` : ''}.`}
              </p>
            ) : null}
          </div>
          <Button onClick={() => void refreshInstructions()} disabled={refreshing}>
            {refreshing ? 'Starting...' : 'Refresh'}
          </Button>
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge variant={instructions?.enabled ? 'default' : 'secondary'}>
            {instructions?.enabled ? 'Session start enabled' : 'Session start disabled'}
          </Badge>
          <Badge variant="secondary">
            {instructions?.stored ? 'Stored artifact' : 'No stored artifact'}
          </Badge>
          <Badge variant="secondary">
            Generated: {formatTimestamp(instructions?.generatedAt ?? null)}
          </Badge>
        </div>

        <Surface level="default" className="rounded-lg border border-outline-variant/20 p-5">
          {instructionsQuery.isLoading ? (
            <p className="font-sans text-sm text-on-surface-variant">Loading instructions...</p>
          ) : instructions?.content ? (
            <div className="space-y-3">
              <div className="flex items-center justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setInstructionsExpanded((current) => !current)}
                >
                  {instructionsExpanded ? 'Collapse' : 'Expand'}
                </Button>
              </div>
              <div
                className={
                  instructionsExpanded
                    ? 'max-h-[70vh] overflow-auto pr-2'
                    : 'max-h-[28rem] overflow-auto pr-2'
                }
              >
                <MarkdownContent content={instructions.content} />
              </div>
            </div>
          ) : (
            <p className="font-sans text-sm text-on-surface-variant">
              No Cortex instructions are stored yet. Refresh to generate them.
            </p>
          )}
        </Surface>
      </Surface>
    </div>
  );
}

function BuilderTab() {
  const builderRunsQuery = useAgentRuns({
    task: 'cortex-prompt-builder',
    limit: CORTEX_BUILDER_HISTORY_LIMIT,
  });
  const { data: symbiontsData } = useSymbionts();
  const enabledSymbionts = useMemo(
    () => (symbiontsData?.symbionts ?? []).filter((symbiont) => symbiont.enabled),
    [symbiontsData],
  );
  const [goal, setGoal] = useState('');
  const [symbiont, setSymbiont] = useState<string>(enabledSymbionts[0]?.name ?? '');
  const [buildStart, setBuildStart] = useState<CortexBuilderStartResponse | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const latestRunResultQuery = useCortexBuilderResult(buildStart?.runId ?? null);
  const selectedRunResultQuery = useCortexBuilderResult(selectedRunId);

  const builderRuns = useMemo(() => {
    return (builderRunsQuery.data?.runs ?? []).map((run) => ({
      run,
      parsed: parseBuilderInstruction(run.instruction),
    }));
  }, [builderRunsQuery.data?.runs]);
  const selectedRunEntry = useMemo(
    () => builderRuns.find(({ run }) => run.id === selectedRunId) ?? null,
    [builderRuns, selectedRunId],
  );

  useEffect(() => {
    if (enabledSymbionts.length === 0) {
      if (symbiont) setSymbiont('');
      return;
    }
    const stillValid = enabledSymbionts.some((item) => item.name === symbiont);
    if (!stillValid) {
      setSymbiont(enabledSymbionts[0]?.name ?? '');
    }
  }, [enabledSymbionts, symbiont]);

  const buildPrompt = useCallback(async () => {
    setLoading(true);
    try {
      const next = await postJson<CortexBuilderStartResponse>('/cortex/prompt-builder', {
        goal,
        ...(symbiont ? { symbiont } : {}),
      });
      setBuildStart(next);
      void builderRunsQuery.refetch();
    } finally {
      setLoading(false);
    }
  }, [builderRunsQuery, goal, symbiont]);

  const canBuild = goal.trim().length > 0;

  return (
    <div className="space-y-6">
      <Surface
        id={CONFIG_SECTION_IDS.cortexBuilder}
        level="low"
        className="rounded-lg border border-outline-variant/20 p-6 space-y-5"
      >
        <div className="flex flex-wrap items-start gap-3">
          <div className="rounded-md bg-primary/10 p-2 text-primary">
            <Sparkles className="h-4 w-4" />
          </div>
          <div className="space-y-1">
            <SectionHeader>Prompt Builder</SectionHeader>
            <p className="max-w-3xl font-sans text-sm text-on-surface-variant">
              Tell Myco what you want to build and which enabled symbiont you are targeting.
              Cortex runs a task through the Myco agent harness and returns a high-signal prompt
              you can paste into that agent.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <label className="block space-y-2">
            <span className="font-sans text-sm font-medium text-on-surface">What do you want to build?</span>
            <textarea
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="Build a migration workflow for ..."
              rows={5}
              className="w-full rounded-md bg-surface-container-lowest px-3 py-2 font-sans text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-hidden focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50 resize-y"
            />
          </label>

          <label className="block space-y-2">
            <span className="font-sans text-sm font-medium text-on-surface">Target symbiont</span>
            <Select value={symbiont} onValueChange={setSymbiont}>
              <SelectTrigger>
                <SelectValue placeholder="Choose a symbiont" />
              </SelectTrigger>
              <SelectContent>
                {enabledSymbionts.map((item) => (
                  <SelectItem key={item.name} value={item.name}>
                    {item.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="font-sans text-xs text-on-surface-variant">
              This list comes from the symbionts enabled for this project.
            </p>
          </label>

          <Button onClick={() => void buildPrompt()} disabled={!canBuild || loading}>
            {loading ? 'Starting...' : 'Build Prompt'}
          </Button>
        </div>
      </Surface>

      {buildStart ? (
        <Surface level="low" className="rounded-lg border border-outline-variant/20 p-6 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={statusBadgeVariant(latestRunResultQuery.data?.status ?? 'running')}>
              {latestRunResultQuery.data?.status ?? 'running'}
            </Badge>
            {deliveryModeLabel(buildStart.inlineInstructions) ? (
              <Badge variant="secondary">{deliveryModeLabel(buildStart.inlineInstructions)}</Badge>
            ) : null}
            {buildStart.targetSymbiont ? (
              <Badge variant="secondary">{buildStart.targetSymbiont.displayName}</Badge>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-sans text-sm text-on-surface-variant">
              {latestRunResultQuery.data?.status && CORTEX_TERMINAL_STATUSES.has(latestRunResultQuery.data.status)
                ? `Run ${buildStart.runId ?? 'pending'} finished.`
                : `Run ${buildStart.runId ?? 'pending'} is in progress. Cortex checks for the prompt automatically.`}
            </p>
            <div className="flex items-center gap-2">
              {buildStart.runId ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedRunId(buildStart.runId)}
                >
                  View Details
                </Button>
              ) : null}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  void latestRunResultQuery.refetch();
                  void builderRunsQuery.refetch();
                }}
                disabled={latestRunResultQuery.isFetching || builderRunsQuery.isFetching}
              >
                {latestRunResultQuery.isFetching || builderRunsQuery.isFetching ? 'Refreshing...' : 'Refresh'}
              </Button>
            </div>
          </div>
        </Surface>
      ) : null}

      <Surface level="low" className="rounded-lg border border-outline-variant/20 p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <SectionHeader>Recent Builds</SectionHeader>
            <p className="font-sans text-sm text-on-surface-variant">
              Each run captures the original build request, the generated prompt, and a direct link to the underlying agent run.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void builderRunsQuery.refetch()}
            disabled={builderRunsQuery.isFetching}
          >
            {builderRunsQuery.isFetching ? 'Refreshing...' : 'Refresh'}
          </Button>
        </div>

        {builderRunsQuery.isLoading ? (
          <p className="font-sans text-sm text-on-surface-variant">Loading recent builds...</p>
        ) : builderRuns.length === 0 ? (
          <Surface level="default" className="rounded-lg border border-outline-variant/20 p-5">
            <p className="font-sans text-sm text-on-surface-variant">
              No builder runs yet. Start one above and Cortex will keep the prompt artifact here.
            </p>
          </Surface>
        ) : (
          <div className="space-y-3">
            {builderRuns.map(({ run, parsed }) => (
              <Surface key={run.id} level="default" className="rounded-lg border border-outline-variant/20 p-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={statusBadgeVariant(run.status)}>{run.status}</Badge>
                      {deliveryModeLabel(parsed.inlineInstructions) ? (
                        <Badge variant="secondary">{deliveryModeLabel(parsed.inlineInstructions)}</Badge>
                      ) : null}
                      {parsed.targetSymbiontDisplayName ? (
                        <Badge variant="secondary">{parsed.targetSymbiontDisplayName}</Badge>
                      ) : null}
                    </div>
                    <p className="font-sans text-sm font-medium text-on-surface">
                      {truncate(parsed.goal || 'Untitled build request', CORTEX_BUILDER_GOAL_PREVIEW_CHARS)}
                    </p>
                    <div className="flex flex-wrap items-center gap-3 font-sans text-xs text-on-surface-variant">
                      <span>Started {formatEpochRelative(run.started_at)}</span>
                      <span>Run {shortSession(run.id)}</span>
                      {run.completed_at ? (
                        <span>Duration {formatDuration(run.started_at, run.completed_at)}</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelectedRunId(run.id)}
                    >
                      View Details
                    </Button>
                    <a
                      href={`/agent?run=${run.id}`}
                      className="inline-flex h-8 items-center justify-center rounded-md border border-[var(--ghost-border)] px-3 font-sans text-xs font-medium text-on-surface transition-all hover:bg-surface-container-high"
                    >
                      Open Run
                    </a>
                  </div>
                </div>
              </Surface>
            ))}
          </div>
        )}
      </Surface>

      <Dialog open={selectedRunId !== null} onOpenChange={(open) => {
        if (!open) setSelectedRunId(null);
      }}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Prompt Build Details</DialogTitle>
            <DialogDescription>
              Review the generated prompt, task reports, and jump to the full agent run when you need deeper diagnostics.
            </DialogDescription>
          </DialogHeader>

          {selectedRunId ? (
            <BuilderRunDetail
              runId={selectedRunId}
              runInstruction={selectedRunEntry?.run.instruction ?? null}
              result={selectedRunResultQuery.data}
              isLoading={selectedRunResultQuery.isLoading}
              isFetching={selectedRunResultQuery.isFetching}
              onRefresh={() => void selectedRunResultQuery.refetch()}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface BuilderRunDetailProps {
  runId: string;
  runInstruction: string | null;
  result: CortexBuilderResponse | undefined;
  isLoading: boolean;
  isFetching: boolean;
  onRefresh: () => void;
}

function BuilderRunDetail({
  runId,
  runInstruction,
  result,
  isLoading,
  isFetching,
  onRefresh,
}: BuilderRunDetailProps) {
  const parsed = useMemo(() => parseBuilderInstruction(runInstruction), [runInstruction]);
  const [copied, setCopied] = useState(false);

  const copyPrompt = useCallback(async () => {
    if (!result?.prompt) return;
    if (!navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(result.prompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }, [result?.prompt]);

  if (isLoading && !result) {
    return <p className="font-sans text-sm text-on-surface-variant">Loading build details...</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={statusBadgeVariant(result?.status)}>{result?.status ?? 'loading'}</Badge>
            <Badge variant="secondary">Run {shortSession(runId)}</Badge>
            {parsed.targetSymbiontDisplayName ? (
              <Badge variant="secondary">{parsed.targetSymbiontDisplayName}</Badge>
            ) : null}
          </div>
          {parsed.goal ? (
            <p className="font-sans text-sm font-medium text-on-surface">{parsed.goal}</p>
          ) : null}
          {deliveryModeLabel(parsed.inlineInstructions) ? (
            <p className="font-sans text-xs text-on-surface-variant">
              {parsed.inlineInstructions
                ? 'This build embeds the current Cortex instructions directly into the generated prompt.'
                : 'This build expects the target symbiont to receive Cortex instructions at session start.'}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {result?.prompt ? (
            <Button variant="outline" size="sm" onClick={() => void copyPrompt()}>
              {copied ? (
                <>
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                  Copy Prompt
                </>
              )}
            </Button>
          ) : null}
          <a
            href={`/agent?run=${runId}`}
            className="inline-flex h-8 items-center justify-center rounded-md border border-[var(--ghost-border)] px-3 font-sans text-xs font-medium text-on-surface transition-all hover:bg-surface-container-high"
          >
            Open Full Run
          </a>
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={isFetching}>
            {isFetching ? 'Refreshing...' : 'Refresh'}
          </Button>
        </div>
      </div>

      <Surface level="default" className="rounded-lg border border-outline-variant/20 p-5 space-y-2">
        <p className="font-sans text-sm font-medium text-on-surface">Generated Prompt</p>
        {result?.prompt ? (
          <pre className="whitespace-pre-wrap font-mono text-sm text-on-surface">{result.prompt}</pre>
        ) : (
          <p className="font-sans text-sm text-on-surface-variant">
            {result?.status === 'failed'
              ? result.error || 'The prompt builder run failed before producing a prompt.'
              : 'Waiting for the Myco agent to produce the prompt...'}
          </p>
        )}
      </Surface>

      {result?.reports?.length ? (
        <Surface level="default" className="rounded-lg border border-outline-variant/20 p-5 space-y-3">
          <p className="font-sans text-sm font-medium text-on-surface">Task Reports</p>
          <div className="space-y-2">
            {result.reports.map((report) => (
              <div key={report.id} className="rounded-md border border-outline-variant/20 px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-sans text-sm font-medium text-on-surface">{report.action}</p>
                  <span className="font-sans text-xs text-on-surface-variant">
                    {formatEpochAbsolute(report.created_at)}
                  </span>
                </div>
                <p className="font-sans text-sm text-on-surface-variant">{report.summary}</p>
              </div>
            ))}
          </div>
        </Surface>
      ) : null}
    </div>
  );
}

function DigestTab() {
  return (
    <div className="space-y-6">
      <Surface
        id={CONFIG_SECTION_IDS.cortexDigest}
        level="low"
        className="rounded-lg border border-outline-variant/20 p-6 space-y-5"
      >
        <div className="flex flex-wrap items-start gap-3">
          <div className="rounded-md bg-primary/10 p-2 text-primary">
            <Database className="h-4 w-4" />
          </div>
          <div className="space-y-1">
            <SectionHeader>Digest</SectionHeader>
            <p className="max-w-3xl font-sans text-sm text-on-surface-variant">
              Choose which digest tier Cortex should use when digest injection is enabled, and
              review the maintained extracts below for on-demand retrieval.
            </p>
          </div>
        </div>

        <ScopedField
          path="context.digest_tier"
          label="Preferred digest tier"
          defaultScope="project"
        >
          {({ value, onChange }) => (
            <Select value={String(value ?? DEFAULT_DIGEST_TIER)} onValueChange={(next) => onChange(Number(next))}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIGEST_TIERS.map((tier) => (
                  <SelectItem key={tier.value} value={tier.value}>
                    {tier.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </ScopedField>
      </Surface>

      <DigestView />
    </div>
  );
}

function CanopyTab() {
  const { effective, isLoading } = useScopedConfig();
  if (isLoading || !effective) {
    return <p className="font-sans text-sm text-on-surface-variant">Loading...</p>;
  }

  return (
    <div className="space-y-6">
      <Surface level="low" className="rounded-lg border border-primary/15 p-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="rounded-md bg-primary/10 p-2 text-primary">
            <Trees className="h-4 w-4" />
          </div>
          <div className="space-y-1">
            <p className="font-sans text-sm font-medium text-on-surface">
              Canopy code intelligence — file-level metadata Cortex can offer agents on Read.
            </p>
            <p className="max-w-3xl font-sans text-sm text-on-surface-variant">
              The mechanical scanner runs automatically. Tier 2 LLM summaries are opt-in and use
              the agent provider configured under Settings. Local-first models are recommended.
            </p>
          </div>
        </div>
      </Surface>

      <Surface
        id="config-section-cortex-canopy-collection"
        level="low"
        className="rounded-lg border border-outline-variant/20 p-6 space-y-5"
      >
        <div className="space-y-1">
          <SectionHeader>Collection</SectionHeader>
          <p className="font-sans text-sm text-on-surface-variant">
            The scanner automatically skips anything matched by this project's
            {' '}<code className="font-mono text-xs">.gitignore</code>{' '}
            plus directories that Myco and your installed symbionts manage
            ({' '}<code className="font-mono text-xs">.myco/</code>,
            {' '}<code className="font-mono text-xs">.agents/</code>,
            {' '}<code className="font-mono text-xs">.claude/</code>,
            {' '}<code className="font-mono text-xs">.cursor/</code>, etc.).
            Add patterns below to exclude additional paths.
          </p>
        </div>

        <ScopedField<'canopy.exclude.patterns', string[]>
          path="canopy.exclude.patterns"
          label="Extra exclude patterns"
          defaultScope="project"
          commitOn="blur"
        >
          {({ value, onChange }) => {
            const lines = (value ?? []).join('\n');
            return (
              <textarea
                className="min-h-[120px] w-full rounded-md border border-outline-variant/30 bg-surface-container-low px-3 py-2 font-mono text-xs text-on-surface placeholder:text-on-surface-variant focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
                placeholder={"# one glob per line, e.g.\nfixtures/large/**\n**/*.snap"}
                value={lines}
                onChange={(event) => {
                  const next = event.target.value
                    .split('\n')
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0 && !line.startsWith('#'));
                  onChange(next);
                }}
              />
            );
          }}
        </ScopedField>

        <div className="space-y-1 pt-2">
          <p className="font-sans text-xs uppercase tracking-wide text-on-surface-variant">
            Background refresh
          </p>
          <p className="font-sans text-sm text-on-surface-variant">
            Session start and the Write/Edit tool already keep the index fresh during
            sessions. The background sweep is the safety net for changes made outside
            sessions ({' '}<code className="font-mono text-xs">git pull</code>, edits
            via non-Myco tools).
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <ScopedField<'canopy.refresh.background_enabled', boolean>
            path="canopy.refresh.background_enabled"
            label="Periodic background scan"
            defaultScope="project"
          >
            {({ value, onChange }) => (
              <Switch checked={value ?? true} onCheckedChange={onChange} />
            )}
          </ScopedField>

          <ScopedField<'canopy.refresh.background_period_minutes', number>
            path="canopy.refresh.background_period_minutes"
            label="Period (minutes)"
            defaultScope="project"
          >
            {({ value, onChange }) => (
              <Input
                type="number"
                min={1}
                value={String(value ?? 60)}
                onChange={(event) => onChange(Number(event.target.value))}
              />
            )}
          </ScopedField>
        </div>
      </Surface>

      <Surface
        id="config-section-cortex-canopy-injection"
        level="low"
        className="rounded-lg border border-outline-variant/20 p-6 space-y-5"
      >
        <SectionHeader>Injection</SectionHeader>

        <div className="grid gap-4 lg:grid-cols-2">
          <ScopedField<'cortex.canopy.injection.enabled', boolean>
            path="cortex.canopy.injection.enabled"
            label="Inject canopy on Read"
            defaultScope="project"
          >
            {({ value, onChange }) => (
              <Switch checked={value ?? true} onCheckedChange={onChange} />
            )}
          </ScopedField>

          <ScopedField<'cortex.canopy.injection.size_threshold', number>
            path="cortex.canopy.injection.size_threshold"
            label="Minimum file size (bytes)"
            defaultScope="project"
          >
            {({ value, onChange }) => (
              <Input
                type="number"
                min={0}
                value={String(value ?? 800)}
                onChange={(event) => onChange(Number(event.target.value))}
              />
            )}
          </ScopedField>
        </div>
      </Surface>

      <Surface
        id="config-section-cortex-canopy-llm"
        level="low"
        className="rounded-lg border border-outline-variant/20 p-6 space-y-2"
      >
        <SectionHeader>LLM Descriptions (Tier 2)</SectionHeader>
        <p className="font-sans text-sm text-on-surface-variant">
          One-sentence file summaries that ride along with the injection blob. Configured on the{' '}
          <Link
            to="/agent?tab=tasks&task=canopy-describe"
            className="text-primary underline underline-offset-2 hover:text-primary/80"
          >
            canopy-describe task
          </Link>
          {' '}— schedule, provider, reasoning level, and per-row caps all live there so a single page is the source of truth.
        </p>
      </Surface>
    </div>
  );
}
