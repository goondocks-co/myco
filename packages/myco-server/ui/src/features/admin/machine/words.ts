/**
 * A machine in words: the one verdict its page leads with, whose it is and since when, and what its runner is doing.
 * Every phrase comes from what the server read of the machine's sign-ins and of the runner registered on it; nothing
 * is said of a machine that the server did not record.
 */
import type { FleetRun, RunnerFleetRecord } from '@goondocks/myco-shared/runner-fleet';
import { agoWords, dayWords, isInstant } from '@goondocks/myco-shared/time-words';
import type { HealthTone } from '../../../design';
import type { WorkerRow } from '../../../lib/api';
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
function quietSince(claim: ClaimFacts | null, runners: readonly RunnerFacts[]): number {
  const times = [claim?.lastCaptureAt ?? null, ...runners.map((runner) => latestRun(runner)?.run.at ?? null)].filter((at): at is number => at !== null);
  if (times.length > 0) return Math.max(...times);
  return claim?.firstSeenAt ?? (runners.length === 0 ? 0 : Math.min(...runners.map((runner) => runner.createdAt)));
}

/** A legacy worker's facts a verdict reads: its lease, whether it was heard from lately, and whether it may take work. */
export type LegacyFacts = Pick<WorkerRow, 'busy' | 'recent' | 'eligible' | 'lastSeenAt'>;

const isLive = (runner: RunnerFacts): boolean => runner.state !== 'removed';

/** A runner's phrase, named when the machine has more than one registration. */
const named = (runner: RunnerFacts & { name?: string }, several: boolean, now: number): string =>
  `${several && runner.name !== undefined ? `${runner.name}: ` : ''}${runnerDoing(runner, now)}`;

/**
 * The verdict a machine's page leads with, from its sign-ins (`claim`), every runner registration bound to it and any
 * legacy worker on it: Working while one of them holds a run, Capturing while its agents sent something in the last day,
 * Online while one waits for work, Quiet since its last activity when paused or not ready or only signed in, Offline
 * when none was seen lately or its sign-in lapsed, and Removed when nothing on it may send or take work.
 */
export function machineVerdict(claim: ClaimFacts | null, runners: readonly (RunnerFacts & { name?: string })[], now: number = Date.now(),
  nameOf: (id: string | null) => string | null = () => null, legacy: readonly LegacyFacts[] = []): Verdict {
  const live = runners.filter(isLive);
  const several = live.length > 1;
  const signedIn = claim !== null && claim.standing === 'allowed';
  const capturing = signedIn && claim.lastCaptureAt !== null && now - claim.lastCaptureAt < CAPTURING_MS;
  const busy = live.filter((runner) => runner.busy !== null);
  if (busy.length > 0) return { label: 'Working', tone: 'ok', line: `${busy.map((runner) => named(runner, several, now)).join('. ')}.` };
  const legacyBusy = legacy.find((worker) => worker.busy !== null);
  if (legacyBusy !== undefined) return { label: 'Working', tone: 'ok', line: `Running ${taskWords(legacyBusy.busy!.task)} as a legacy worker.` };
  if (capturing) return { label: 'Capturing', tone: 'ok', line: `Last captured ${agoWords(claim.lastCaptureAt, now)}.` };
  const online = live.filter((runner) => runner.display === 'Online');
  if (online.length > 0) return { label: 'Online', tone: 'ok', line: `Waiting for work. ${online.map((runner) => named(runner, several, now)).join('. ')}.` };
  if (legacy.some((worker) => worker.recent && worker.eligible)) return { label: 'Online', tone: 'ok', line: 'Waiting for work as a legacy worker.' };
  const quietAt = quietSince(claim, live);
  const since = isInstant(quietAt) ? `Quiet since ${dayWords(quietAt, now)}` : 'Quiet';
  const held = live.filter((runner) => runner.display === 'Paused' || runner.display === 'Not ready');
  if (held.length > 0) {
    return { label: since, tone: held.some((runner) => runner.display === 'Not ready') ? 'warn' : 'faint', line: `${held.map((runner) => named(runner, several, now)).join('. ')}.` };
  }
  if (live.length > 0) {
    const capture = !signedIn ? '' : claim.lastCaptureAt === null ? ' Nothing captured from it lately.' : ` Last captured ${agoWords(claim.lastCaptureAt, now)}.`;
    return { label: 'Offline', tone: 'faint', line: `${live.map((runner) => named(runner, several, now)).join('. ')}.${capture}` };
  }
  if (signedIn) {
    return { label: since, tone: 'faint', line: claim.lastCaptureAt === null ? 'Nothing captured from it lately.' : `Last captured ${agoWords(claim.lastCaptureAt, now)}.` };
  }
  if (claim?.standing === 'expired') return { label: 'Offline', tone: 'faint', line: 'Its sign-in expired, so it sends nothing now.' };
  if (claim?.standing === 'replayed') return { label: 'Removed', tone: 'faint', line: 'Stopped: its sign-in was used from two places.' };
  if (claim?.standing === 'stopped') {
    const by = nameOf(claim.stoppedBy);
    return { label: 'Removed', tone: 'faint', line: `Stopped${by === null ? '' : ` by ${by}`}; it can’t send anything now.` };
  }
  const removedAt = Math.max(0, ...runners.map((runner) => runner.removedAt ?? 0));
  return { label: 'Removed', tone: 'faint', line: `Removed ${removedAt === 0 ? '' : `${agoWords(removedAt, now)} `}as a runner; it can no longer take work.` };
}

/** Whose a machine is and since when: its sign-ins' member and first sign-in, else who registered its runner and when. */
export function ownerWords(owner: { memberId: string | null; viewerId: string | null; name: string | null }, since: { at: number; registered: boolean }, now: number = Date.now()): string {
  const whose = owner.memberId !== null && owner.memberId === owner.viewerId ? 'Yours' : owner.name === null ? null : `${owner.name}’s`;
  if (since.registered) return `Registered as a runner ${dayWords(since.at, now)}${whose === null ? '' : `, ${whose === 'Yours' ? 'by you' : `by ${owner.name}`}`}.`;
  return `${whose ?? 'A teammate’s'}, first signed in ${dayWords(since.at, now)}.`;
}
