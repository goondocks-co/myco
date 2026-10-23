import { CopyButton, ExternalLink, tapTarget } from '../../design';
import { releaseStateLabel, shortRef } from '../../components/release/release-labels';
import {
  useSessionArtifacts, useSessionCommits,
  type ArtifactKind, type CapturePoint, type CommitChanges, type CommitObservation, type CommitReleaseCheck, type SessionArtifact, type SessionCommits,
} from '../../hooks/use-sessions';
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
  const rows: SessionEventRow[] = observations.map((observation) => {
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

/** What each kind of reported artifact is called. */
export const ARTIFACT_WORDS: Record<ArtifactKind, string> = {
  pr: 'Pull request',
  issue: 'Issue',
  tag: 'Tag',
  release: 'Release',
  deploy: 'Deploy',
};

/** Said when the session has neither an observed commit nor a reported artifact. */
export const NOTHING_RECORDED = 'Nothing was recorded for this session.';

/** A pull request or issue is named by its number, as people say it; anything else by its id as reported. */
function artifactTitle({ kind, artifactId }: SessionArtifact): string {
  return (kind === 'pr' || kind === 'issue') && /^\d+$/.test(artifactId) ? `#${artifactId}` : artifactId;
}

/** A reported artifact as a row: its kind, its own id, and its URL, a link only where the read marks it linked. */
export function artifactRow(artifact: SessionArtifact): SessionEventRow {
  return {
    key: `artifact:${artifact.id}`,
    at: artifact.reportedAt,
    kind: ARTIFACT_WORDS[artifact.kind],
    title: artifactTitle(artifact),
    detail: artifact.linked
      ? <ExternalLink href={artifact.url} className={`${tapTarget} break-all`}>{artifact.url}</ExternalLink>
      : <span className="break-all">{artifact.url}</span>,
    trailing: <CopyButton value={artifact.url} label="Copy link" compact />,
  };
}

/**
 * The commit rows and the artifact rows loaded so far, oldest first. While more artifacts remain to load, a commit row
 * later than the last artifact loaded waits for them, so loading a page never puts a row above one already shown.
 */
export function mergeOutcomes(commits: readonly SessionEventRow[], artifacts: readonly SessionEventRow[], moreArtifacts: boolean): SessionEventRow[] {
  const frontier = moreArtifacts ? artifacts.at(-1)?.at ?? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  return [...commits.filter((row) => row.at <= frontier), ...artifacts].sort((a, b) => a.at - b.at);
}

/** What came of the session: the commits Myco observed it start and end on, where the release check found that work, and what it reported creating. */
export function SessionOutcomes({ projectId, sessionId, now }: { projectId: string; sessionId: string; now: number }) {
  const commits = useSessionCommits(projectId, sessionId);
  const artifacts = useSessionArtifacts(projectId, sessionId);
  return (
    <SessionEventList
      read={{
        rows: mergeOutcomes(commits.data === undefined ? [] : outcomeRows(commits.data, now), artifacts.rows.map(artifactRow), artifacts.hasMore),
        isPending: commits.isPending || artifacts.isPending,
        error: commits.error ?? artifacts.error,
        retry: () => { void commits.refetch(); artifacts.retry(); },
        hasMore: artifacts.hasMore,
        isFetchingMore: artifacts.isFetchingMore,
        more: artifacts.more,
      }}
      noun="outcomes"
      wrap
      emptyTitle={NOTHING_RECORDED}
      loadingLabel="Loading the outcomes"
      now={now}
    />
  );
}
