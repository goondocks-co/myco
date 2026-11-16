import { CaptureLossLedger } from '@myco/member/capture-observations.js';
import { REFUSED_HOOK_KINDS, readRefusedHook } from '@myco/member/refused-hooks.js';
import { listMissingMembershipsResult, MISSING_MEMBERSHIP_RETENTION_MS } from '@myco/member/no-membership.js';
import { CAPTURE_LOSS_FIELDS, CAPTURE_LOSS_DAYS, CAPTURE_LOSS_DAY_MS } from '@myco/member/capture-loss.js';
import { captureQueue } from '@myco/member/capture-health.js';
import { MemberSpool } from '@myco/member/capture-observations.js';
import { listSpoolDestinationsResult, routingKey } from '@myco/member/routing.js';
import type { RegistryEntry } from '@myco/member/registry.js';
import { observationInstant } from './home-observations.js';
import type { DoctorCheck } from './doctor-member.js';

/** Machine capture spans retained destinations as well as connected repositories. */
export function captureHealthChecks(home: string, entries: readonly RegistryEntry[], now: number): DoctorCheck[] {
  const listing = listSpoolDestinationsResult(home);
  const destinations = new Map([...listing.destinations, ...entries].map(entry => [routingKey(entry), entry]));
  const roots = new Map<string, string[]>();
  for (const entry of entries) roots.set(routingKey(entry), [...(roots.get(routingKey(entry)) ?? []), entry.root]);
  const location = (destination: { serverUrl: string; projectId: string }): string => {
    const paths = roots.get(routingKey(destination));
    return paths?.length === 1 ? paths[0] : paths?.length ? `${destination.projectId} (${paths.length} connected repositories: ${paths.join(', ')})` : destination.projectId;
  };
  let sessions = 0;
  let eventSessions = 0;
  let transcriptSessions = 0;
  let oldest = Infinity;
  let readable = listing.issues.length === 0;
  let lossesReadable = readable;
  let lastAt = 0;
  let undated = 0;
  const totals = { payloads: 0, plans: 0, records: 0, transcripts: 0, refusals: 0 };
  const locations: string[] = [];
  const drainCommands = new Set<string>();
  const lossLocations: string[] = [];
  const errors: string[] = listing.issues.map(issue => issue.reason);
  for (const destination of destinations.values()) {
    try {
      const spool = new MemberSpool(destination, { mycoHome: home, initialize: false, createReadLocks: false });
      const queue = captureQueue(spool);
      sessions += queue.sessions;
      eventSessions += queue.events;
      transcriptSessions += queue.transcripts;
      oldest = Math.min(oldest, queue.oldestAt ?? Infinity);
      readable &&= queue.readable;
      if (queue.sessions > 0 || !queue.readable) {
        locations.push(location(destination));
        drainCommands.add(roots.has(routingKey(destination)) ? '`myco member drain` from an affected repository' : `\`myco member drain --server ${destination.serverUrl} --project ${destination.projectId}\``);
      }
      try {
        const loss = new CaptureLossLedger(spool.dir).recent(now);
        for (const field of CAPTURE_LOSS_FIELDS) {
          totals[field] += loss[field];
          undated += loss.undated[field];
        }
        lastAt = Math.max(lastAt, loss.lastAt ?? 0);
        if (CAPTURE_LOSS_FIELDS.some(field => loss[field] > 0 || loss.undated[field] > 0)) lossLocations.push(location(destination));
      } catch (error) {
        lossesReadable = false;
        lossLocations.push(location(destination));
        errors.push(error instanceof Error ? error.message : String(error));
      }
      const refused = spool.readRefused();
      lossesReadable &&= refused.readable && refused.unreadableLines === 0;
      const start = (Math.floor(now / CAPTURE_LOSS_DAY_MS) - CAPTURE_LOSS_DAYS + 1) * CAPTURE_LOSS_DAY_MS;
      const recent = refused.entries.filter(entry => entry.at >= start && entry.at <= now);
      totals.refusals += recent.length;
      if (recent.length > 0) lossLocations.push(location(destination));
      lastAt = Math.max(lastAt, ...recent.map(entry => entry.at));
    } catch (error) {
      readable = lossesReadable = false;
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  const age = Number.isFinite(oldest) ? `${Math.max(0, Math.floor((now - oldest) / 60_000))} minutes ago` : 'unknown';
  const waiting = sessions === 0 && readable ? 'nothing waiting to deliver'
    : `${readable ? '' : 'at least '}${sessions} ${sessions === 1 ? 'session' : 'sessions'} waiting (${eventSessions} with events, ${transcriptSessions} with transcripts); oldest activity ${age}${readable ? '' : '; some capture could not be checked'}`;
  const lossLabels = { payloads: 'lost payload', plans: 'lost plan', records: 'damaged record', transcripts: 'unavailable transcript', refusals: 'delivery refusal' };
  const kinds = (Object.keys(totals) as Array<keyof typeof totals>).filter(kind => totals[kind] > 0).map(kind => `${totals[kind]} ${lossLabels[kind]}${totals[kind] === 1 ? '' : 's'}`);
  const refusalWords: string[] = [];
  for (const kind of REFUSED_HOOK_KINDS) {
    try {
      const record = readRefusedHook(kind, home, now, { prune: false, strict: true });
      if (record === null) continue;
      const words = { 'no-harness': 'hooks without a known agent', 'no-credential': 'hooks without sign-in selection', 'unknown-hook': 'unknown capture commands' };
      refusalWords.push(`${record.count} ${words[kind]} since ${observationInstant(record.firstAt)}`);
      lastAt = Math.max(lastAt, record.lastAt);
    } catch { lossesReadable = false; }
  }
  const refusedCommands = refusalWords.length > 0;
  const misses = listMissingMembershipsResult(home);
  lossesReadable &&= misses.readable && misses.unavailableRecords === 0;
  const activeMisses = misses.records.filter(record => now - record.lastAt <= MISSING_MEMBERSHIP_RETENTION_MS);
  if (activeMisses.length > 0) {
    const count = activeMisses.reduce((sum, record) => sum + record.count, 0);
    const first = activeMisses.reduce((first, record) => Math.min(first, record.firstAt), Infinity);
    lastAt = activeMisses.reduce((last, record) => Math.max(last, record.lastAt), lastAt);
    refusalWords.push(`${count} requests without a repository connection since ${observationInstant(first)}`);
  }
  const lossWords = `${kinds.length ? kinds.join(', ') : 'no recorded losses or delivery refusals'} in the last ${CAPTURE_LOSS_DAYS} UTC days (including today)${refusalWords.length ? `; ${refusalWords.join('; ')}` : ''}${lastAt ? `; most recent ${observationInstant(lastAt)}` : ''}${lossesReadable ? '' : '; some loss records could not be read'}`;
  const historical = totals.payloads + totals.plans + totals.records > 0;
  const advice = [
    ...(historical ? [`Recorded history cannot be repaired by a command; these counts clear after ${CAPTURE_LOSS_DAYS} UTC days.`] : []),
    ...(kinds.length ? ['Inspect `myco logs` from a connected repository; `myco doctor --all` lists destinations and local log files.'] : []),
    ...(totals.transcripts > 0 ? ['Check transcript file access; readable bytes can be delivered on a later pass.'] : []),
    ...(refusedCommands ? ['For refused capture commands, run `myco member provision --refresh`.'] : []),
    ...(activeMisses.length ? ['Connect missing repositories with `myco member join`.'] : []),
    ...(!lossesReadable ? ['Review the loss records named by `myco doctor --all`; delivery continues if accounting fails.'] : []),
  ].join(' ');
  const drain = drainCommands.size ? ` Run ${[...drainCommands].join('; ')}.` : '';
  return [
    { name: 'Capture waiting', status: sessions > 0 || !readable ? 'warn' : 'ok', fixable: false,
      detail: `${waiting}.${locations.length ? ` Repositories or Projects: ${locations.join(', ')}.` : ''}${errors.length ? ` ${errors.join('; ')}.` : ''}${drain}`,
      summary: `${waiting}.${drain}${drain ? ' Use \`myco doctor --all\` to locate queued capture.' : ''}` },
    { name: 'Capture losses', status: kinds.length || refusalWords.length || !lossesReadable ? 'warn' : 'ok', fixable: false,
      detail: `${lossWords}.${undated ? ` Historical note: ${undated} earlier losses have no dates; they do not indicate a current problem.` : ''}${lossLocations.length ? ` Affected repositories or Projects: ${[...new Set(lossLocations)].join(', ')}.` : ''} Refusal counts use the retained delivery log; one delivery may also have a recorded payload loss. Local logs: ${home}/logs/helper.log and each destination's refused.jsonl.${errors.length ? ` ${errors.join('; ')}.` : ''} ${advice}`.trim(),
      summary: `${lossWords}.${advice ? ` ${advice}` : ''}` },
  ];
}
