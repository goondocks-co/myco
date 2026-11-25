/**
 * Things that need an admin which the dashboard reads beside `/api/attention`: a store check that found a problem, a
 * stored key that was rejected, and an automatic backup attempt that failed. Each is said as one "Needs you" item with
 * a way to finish it and, where the product has one, a way to decline it.
 */
import { storedKeyFailureTitle, type RunnerFallbackReason } from '@goondocks/myco-shared/runner-fleet';
import type { SecretSlotName } from '@goondocks/myco-shared/secret-slots';
import { dateTimeWords, dayWords } from '@goondocks/myco-shared/time-words';
import type { CheckStatus, MaintenanceAnswer, MaintenanceOutcome, RecoveryStatus } from '../admin/health/wire';
import { attemptWords, CHECK_TITLES, findingWords, latestWords, outcomeWords } from '../admin/health/words';
import type { StatusResponse } from '../../lib/api';
import { BACKUP_SCHEDULE_ADDRESS, BACKUPS_ADDRESS, CHECK_SCHEDULE_ADDRESS, RUNNERS_PATH, runnerPath, STORED_KEYS_ADDRESS, UPKEEP_ADDRESS } from '../../routes/nav';
import type { AttentionItem } from './wire';
import type { NeedsYouWords } from './words';

type Producer = Extract<RecoveryStatus, { supported: true }>;
type Overdue = Extract<AttentionItem, { kind: 'backup_overdue' }>;

export type ServerItem =
  /** `latest` is the check's last finished outcome; `rerunning` says a new run of it is under way. */
  | { kind: 'store_check'; tone: 'warn' | 'bad'; check: CheckStatus['check']; latest: MaintenanceOutcome; rerunning: boolean }
  | { kind: 'stored_key'; tone: 'bad'; slot: SecretSlotName; failure: RunnerFallbackReason; runners: Array<{ id: string; name: string }>; waits: boolean }
  /** `overdue` is the attention answer's overdue backup, said with the failure as one item. */
  | { kind: 'backup_failed'; tone: 'bad'; recovery: Producer; overdue?: Overdue };

/** The reads the server-side items come from, by what each checks, as "Needs you" names them. */
export const SERVER_READS = { storeChecks: 'store checks', storedKeys: 'stored keys', backups: 'automatic backups' } as const;
export type ServerReadName = (typeof SERVER_READS)[keyof typeof SERVER_READS];

/** What the server-side items read: what they found, which reads are still on their way, and which failed. */
export interface ServerItemsRead {
  items: ServerItem[];
  /** Reads with no answer yet, by what they check. */
  checking: ServerReadName[];
  /** Reads that failed, by what they check; an item they found before stays listed. */
  unchecked: ServerReadName[];
}

const finished = (outcome: MaintenanceOutcome | null | undefined): outcome is MaintenanceOutcome =>
  outcome != null && (outcome.state === 'findings' || outcome.state === 'failed');

/**
 * Each store check whose last finished run found a problem or did not finish. While a new run of it is under way, the
 * finding `before` held for it stays, since the new run has not settled it.
 */
export function storeCheckItems(answer: MaintenanceAnswer | undefined, before: ReadonlyMap<string, MaintenanceOutcome> = new Map()): ServerItem[] {
  return (answer?.checks ?? []).flatMap((check): ServerItem[] => {
    const latest = check.running ? before.get(check.check) : check.latest;
    if (!finished(latest)) return [];
    return [{ kind: 'store_check', tone: latest.state === 'findings' ? 'bad' : 'warn', check: check.check, latest, rerunning: check.running }];
  });
}

/**
 * One item per stored key a runner found rejected or missing: work that needs it waits, or runners fall back to their
 * own sign-in. A key that only ran out of credit while runners carry on with their sign-in is not asked about here.
 */
export function storedKeyItems(status: StatusResponse | undefined): ServerItem[] {
  const bySlot = new Map<SecretSlotName, Extract<ServerItem, { kind: 'stored_key' }>>();
  const note = (slot: SecretSlotName, failure: RunnerFallbackReason, runner: { id: string; name: string }, waits: boolean) => {
    const held = bySlot.get(slot) ?? { kind: 'stored_key' as const, tone: 'bad' as const, slot, failure, runners: [], waits: false };
    const runners = held.runners.some((r) => r.id === runner.id) ? held.runners : [...held.runners, { id: runner.id, name: runner.name }];
    bySlot.set(slot, { ...held, runners, waits: held.waits || waits, failure: waits ? failure : held.failure });
  };
  for (const worker of status?.workers?.fleet ?? []) {
    const runner = worker.runnerDetails;
    if (runner === undefined || runner.state === 'removed') continue;
    for (const failure of runner.storedKeyFailures ?? []) note(failure.slot, failure.failure, runner, true);
    for (const fallback of runner.fallbackNotices ?? []) if (fallback.reason !== 'out_of_credit') note(fallback.slot, fallback.reason, runner, false);
  }
  return [...bySlot.values()].map((item) => ({ ...item, runners: [...item.runners].sort((a, b) => a.name.localeCompare(b.name)) }));
}

/**
 * The automatic backup's last attempt, when it ended failed: its terminal stage, never a refusal it is still retrying.
 * With the schedule readable, automatic backups must be on; with it unreadable, the attempt the producer reports counts.
 */
export function backupFailedItems(answer: RecoveryStatus | undefined): ServerItem[] {
  if (answer?.supported !== true) return [];
  const schedule = 'unreadable' in answer.schedule ? null : answer.schedule;
  const failed = schedule === null ? answer.stage === 'failed' : schedule.configured && schedule.latest?.stage === 'failed';
  return failed ? [{ kind: 'backup_failed', tone: 'bad', recovery: answer }] : [];
}

/** Whether the automatic backup's schedule could not be read, so whether it is overdue or failing is not known. */
export const backupUnchecked = (answer: RecoveryStatus | undefined): boolean => answer?.supported === true && 'unreadable' in answer.schedule;

/**
 * The items "Needs you" lists and counts: each attention item a person must act on and each server-side item, an
 * overdue backup said once with a failed attempt.
 */
export function needsItems(attention: readonly AttentionItem[], server: readonly ServerItem[]): { attention: AttentionItem[]; server: ServerItem[] } {
  const overdue = attention.find((item): item is Overdue => item.kind === 'backup_overdue');
  if (overdue === undefined || !server.some((item) => item.kind === 'backup_failed')) return { attention: [...attention], server: [...server] };
  return {
    attention: attention.filter((item) => item !== overdue),
    server: server.map((item) => (item.kind === 'backup_failed' ? { ...item, overdue } : item)),
  };
}

const listed = (names: readonly string[]): string => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/** Who pays for an agent on the runners a key failed on: one runner's own page, or the Runners list for several. */
const payerLink = (runners: ReadonlyArray<{ id: string; name: string }>) => (runners.length === 1
  ? { label: `Change who pays on ${runners[0]!.name}`, to: runnerPath(runners[0]!.id) }
  : { label: 'Change who pays on Runners', to: RUNNERS_PATH });

export function serverItemWords(item: ServerItem): NeedsYouWords {
  switch (item.kind) {
    case 'store_check': {
      const title = CHECK_TITLES[item.check];
      const rerun = item.rerunning ? ' A new check is running now.' : '';
      return {
        title: item.latest.state === 'findings' ? `${title} found a problem` : `${title} didn’t finish`,
        detail: item.latest.state === 'findings'
          ? `${findingWords(item.latest.findingCodes?.[0])} Found ${dateTimeWords(item.latest.finishedAt ?? item.latest.startedAt)}; what it found is listed under Upkeep.${rerun}`
          : `${outcomeWords(item.latest, false)}${rerun}`,
        action: { label: 'See what it found, and run it again', to: UPKEEP_ADDRESS },
        decline: { label: 'Change when it runs', to: CHECK_SCHEDULE_ADDRESS },
      };
    }
    case 'stored_key': {
      const names = listed(item.runners.map((runner) => runner.name));
      return {
        title: storedKeyFailureTitle(item.failure, item.slot),
        detail: item.waits
          ? `Work that needs this key waits. Seen by ${names}.`
          : `${names} ${item.runners.length === 1 ? 'is' : 'are'} using ${item.runners.length === 1 ? 'its' : 'their'} own sign-in instead, and return${item.runners.length === 1 ? 's' : ''} to the key when it works again.`,
        action: { label: item.failure === 'no_key' ? 'Add a key' : 'Replace the key', to: STORED_KEYS_ADDRESS },
        decline: payerLink(item.runners),
      };
    }
    case 'backup_failed': {
      const schedule = 'unreadable' in item.recovery.schedule ? null : item.recovery.schedule;
      const attempt = schedule === null ? attemptWords(item.recovery.attempt, item.recovery.stage, item.recovery.form) : latestWords(schedule, item.recovery.form);
      const overdue = item.overdue === undefined ? '' : item.overdue.lastBackupAt === null ? ' No backup has completed yet.' : ` None has completed since ${dayWords(item.overdue.lastBackupAt)}.`;
      return {
        title: 'The last automatic backup failed',
        detail: `${attempt}${overdue}`,
        action: { label: 'See why, in Backups', to: BACKUPS_ADDRESS },
        decline: { label: 'Change how often it runs', to: BACKUP_SCHEDULE_ADDRESS },
      };
    }
  }
}

/** A stable key for a server-side item, so a list keeps each in place across reads. */
export const serverItemKey = (item: ServerItem): string =>
  item.kind === 'store_check' ? `store_check:${item.check}` : item.kind === 'stored_key' ? `stored_key:${item.slot}` : 'backup_failed';
