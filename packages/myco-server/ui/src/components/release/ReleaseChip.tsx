import { formatRelative } from '../../lib/format';
import type { ReleaseStatus } from '../../hooks/use-release-provenance';
import { checkFailureLabel, releaseStateLabel, shortRef } from './release-labels';

const TONE: Record<string, string> = {
  released: 'bg-primary/15 text-primary',
  merged_unreleased: 'bg-secondary/15 text-secondary',
};

/** Whether a session's work is released, how old that answer is, and whether the latest check failed after it. */
export function ReleaseChip({ release }: { release: ReleaseStatus | null | undefined }) {
  if (!release) return null;
  const ref = release.ref === null || release.state === 'not_on_release_line' ? null : shortRef(release.ref);
  const failed = release.latestCheck;
  const title = [
    release.reason,
    `Checked ${formatRelative(release.checkedAt)}`,
    failed ? `Latest check ${formatRelative(failed.finishedAt)} did not finish: ${checkFailureLabel(failed.failure)}. Showing the earlier answer.` : null,
  ].filter(Boolean).join('. ');
  return (
    <span data-testid="release-chip" title={title}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-sans text-xs ${TONE[release.state] ?? 'bg-surface-container-high text-on-surface-variant'}`}>
      {releaseStateLabel(release.state)}{ref !== null && <span className="font-mono">· {ref}</span>}
      {failed && <span className="text-tertiary">· latest check unavailable</span>}
    </span>
  );
}
