import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Loader2, Sparkles } from 'lucide-react';
import { Badge } from '../components/ui/badge';
import { inlineLink } from '../components/ui/inline-link';
import { MarkdownContent } from '../components/ui/markdown-content';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { PageLoading } from '../components/ui/page-loading';
import { Panel } from '../components/ui/panel';
import { SubtabPill } from '../components/ui/subtab-pill';
import {
  INSTRUCTIONS_OUTCOME_TEXT, refusalText, useDigestRevisions, useDigests, useInstructions, useRefreshInstructions,
  type DigestRow, type InstructionsCounts,
} from '../hooks/use-intelligence';
import { cn } from '../lib/cn';
import { formatDateTime, formatRelative } from '../lib/format';

const button = 'rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high';

const TABS = [
  { id: 'instructions', label: 'Instructions' },
  { id: 'digest', label: 'Digest' },
  { id: 'map', label: 'Code map' },
];

const tabOf = (raw: string | null): string => (TABS.some((t) => t.id === raw) ? (raw as string) : 'instructions');

/** `/p/:projectId/cortex`: what this project's agents generate for session start — instructions, digests, and the code map. */
export function Cortex() {
  const { projectId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = tabOf(params.get('tab'));
  return (
    <PageContainer>
      <PageHeader title="Cortex" subtitle="What this project's agents generate for session start." />
      <div className="mb-4">
        <SubtabPill tabs={TABS} activeTab={tab} onTabChange={(id) => setParams(id === 'instructions' ? {} : { tab: id })} />
      </div>
      {tab === 'instructions' && <Instructions projectId={projectId} />}
      {tab === 'digest' && <Digests projectId={projectId} />}
      {tab === 'map' && (
        <Panel title="Code map">
          <p className="font-sans text-sm text-on-surface-variant">The code map is not available on this deployment yet.</p>
        </Panel>
      )}
    </PageContainer>
  );
}

/** What one instructions row was written from, when its run recorded it. */
function writtenFrom(counts: InstructionsCounts | null): string | null {
  if (counts === null) return null;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  return `Written from ${plural(counts.sessions, 'session')}, ${plural(counts.spores, 'spore')}, ${plural(counts.plans, 'plan')}`;
}

/**
 * Asks for this project's instructions to be written again, and says how it
 * went. A run writes them, so a started run is named with a link to itself; a
 * project that has not moved since the last write is told so and starts nothing.
 */
function RefreshInstructions({ projectId }: { projectId: string }) {
  const refresh = useRefreshInstructions(projectId);
  const answer = refresh.data;
  const note = refresh.error ? refusalText(refresh.error) : answer ? INSTRUCTIONS_OUTCOME_TEXT[answer.outcome] : null;
  const busy = refresh.isPending;
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        aria-disabled={busy}
        aria-busy={busy}
        onClick={() => { if (!busy) refresh.mutate(); }}
        className={cn(button, 'inline-flex h-8 items-center gap-2 font-medium', busy && 'opacity-60')}
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
        {busy ? 'Asking…' : 'Refresh instructions'}
      </button>
      {note !== null && (
        <span className="font-sans text-xs text-tertiary" role="status">
          {note}
          {answer?.runId !== undefined && <> · <Link to={`/p/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(answer.runId)}`} className="underline">see the run</Link></>}
        </span>
      )}
    </div>
  );
}

function Instructions({ projectId }: { projectId: string }) {
  const instructions = useInstructions(projectId);
  const runBase = `/p/${encodeURIComponent(projectId)}/runs`;
  return (
    <PageLoading isLoading={instructions.isPending} error={instructions.error}>
      {instructions.data && (instructions.data.instructions.length === 0 ? (
        <Panel title="Instructions" actions={<RefreshInstructions projectId={projectId} />}>
          <p className="font-sans text-sm text-on-surface-variant">No instructions generated yet. They appear here once the instructions task has run.</p>
        </Panel>
      ) : (
        <div className="flex flex-col gap-4">
          {instructions.data.instructions.map((row, index) => (
            <Panel key={row.id} eyebrow={row.agentId} title="Current instructions" actions={
              <div className="flex flex-wrap items-start gap-2">
                <Badge variant="secondary" title={formatDateTime(row.generatedAt)}>generated {formatRelative(row.generatedAt)}</Badge>
                {row.sourceRunId !== null && (
                  <Link to={`${runBase}/${encodeURIComponent(row.sourceRunId)}`} className={inlineLink}>from run {row.sourceRunId}</Link>
                )}
                {index === 0 && <RefreshInstructions projectId={projectId} />}
              </div>
            }>
              {writtenFrom(row.counts) !== null && (
                <p className="mb-3 font-sans text-xs text-on-surface-variant">{writtenFrom(row.counts)}</p>
              )}
              <MarkdownContent content={row.content} />
            </Panel>
          ))}
        </div>
      ))}
    </PageLoading>
  );
}

function Digests({ projectId }: { projectId: string }) {
  const digests = useDigests(projectId);
  const list = digests.data?.digests ?? [];
  const agents = [...new Set(list.map((d) => d.agentId))];
  return (
    <PageLoading isLoading={digests.isPending} error={digests.error}>
      {list.length === 0 ? (
        <Panel title="Digest">
          <p className="font-sans text-sm text-on-surface-variant">No digest generated yet. It appears here once the digest task has run.</p>
        </Panel>
      ) : (
        <div className="flex flex-col gap-4">
          {agents.map((agentId) => <AgentDigests key={agentId} projectId={projectId} agentId={agentId} digests={list.filter((d) => d.agentId === agentId)} showAgent={agents.length > 1} />)}
        </div>
      )}
    </PageLoading>
  );
}

function AgentDigests({ projectId, agentId, digests, showAgent }: { projectId: string; agentId: string; digests: DigestRow[]; showAgent: boolean }) {
  const [tier, setTier] = useState<number>(digests[0]!.tier);
  const current = digests.find((d) => d.tier === tier) ?? digests[0]!;
  const revisions = useDigestRevisions(projectId, agentId, current.tier);
  const runBase = `/p/${encodeURIComponent(projectId)}/runs`;
  return (
    <Panel eyebrow={showAgent ? agentId : undefined} title="Digest" actions={
      <SubtabPill tabs={digests.map((d) => ({ id: String(d.tier), label: `${d.tier.toLocaleString()} tokens` }))} activeTab={String(current.tier)} onTabChange={(id) => setTier(Number(id))} />
    }>
      <div className="mb-3">
        <Badge variant="secondary" title={formatDateTime(current.generatedAt)}>generated {formatRelative(current.generatedAt)}</Badge>
      </div>
      <MarkdownContent content={current.content} />
      <div className="mt-4 border-t border-outline-variant/10 pt-3">
        <div className="mb-2 font-sans text-[10px] uppercase tracking-wide text-on-surface-variant">Revisions</div>
        <PageLoading isLoading={revisions.isPending} error={revisions.error}>
          {revisions.data && (revisions.data.revisions.length === 0 ? (
            <p className="font-sans text-sm text-on-surface-variant">No earlier revisions.</p>
          ) : (
            <ul className="flex flex-col gap-1" aria-label="Revisions">
              {revisions.data.revisions.map((rev) => (
                <li key={rev.id}>
                  <details>
                    <summary className="cursor-pointer font-sans text-sm text-on-surface">
                      {formatRelative(rev.createdAt)}
                      {rev.runId !== null && <> · <Link to={`${runBase}/${encodeURIComponent(rev.runId)}`} className="text-primary underline">run {rev.runId}</Link></>}
                    </summary>
                    <div className="mt-2 rounded-md border border-outline-variant/20 p-3">
                      <MarkdownContent content={rev.content} />
                    </div>
                  </details>
                </li>
              ))}
            </ul>
          ))}
        </PageLoading>
      </div>
    </Panel>
  );
}
