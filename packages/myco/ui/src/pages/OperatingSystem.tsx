import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Bot, Brain, Database, Sparkles } from 'lucide-react';
import { CONFIG_FOCUS_TAB_PARAM, CONFIG_SECTION_IDS } from '@myco/config/focus';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';
import { fetchJson, postJson } from '../lib/api';
import {
  DEFAULT_DIGEST_TIER,
  DEFAULT_MAX_SPORES,
  DEFAULT_OPERATING_BRIEF_MAX_TOKENS,
} from '../lib/constants';

type ActiveTab = 'instructions' | 'builder' | 'digest';

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
  inlineInstructions: boolean;
  targetSymbiont: SymbiontInfo | null;
  reports: Array<{
    id: number;
    action: string;
    summary: string;
    created_at: number;
  }>;
}

const CORTEX_TABS = [
  { id: 'instructions', label: 'Instructions' },
  { id: 'builder', label: 'Builder' },
  { id: 'digest', label: 'Digest' },
] as const;
const VALID_TABS = new Set<ActiveTab>(['instructions', 'builder', 'digest']);
const DIGEST_TIERS = [
  { value: '1500', label: '1.5K - Executive briefing' },
  { value: '5000', label: '5K - Deep onboarding' },
  { value: '10000', label: '10K - Full institutional' },
] as const;

function resolveActiveTab(search: string): ActiveTab {
  const params = new URLSearchParams(search);
  const raw = params.get(CONFIG_FOCUS_TAB_PARAM);
  return raw && VALID_TABS.has(raw as ActiveTab) ? (raw as ActiveTab) : 'instructions';
}

function writeSearchParam(name: string, value: string | null): void {
  const params = new URLSearchParams(window.location.search);
  if (value === null) {
    params.delete(name);
  } else {
    params.set(name, value);
  }
  const search = params.toString();
  const nextUrl = search ? `${window.location.pathname}?${search}` : window.location.pathname;
  window.history.pushState(null, '', nextUrl);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function formatTimestamp(epochSeconds: number | null): string {
  if (!epochSeconds) return 'Not generated yet';
  return new Date(epochSeconds * 1000).toLocaleString();
}

function useCortexInstructions() {
  return useQuery<CortexInstructionsResponse>({
    queryKey: ['cortex-instructions'],
    queryFn: ({ signal }) => fetchJson<CortexInstructionsResponse>('/cortex/instructions', { signal }),
    staleTime: 5_000,
  });
}

export default function OperatingSystem() {
  const location = useLocation();
  const activeTab = resolveActiveTab(location.search);
  const handleTabChange = useCallback((tabId: string) => {
    if (!VALID_TABS.has(tabId as ActiveTab)) return;
    writeSearchParam(CONFIG_FOCUS_TAB_PARAM, tabId === 'instructions' ? null : tabId);
  }, []);

  return (
    <div className="p-6">
      <PageHeader
        title="Cortex"
        subtitle="Apply Myco intelligence through session-start instructions, prompt building, and digest retrieval."
        tabs={CORTEX_TABS.map((tab) => ({ id: tab.id, label: tab.label }))}
        activeTab={activeTab}
        onTabChange={handleTabChange}
      />

      {activeTab === 'digest' ? <DigestTab /> : activeTab === 'builder' ? <BuilderTab /> : <InstructionsTab />}
    </div>
  );
}

function InstructionsTab() {
  const { effective, isLoading } = useScopedConfig();
  const instructionsQuery = useCortexInstructions();
  const [refreshing, setRefreshing] = useState(false);

  const refreshInstructions = useCallback(async () => {
    setRefreshing(true);
    try {
      await postJson<CortexInstructionsResponse>('/cortex/instructions/refresh', {});
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
              Cortex replaces automatic digest injection at session start.
            </p>
            <p className="max-w-3xl font-sans text-sm text-on-surface-variant">
              Myco now injects task-authored session-start instructions that teach agents how to
              retrieve the right knowledge on demand. The digest remains available below as an
              on-demand retrieval surface.
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
            path="context.operating_brief_enabled"
            label="Inject session-start instructions"
            defaultScope="project"
          >
            {({ value, onChange }) => (
              <Switch checked={value ?? true} onCheckedChange={onChange} />
            )}
          </ScopedField>

          <ScopedField
            path="context.operating_brief_max_tokens"
            label="Instructions token budget"
            defaultScope="project"
          >
            {({ value, onChange }) => (
              <Input
                type="number"
                min={50}
                max={1000}
                value={String(value ?? DEFAULT_OPERATING_BRIEF_MAX_TOKENS)}
                onChange={(event) => onChange(Number(event.target.value))}
              />
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
          </div>
          <Button onClick={() => void refreshInstructions()} disabled={refreshing}>
            {refreshing ? 'Refreshing...' : 'Refresh'}
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

        <Surface level="base" className="rounded-lg border border-outline-variant/20 p-5">
          {instructionsQuery.isLoading ? (
            <p className="font-sans text-sm text-on-surface-variant">Loading instructions...</p>
          ) : instructions?.content ? (
            <MarkdownContent content={instructions.content} />
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
  const { data: symbiontsData } = useSymbionts();
  const enabledSymbionts = useMemo(
    () => (symbiontsData?.symbionts ?? []).filter((symbiont) => symbiont.enabled),
    [symbiontsData],
  );
  const [goal, setGoal] = useState('');
  const [symbiont, setSymbiont] = useState<string>(enabledSymbionts[0]?.name ?? '');
  const [result, setResult] = useState<CortexBuilderResponse | null>(null);
  const [loading, setLoading] = useState(false);

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
      const next = await postJson<CortexBuilderResponse>('/cortex/prompt-builder', {
        goal,
        ...(symbiont ? { symbiont } : {}),
      });
      setResult(next);
    } finally {
      setLoading(false);
    }
  }, [goal, symbiont]);

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
              Tell Myco what you want to build and which symbiont you are targeting. Cortex runs a
              task through the Myco agent harness and returns a high-signal prompt you can paste
              into that agent.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <label className="block space-y-2">
            <span className="font-sans text-sm font-medium text-on-surface">What do you want to build?</span>
            <Input
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="Build a migration workflow for ..."
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
          </label>

          <Button onClick={() => void buildPrompt()} disabled={!canBuild || loading}>
            {loading ? 'Building...' : 'Build Prompt'}
          </Button>
        </div>
      </Surface>

      {result ? (
        <Surface level="low" className="rounded-lg border border-outline-variant/20 p-6 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="default">{result.status}</Badge>
            <Badge variant="secondary">
              {result.inlineInstructions ? 'Instructions inlined' : 'Session-start injection expected'}
            </Badge>
            {result.targetSymbiont ? (
              <Badge variant="secondary">{result.targetSymbiont.displayName}</Badge>
            ) : null}
          </div>

          <Surface level="base" className="rounded-lg border border-outline-variant/20 p-5">
            <pre className="whitespace-pre-wrap font-mono text-sm text-on-surface">{result.prompt}</pre>
          </Surface>

          <div className="space-y-2">
            <p className="font-sans text-sm font-medium text-on-surface">Task reports</p>
            <div className="space-y-2">
              {result.reports.map((report) => (
                <div key={report.id} className="rounded-md border border-outline-variant/20 px-3 py-2">
                  <p className="font-sans text-sm font-medium text-on-surface">
                    {report.action}
                  </p>
                  <p className="font-sans text-sm text-on-surface-variant">{report.summary}</p>
                </div>
              ))}
            </div>
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
              The digest is still maintained by Myco and remains available for on-demand retrieval.
              Cortex teaches agents when to request it instead of injecting it automatically.
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
