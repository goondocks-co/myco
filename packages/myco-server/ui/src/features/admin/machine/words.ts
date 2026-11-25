/**
 * A machine in words: the one verdict its page leads with, whose it is and since when, and what its runner is doing.
 * Every phrase comes from what the server read of the machine's sign-ins and of the runner registered on it; nothing
 * is said of a machine that the server did not record.
 */
import type { FleetRun, RunnerFleetRecord } from '@goondocks/myco-shared/runner-fleet';
import { agoWords, dayWords, isInstant } from '@goondocks/myco-shared/time-words';
import type { HealthTone } from '../../../design';
import type { Machine } from '../machines';
import { taskWords } from '../workers';

/** How long after a machine last captured anything it reads as capturing. */
export const CAPTURING_MS = 86_400_000;

/** The facts of a machine's sign-ins a verdict reads. */
export type ClaimFacts = Pick<Machine, 'standing' | 'lastCaptureAt' | 'firstSeenAt' | 'stoppedBy'>;
/** The facts of a runner registration a verdict reads. */
export type RunnerFacts = Pick<RunnerFleetRecord, 'state' | 'display' | 'busy' | 'lastSeenAt' | 'removedAt' | 'createdAt' | 'lastCompleted' | 'lastFailed' | 'lastAttempted' | 'readiness' | 'offers' | 'awaitingReplacement'>;

/** What a machine's page leads with: one word or phrase, its tone, and one sentence. */
export interface Verdict {
  label: string;
  tone: HealthTone;
  line: string;
}

/** A runner's latest run whatever its outcome, in one phrase, or what it is running now. */
export function lastRunWords(runner: Pick<RunnerFleetRecord, 'busy' | 'lastCompleted' | 'lastFailed' | 'lastAttempted'>, now: number): string {
  if (runner.busy !== null) return `Running ${taskWords(runner.busy.task)} now`;
  const latest = latestRun(runner);
  if (latest === null) return 'Has not run anything yet';
  const task = taskWords(latest.run.task);
  const when = agoWords(latest.run.at, now);
  return latest.outcome === 'ran' ? `Last ran ${task} ${when}` : latest.outcome === 'failed' ? `Last run, ${task}, failed ${when}` : `Last started ${task} ${when}, with no outcome reported`;
}

/** The runner's latest run, told by how it ended where it ended. */
function latestRun(runner: Pick<RunnerFleetRecord, 'lastCompleted' | 'lastFailed' | 'lastAttempted'>): { run: FleetRun; outcome: 'ran' | 'failed' | 'started' } | null {
  const runs: Array<{ run: FleetRun; outcome: 'ran' | 'failed' | 'started' }> = [
    ...(runner.lastCompleted === null ? [] : [{ run: runner.lastCompleted, outcome: 'ran' as const }]),
    ...(runner.lastFailed === null ? [] : [{ run: runner.lastFailed, outcome: 'failed' as const }]),
    ...(runner.lastAttempted === null ? [] : [{ run: runner.lastAttempted, outcome: 'started' as const }]),
  ];
  const ended = new Set(runs.filter(({ outcome }) => outcome !== 'started').map(({ run }) => run.runId));
  return runs.filter(({ run, outcome }) => outcome !== 'started' || !ended.has(run.runId))
    .reduce<(typeof runs)[number] | null>((best, next) => (best === null || next.run.at > best.run.at ? next : best), null);
}

/** What a runner is doing or last did, in one phrase: its run, why it is not ready, or when it was last seen. */
export function runnerDoing(runner: RunnerFacts & Pick<RunnerFleetRecord, 'state'>, now: number = Date.now()): string {
  if (runner.state === 'removed') return 'Removed; it can no longer run work';
  if (runner.awaitingReplacement === true && runner.state === 'enabled') return 'Waiting for the replacement to check in';
  if (runner.state === 'paused') return runner.busy ? 'Paused; finishing its current run' : 'Paused; it takes no new work';
  if (runner.busy) {
    const work = runner.busy.task === 'title-summary' ? 'Writing a title' : runner.busy.task === 'extract-curate' ? 'Learning from sessions' : runner.busy.task === 'canopy-map' ? 'Updating a code map' : `Running ${taskWords(runner.busy.task)}`;
    return `${work}${runner.busy.projectName ? ` for ${runner.busy.projectName}` : ''}, started ${agoWords(runner.busy.at, now)}`;
  }
  if (runner.display === 'Not ready') {
    switch (runner.readiness.code ?? runner.readiness.state) {
      case 'settling': return 'Settling after waking';
      case 'updating': return 'Finishing an update';
      case 'registration': return 'Waiting for registration approval';
      case 'user_active': return 'Waiting until the machine is idle';
      case 'incompatible': return 'Its agent needs an update';
      case 'credential_unavailable': return 'Waiting for a usable key';
      case 'out_of_credit': return 'Waiting for API credit';
      case 'invalid_key': return 'Waiting for a valid key';
      case 'not_signed_in': return 'No signed-in agent';
    }
    if (runner.offers?.length === 0 || runner.offers?.every((offer) => !offer.authenticated)) return 'No signed-in agent';
    return 'Not ready, for a reason it didn’t report';
  }
  if (runner.display === 'Never contacted') return 'It hasn’t checked in since it was registered';
  if (runner.display === 'Offline') return `Not seen lately; last seen ${agoWords(runner.lastSeenAt, now)}`;
  return lastRunWords(runner, now);
}

/** When something last happened on the machine: its latest capture or run, else when it first signed in or was registered. */
function quietSince(claim: ClaimFacts | null, runner: RunnerFacts | null): number {
  const latest = runner === null ? null : latestRun(runner);
  const times = [claim?.lastCaptureAt ?? null, latest?.run.at ?? null].filter((at): at is number => at !== null);
  if (times.length > 0) return Math.max(...times);
  return claim?.firstSeenAt ?? runner?.createdAt ?? 0;
}

const live = (runner: RunnerFacts | null): runner is RunnerFacts & { state: 'enabled' | 'paused' } => runner !== null && runner.state !== 'removed';

/**
 * The verdict a machine's page leads with, from its sign-ins (`claim`) and the runner registered on it: Working while
 * its runner is online, Capturing while its agents sent something in the last day, Quiet since its last activity,
 * Offline when its runner has not been seen or its sign-in lapsed, and Removed when nothing on it may send or take work.
 */
export function machineVerdict(claim: ClaimFacts | null, runner: RunnerFacts | null, now: number = Date.now(), nameOf: (id: string | null) => string | null = () => null): Verdict {
  const signedIn = claim !== null && claim.standing === 'allowed';
  const capturing = signedIn && claim.lastCaptureAt !== null && now - claim.lastCaptureAt < CAPTURING_MS;
  if (live(runner) && (runner.display === 'Busy' || runner.display === 'Online')) {
    return { label: 'Working', tone: 'ok', line: `${runnerDoing(runner, now)}.` };
  }
  if (capturing) return { label: 'Capturing', tone: 'ok', line: `Last captured ${agoWords(claim.lastCaptureAt, now)}.` };
  const quietAt = quietSince(claim, runner);
  const since = isInstant(quietAt) ? `Quiet since ${dayWords(quietAt, now)}` : 'Quiet';
  if (live(runner) && (runner.display === 'Paused' || runner.display === 'Not ready')) {
    return { label: since, tone: runner.display === 'Not ready' ? 'warn' : 'faint', line: `${runnerDoing(runner, now)}.` };
  }
  if (live(runner)) return { label: 'Offline', tone: 'faint', line: `${runnerDoing(runner, now)}.` };
  if (signedIn) {
    return { label: since, tone: 'faint', line: claim.lastCaptureAt === null ? 'Nothing captured from it lately.' : `Last captured ${agoWords(claim.lastCaptureAt, now)}.` };
  }
  if (claim?.standing === 'expired') return { label: 'Offline', tone: 'faint', line: 'Its sign-in expired, so it sends nothing now.' };
  if (claim?.standing === 'replayed') return { label: 'Removed', tone: 'faint', line: 'Stopped: its sign-in was used from two places.' };
  if (claim?.standing === 'stopped') {
    const by = nameOf(claim.stoppedBy);
    return { label: 'Removed', tone: 'faint', line: `Stopped${by === null ? '' : ` by ${by}`}; it can’t send anything now.` };
  }
  return { label: 'Removed', tone: 'faint', line: `Removed ${runner?.removedAt == null ? '' : `${agoWords(runner.removedAt, now)} `}as a runner; it can no longer take work.` };
}

/** Whose a machine is and since when: its sign-ins' member and first sign-in, else who registered its runner and when. */
export function ownerWords(owner: { memberId: string | null; viewerId: string | null; name: string | null }, since: { at: number; registered: boolean }, now: number = Date.now()): string {
  const whose = owner.memberId !== null && owner.memberId === owner.viewerId ? 'Yours' : owner.name === null ? null : `${owner.name}’s`;
  if (since.registered) return `Registered as a runner ${dayWords(since.at, now)}${whose === null ? '' : `, ${whose === 'Yours' ? 'by you' : `by ${owner.name}`}`}.`;
  return `${whose ?? 'A teammate’s'}, first signed in ${dayWords(since.at, now)}.`;
}
