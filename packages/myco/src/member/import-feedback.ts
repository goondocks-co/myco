import type { RefusedEntry } from './spool.js';

/** Minimum time between upload progress lines. */
export const IMPORT_PROGRESS_MS = 5_000;

export const importCause = (code: string): string =>
  IMPORT_STOP_WORDS[['body_cap', 'blob_cap', 'content_length'].includes(code) ? 'record_too_large' : code] ?? IMPORT_STOP_WORDS.refused!;

/** Counts records or session steps by their recovery cause. */
export function countImportCause(causes: Record<string, number>, cause: string): void {
  causes[cause] = (causes[cause] ?? 0) + 1;
}

/** Request-driven progress; no background timer or work survives the import. */
export function importProgress(now: () => number, emit: ((line: string) => void) | undefined, line: () => string): (force?: boolean) => void {
  let last = -Infinity;
  return (force = false) => {
    if (!force && now() - last < IMPORT_PROGRESS_MS) return;
    last = now();
    emit?.(`${line()}; safe to stop and run again`);
  };
}

/** New refusals plus the record still held from a previous attempt. */
export function importRefusals(log: readonly RefusedEntry[], seen: number, sessionId: string, endedBy: string): RefusedEntry[] {
  const met = log.slice(seen).filter((entry) => entry.sessionId === sessionId);
  return met.length > 0 || endedBy !== 'refused' ? met : log.filter((entry) => entry.sessionId === sessionId).slice(-1);
}

/** Import recovery words shared by every terminal entry point. */
export const IMPORT_STOP_WORDS: Readonly<Record<string, string>> = {
  parked: "the Deployment's storage quota refused the upload; ask its operator to update the Deployment, then run the command again",
  unauthorized: 'this machine is not signed in to that Deployment; run myco login <address>, then run the command again',
  route_missing: 'that Deployment does not offer import; ask its operator to update the Deployment, then run the command again',
  protocol: 'the Deployment and this machine use incompatible Myco versions; update both, then run the command again',
  retry: 'the request could not finish; check the connection and run the command again',
  refused: 'the Deployment refused a record; review the causes above, correct the record or ask its operator for help, then run the command again',
  unreachable: 'the connection did not recover in time; check the connection and run the command again',
  failed: 'some records could not be sent; fix the causes above and run the command again',
  deadline: 'the import reached its time limit; run the command again to resume safely',
  interrupted: 'you stopped the import; run the same command again to resume safely',
  missing_reference: 'spore history refers to a spore that is missing; restore that spore from the original vault, then run the command again',
  malformed_history: 'spore history has a shape the Deployment cannot read; keep the original vault for recovery',
  record_too_large: 'a record is too large to send; reduce that record or ask the operator to check the upload limit, then run the command again',
  invalid_field: 'a record has a value the Deployment does not accept; correct the source record, then run the command again',
  identity_mismatch: 'a session belongs to another machine; import it from the machine that captured it',
  unknown_field: 'the Deployment does not accept a field this Myco sends; update the Deployment, then run the command again',
  unknown_kind: 'the Deployment does not accept a record this Myco sends; update the Deployment, then run the command again',
};

export function importHttpCause(status: number | undefined, fromMyco = false): string {
  if (status === undefined) return 'a network request failed; check the connection and run the command again';
  if (status === 403 && !fromMyco) return 'HTTP 403 before Myco answered, likely a security rule; ask the operator to check Cloudflare Security Events and allow this upload, then run the command again';
  if (status === 403) return 'Myco refused access (HTTP 403); ask an owner or admin to check this machine’s access, then run the command again';
  if (status === 413) return IMPORT_STOP_WORDS.record_too_large!;
  if (status === 429) return 'HTTP 429: too many requests; wait and run the command again to resume safely';
  if (status >= 500) return `the Deployment answered HTTP ${status}; ask its operator to check its health, then run the command again`;
  return `the Deployment answered HTTP ${status}; ask its operator to check the request, then run the command again`;
}
