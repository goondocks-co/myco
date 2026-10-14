import { Card, ReadState } from '../../design';
import { useAttention } from '../../hooks/use-attention';
import { useIsAdmin } from '../../hooks/use-me';
import { NeedsYouItem } from './NeedsYou';
import { attentionWords } from './words';

/** A project's code requirements beside its work. */
export function RepositoryNotice({ projectId, projectName, now }: {
  projectId: string | null; projectName: (id: string) => string | null; now: number;
}) {
  const admin = useIsAdmin();
  const query = useAttention({ enabled: admin });
  if (!admin || projectId === null) return null;
  const items = query.data?.items.filter(item => item.kind === 'repository_missing' && item.projectId === projectId) ?? [];
  if (items.length === 0 && !query.error && !query.data?.unavailable.includes('repository_missing')) return null;
  return <Card data-repository-notice="">
    <h2 className="t-h2 text-ink">Needs you</h2>
    <ReadState data={query.data} pending={query.isPending} error={query.error} onRetry={() => void query.refetch()} label="project repositories">{() => null}</ReadState>
    {query.data?.unavailable.includes('repository_missing') && <p className="t-small text-muted">Couldn’t check project repositories just now.</p>}
    <ul>{items.map(item => <NeedsYouItem key={projectId} tone={item.tone} words={attentionWords(item, now, projectName)} />)}</ul>
  </Card>;
}
