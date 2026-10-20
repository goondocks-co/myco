import { CopyButton } from '../../design';
import { releaseStateLabel, shortRef } from '../../components/release/release-labels';
import { useSessionCommits, type CapturePoint, type CommitChanges, type CommitObservation, type CommitReleaseCheck, type SessionCommits } from '../../hooks/use-sessions';
import { ago } from '../today/words';
import { SessionEventList, type SessionEventRow } from './SessionEventList';

/** A commit as people name it: its first seven characters. */
export const shortSha = (sha: string) => sha.slice(0, 7);

/** Said when the start and end commits are the same. Only the two are observed, so it never claims HEAD stood still between them. */
export const SAME_HEAD = 'Start and end HEAD are the same';

const CHANGES_WORDS: Record<CommitChanges, string | null> = {
  none: null,
  uncommitted: 'uncommitted changes',
  unreadable: 'couldn’t tell whether files changed',
};

const POINT_WORD: Record<CapturePoint, string> = { session_start: 'start', session_end: 'end' };

/** Why a release is unknown, by the basis the check recorded. */
const UNKNOWN_WHY: Record<string, string> = {
  dirty_worktree: 'the session ended with uncommitted changes',
  missing_git_evidence: 'the commit’s own work couldn’t be established',
  ref_check_failed: 'not every release could be checked',
};

/** The states whose basis names where the commit is. */
const CONTAINED = new Set(['released', 'merged_unreleased']);

function observationTitle(observation: CommitObservation): string {
  const at = shortSha(observation.headSha);
  const head = observation.point === 'session_start'
    ? `Started at ${at}${observation.branch === null ? '' : ` on ${observation.branch}`}`
    : `Ended at ${at}`;
  const changes = CHANGES_WORDS[observation.changes];
  return changes === null ? head : `${head}, ${changes}`;
}

/** The release state in words: the state, where the commit is, the pull request that carried it, and when the check ran. */
export function containmentWords(release: CommitReleaseCheck, now: number): string {
  const why = release.state === 'unknown' && release.basisKind !== null ? UNKNOWN_WHY[release.basisKind] : undefined;
  const state = release.state === 'unreconciled' && release.basisKind === 'configuration'
    ? `${releaseStateLabel(release.state)}: no release refs are set`
    : why === undefined ? releaseStateLabel(release.state) : `${releaseStateLabel(release.state)}: ${why}`;
  return [
    state,
    CONTAINED.has(release.state) && release.basisRef !== null ? shortRef(release.basisRef) : null,
    release.releasePrNumber === null ? null : `PR #${release.releasePrNumber}`,
    `checked ${ago(release.checkedAt, now)}`,
  ].filter((part) => part !== null).join(' · ');
}

/**
 * The rows the Outcomes tab lists, oldest first: each observed commit, with the release state on the observation
 * it is classified from, and the release check on a row of its own when it names no observation shown.
 */
export function outcomeRows({ observations, release }: SessionCommits, now: number): SessionEventRow[] {
  const start = observations.find((o) => o.point === 'session_start');
  const end = observations.find((o) => o.point === 'session_end');
  const same = start !== undefined && end !== undefined && start.headSha === end.headSha;
  const covered = release?.covers?.current === true ? release.covers.point : null;
  const rows: (SessionEventRow & { at: number })[] = observations.map((observation) => {
    const detail = [
      observation.point === 'session_end' && same ? SAME_HEAD : null,
      release !== null && covered === observation.point ? containmentWords(release, now) : null,
    ].filter((part) => part !== null).join(' · ');
    return {
      key: observation.point,
      at: observation.capturedAt,
      kind: 'Commit',
      title: observationTitle(observation),
      detail: detail === '' ? undefined : detail,
      trailing: <CopyButton value={observation.headSha} label="Copy commit" compact />,
    };
  });
  if (release !== null && covered === null) {
    rows.push({
      key: 'release',
      at: release.checkedAt,
      kind: 'Release check',
      title: release.covers === null ? 'Release check source not recorded' : `Release check covers an earlier ${POINT_WORD[release.covers.point]} commit`,
      detail: containmentWords(release, now),
    });
  }
  return rows.sort((a, b) => a.at - b.at);
}

/** What came of the session that Myco observed: the commits it started and ended on, and where the release check found its work. */
export function SessionOutcomes({ projectId, sessionId, now }: { projectId: string; sessionId: string; now: number }) {
  const commits = useSessionCommits(projectId, sessionId);
  return (
    <SessionEventList
      read={{
        rows: commits.data === undefined ? [] : outcomeRows(commits.data, now),
        isPending: commits.isPending,
        error: commits.error,
        retry: () => void commits.refetch(),
        hasMore: false,
        isFetchingMore: false,
        more: () => undefined,
      }}
      noun="outcomes"
      wrap
      emptyTitle="No commits were observed in this session."
      loadingLabel="Loading the outcomes"
      now={now}
    />
  );
}
