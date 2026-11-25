/**
 * Things that need an admin which the dashboard reads beside `/api/attention`: a store check that found a problem, a
 * stored key that was rejected, and an automatic backup attempt that failed. Each is said as one "Needs you" item with
 * a way to finish it and, where the product has one, a way to decline it.
 */
import { storedKeyFailureTitle, storedKeyFailureWords, type RunnerFallbackReason } from '@goondocks/myco-shared/runner-fleet';
import type { SecretSlotName } from '@goondocks/myco-shared/secret-slots';
import { dateTimeWords } from '@goondocks/myco-shared/time-words';
import type { CheckStatus, MaintenanceAnswer, RecoveryStatus } from '../admin/health/wire';
import { CHECK_TITLES, findingWords, latestWords, outcomeWords } from '../admin/health/words';
import type { StatusResponse } from '../../lib/api';
import { AGENT_PAYER_ADDRESS, BACKUP_SCHEDULE_ADDRESS, BACKUPS_ADDRESS, CHECK_SCHEDULE_ADDRESS, STORED_KEYS_ADDRESS, UPKEEP_ADDRESS } from '../../routes/nav';
import type { NeedsYouWords } from './words';

export type ServerItem =
  | { kind: 'store_check'; tone: 'warn' | 'bad'; check: CheckStatus }
  | { kind: 'stored_key'; tone: 'bad'; slot: SecretSlotName; failure: RunnerFallbackReason; runners: string[]; waits: boolean }
  | { kind: 'backup_failed'; tone: 'bad'; recovery: Extract<RecoveryStatus, { supported: true }> };

/** What the server-side items read, and the reads among them that failed, by what they check. */
export interface ServerItemsRead {
  items: ServerItem[];
  pending: boolean;
  unchecked: string[];
}

/** Each store check whose last run found a problem or did not finish. A check running now is not judged until it ends. */
export function storeCheckItems(answer: MaintenanceAnswer | undefined): ServerItem[] {
  return (answer?.checks ?? []).filter((check) => !check.running && (check.latest?.state === 'findings' || check.latest?.state === 'failed'))
    .map((check) => ({ kind: 'store_check', tone: check.latest?.state === 'findings' ? 'bad' : 'warn', check }));
}

/**
 * One item per stored key a runner found rejected or missing: work that needs it waits, or runners fall back to their
 * own sign-in. A key that only ran out of credit while runners carry on with their sign-in is not asked about here.
 */
export function storedKeyItems(status: StatusResponse | undefined): ServerItem[] {
  const bySlot = new Map<SecretSlotName, Extract<ServerItem, { kind: 'stored_key' }>>();
  const note = (slot: SecretSlotName, failure: RunnerFallbackReason, runner: string, waits: boolean) => {
    const held = bySlot.get(slot) ?? { kind: 'stored_key' as const, tone: 'bad' as const, slot, failure, runners: [], waits: false };
    if (!held.runners.includes(runner)) held.runners.push(runner);
    bySlot.set(slot, { ...held, waits: held.waits || waits, failure: waits ? failure : held.failure });
  };
  for (const worker of status?.workers?.fleet ?? []) {
    const runner = worker.runnerDetails;
    if (runner === undefined || runner.state === 'removed') continue;
    for (const failure of runner.storedKeyFailures ?? []) note(failure.slot, failure.failure, runner.name, true);
    for (const fallback of runner.fallbackNotices ?? []) if (fallback.reason !== 'out_of_credit') note(fallback.slot, fallback.reason, runner.name, false);
  }
  return [...bySlot.values()].map((item) => ({ ...item, runners: [...item.runners].sort() }));
}

/** The automatic backup's last attempt, when it failed while automatic backups are on. */
export function backupFailedItems(answer: RecoveryStatus | undefined): ServerItem[] {
  if (answer?.supported !== true || 'unreadable' in answer.schedule || !answer.schedule.configured) return [];
  const failed = answer.schedule.latest?.stage === 'failed' || (answer.error != null && answer.error !== '');
  return failed ? [{ kind: 'backup_failed', tone: 'bad', recovery: answer }] : [];
}

const listed = (names: readonly string[]): string => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

export function serverItemWords(item: ServerItem): NeedsYouWords {
  switch (item.kind) {
    case 'store_check': {
      const latest = item.check.latest!;
      return {
        title: latest.state === 'findings' ? `${CHECK_TITLES[item.check.check]} found a problem` : `${CHECK_TITLES[item.check.check]} didn’t finish`,
        detail: latest.state === 'findings'
          ? `${findingWords(latest.findingCodes?.[0])} Found ${dateTimeWords(latest.finishedAt ?? latest.startedAt)}; what it found is listed under Upkeep.`
          : outcomeWords(latest, false),
        action: { label: 'Open upkeep', to: UPKEEP_ADDRESS },
        decline: { label: 'Change its schedule', to: CHECK_SCHEDULE_ADDRESS },
      };
    }
    case 'stored_key': {
      const title = storedKeyFailureTitle(item.failure, item.slot);
      return {
        title,
        detail: item.waits
          ? `${storedKeyFailureWords(item.failure, item.slot).replace(`${title}. `, '')} Seen by ${listed(item.runners)}.`
          : `${listed(item.runners)} ${item.runners.length === 1 ? 'is' : 'are'} using ${item.runners.length === 1 ? 'its' : 'their'} own sign-in instead, and return${item.runners.length === 1 ? 's' : ''} to the key when it works again.`,
        action: { label: 'Replace the key', to: STORED_KEYS_ADDRESS },
        decline: { label: 'Pay another way', to: AGENT_PAYER_ADDRESS },
      };
    }
    case 'backup_failed': {
      const schedule = item.recovery.schedule;
      return {
        title: 'The last automatic backup failed',
        detail: 'unreadable' in schedule ? 'The last attempt failed.' : latestWords(schedule, item.recovery.form),
        action: { label: 'Open backups', to: BACKUPS_ADDRESS },
        decline: { label: 'Change how often it runs', to: BACKUP_SCHEDULE_ADDRESS },
      };
    }
  }
}

/** A stable key for a server-side item, so a list keeps each in place across reads. */
export const serverItemKey = (item: ServerItem): string =>
  item.kind === 'store_check' ? `store_check:${item.check.check}` : item.kind === 'stored_key' ? `stored_key:${item.slot}` : 'backup_failed';
