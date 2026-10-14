import { Card } from '../../design';
import { useAttention } from '../../hooks/use-attention';
import { useIsAdmin } from '../../hooks/use-me';
import { NeedsYouItem } from './NeedsYou';
import { attentionWords } from './words';

/** A project's code requirements beside its work. */
export function RepositoryNotice({ projectId, projectName, now }: {
  projectId: string | null; projectName: (id: string) => string | null; now: number;
}) {
  const admin = useIsAdmin();
  const query = useAttention({ enabled: admin && projectId !== null, projectId: projectId ?? undefined });
  if (!admin || projectId === null) return null;
  const items = query.data?.items.filter(item => item.kind === 'repository_missing' && item.projectId === projectId) ?? [];
  if (items.length === 0) return null;
  return <Card data-repository-notice="">
    <h2 className="t-h2 text-ink">Needs you</h2>
    <ul>{items.map(item => <NeedsYouItem key={projectId} tone={item.tone} words={attentionWords(item, now, projectName)} />)}</ul>
  </Card>;
}
