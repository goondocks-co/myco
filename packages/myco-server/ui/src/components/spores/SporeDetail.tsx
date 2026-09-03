import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { Badge } from '../ui/badge';
import { inlineLink } from '../ui/inline-link';
import { MarkdownContent } from '../ui/markdown-content';
import { PageLoading } from '../ui/page-loading';
import { Panel } from '../ui/panel';
import { Surface } from '../ui/surface';
import { useSpore, type SporeRow } from '../../hooks/use-intelligence';
import { ApiError } from '../../lib/api';
import { formatDateTime, formatRelative } from '../../lib/format';
import { NotFound } from '../../pages/NotFound';
import { formatLabel, MAX_IMPORTANCE, sporeTags, statusVariant } from './labels';

/** A stored value reads in full: an id, a path or a hash wraps rather than ending in an ellipsis a reader cannot open. */
function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline gap-3 border-b border-[var(--ghost-border)] py-1.5 last:border-0">
      <dt className="w-20 shrink-0 font-sans text-xs font-medium text-on-surface-variant">{label}</dt>
      <dd className="min-w-0 flex-1 break-all font-mono text-xs text-on-surface">{children}</dd>
    </div>
  );
}

/** How much of a neighbour's id a lineage link shows; the whole id is on the link itself. */
const LINEAGE_ID_CHARS = 8;

/** One end of the lineage: the spores on the other side of a replacement, each a link to its own page. */
function Lineage({ base, label, ids }: { base: string; label: string; ids: string[] }) {
  if (ids.length === 0) return null;
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="shrink-0 font-sans text-xs text-on-surface-variant">{label}</span>
      {ids.map((id) => (
        <Link key={id} to={`${base}/${encodeURIComponent(id)}`} title={id} className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline">
          {id.slice(0, LINEAGE_ID_CHARS)}
          <ArrowRight className="h-3 w-3" />
        </Link>
      ))}
    </div>
  );
}

/** The facts a reader copies or follows: the id, when it landed, what wrote it, the file it names, the session it came out of. */
function Metadata({ projectId, spore }: { projectId: string; spore: SporeRow }) {
  return (
    <Surface level="low" className="overflow-hidden p-4">
      <div className="myco-eyebrow-sm mb-3">Metadata</div>
      <dl className="grid grid-cols-1 gap-x-6 md:grid-cols-2">
        <MetaItem label="Spore ID">{spore.id}</MetaItem>
        <MetaItem label="Created">{formatDateTime(spore.createdAt)}</MetaItem>
        <MetaItem label="Updated">{formatDateTime(spore.updatedAt)}</MetaItem>
        <MetaItem label="Agent">{spore.agentId}</MetaItem>
        <MetaItem label="File">{spore.filePath ?? '—'}</MetaItem>
        <MetaItem label="Session">
          {spore.sessionId === null ? '—' : (
            <Link to={`/p/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(spore.sessionId)}`} className={inlineLink}>{spore.sessionId}</Link>
          )}
        </MetaItem>
      </dl>
    </Surface>
  );
}

/** One spore in full: the observation, its context, its tags, the spores it replaces or is replaced by, and where it came from. */
export function SporeDetail({ projectId, sporeId }: { projectId: string; sporeId: string }) {
  const detail = useSpore(projectId, sporeId);
  if (detail.error instanceof ApiError && detail.error.status === 404) return <NotFound />;
  const base = `/p/${encodeURIComponent(projectId)}/spores`;
  const spore = detail.data?.spore;
  const tags = spore === undefined ? [] : sporeTags(spore.tags);
  const supersedes = detail.data?.supersedes ?? [];
  const supersededBy = detail.data?.supersededBy ?? [];
  return (
    <PageLoading isLoading={detail.isPending} error={detail.error} loadingText="Loading spore…">
      {spore && (
        <div className="flex flex-col gap-5">
          <div className="space-y-2">
            <div className="font-sans text-[10px] uppercase tracking-wide text-on-surface-variant">Spore</div>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="myco-display-lg m-0 min-w-0 text-on-surface">{formatLabel(spore.observationType)}</h2>
              <Badge variant={statusVariant(spore.status)} data-testid="spore-status">{formatLabel(spore.status)}</Badge>
              <Badge variant="secondary">Importance {spore.importance} of {MAX_IMPORTANCE}</Badge>
              <span className="ml-auto font-sans text-xs text-on-surface-variant" title={formatDateTime(spore.createdAt)}>{formatRelative(spore.createdAt)}</span>
            </div>
          </div>

          <Panel title="Observation">
            <MarkdownContent content={spore.content} />
          </Panel>

          {spore.context !== null && spore.context.trim() !== '' && (
            <Panel tone="ochre" title="Context">
              <MarkdownContent content={spore.context} />
            </Panel>
          )}

          {tags.length > 0 && (
            <div className="flex flex-wrap gap-1.5" aria-label="Tags">
              {tags.map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}
            </div>
          )}

          <Panel title="Lineage">
            {supersedes.length === 0 && supersededBy.length === 0 ? (
              <p className="font-sans text-sm text-on-surface-variant">This spore still stands as written.</p>
            ) : (
              <div className="flex flex-col gap-2">
                <Lineage base={base} label="Replaces" ids={supersedes} />
                <Lineage base={base} label="Replaced by" ids={supersededBy} />
              </div>
            )}
          </Panel>

          <Metadata projectId={projectId} spore={spore} />
        </div>
      )}
    </PageLoading>
  );
}
