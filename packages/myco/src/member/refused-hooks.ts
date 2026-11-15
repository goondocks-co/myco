/**
 * The record a hook leaves when its own command refuses it: a missing harness, a missing credential source, or an
 * unknown hook name. These refusals exit 0; `myco member status` and `myco doctor` report their counts under the home
 * the hook resolved.
 *
 * One file per kind under `<MYCO_HOME>/member/refused-hooks/`, in the member's private store. Counting is best-effort:
 * racing hooks may merge to one increment, and a write that fails never costs the hook. A record not added to in
 * `REFUSED_HOOK_RETENTION_MS` is no longer reported, and the reader that finds one removes it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensureMemberDir, memberRoot, readPrivateJson, writePrivateFileAtomic } from './store.js';

export const REFUSED_HOOKS_DIRNAME = 'refused-hooks';
export const REFUSED_HOOK_VERSION = 1;
/** How long a kind of refusal is reported after its last one. */
export const REFUSED_HOOK_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Why a hook's own command refused it. */
export const REFUSED_HOOK_KINDS = ['no-harness', 'no-credential', 'unknown-hook'] as const;
export type RefusedHookKind = typeof REFUSED_HOOK_KINDS[number];

export interface RefusedHookRecord {
  version: number;
  kind: RefusedHookKind;
  count: number;
  firstAt: number;
  lastAt: number;
  /** The hook verb refused last (`session-start`, `stop`, …). */
  lastHook?: string;
}

const recordPath = (kind: RefusedHookKind, mycoHome: string): string =>
  path.join(memberRoot(mycoHome), REFUSED_HOOKS_DIRNAME, `${kind}.json`);

/** Count one hook its own command refused. Never throws. */
export function recordRefusedHook(kind: RefusedHookKind, opts: { mycoHome: string; now: number; hook: string }): void {
  try {
    const previous = readRefusedHook(kind, opts.mycoHome, opts.now);
    const record: RefusedHookRecord = {
      version: REFUSED_HOOK_VERSION,
      kind,
      count: (previous?.count ?? 0) + 1,
      firstAt: previous?.firstAt ?? opts.now,
      lastAt: opts.now,
      lastHook: opts.hook,
    };
    const file = recordPath(kind, opts.mycoHome);
    ensureMemberDir(path.dirname(file), opts.mycoHome);
    writePrivateFileAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // A refusal that cannot even count itself must still not fail the harness.
  }
}

/** This kind's record while it is reported: null when there is none, it is past retention (removed), or unreadable. */
export function readRefusedHook(kind: RefusedHookKind, mycoHome: string, now: number, opts: { prune?: boolean; strict?: boolean } = {}): RefusedHookRecord | null {
  const file = recordPath(kind, mycoHome);
  const read = readPrivateJson<RefusedHookRecord>(file);
  if (!read.ok) {
    if (opts.strict && read.reason !== 'missing') throw new Error(`refused-hook record ${file} could not be read`);
    return null;
  }
  const value = read.value;
  if (value?.version !== REFUSED_HOOK_VERSION || value.kind !== kind || !Number.isSafeInteger(value.count) || value.count <= 0
    || typeof value.firstAt !== 'number' || typeof value.lastAt !== 'number') {
    if (opts.strict) throw new Error(`refused-hook record ${file} is malformed`);
    return null;
  }
  if (now - value.lastAt > REFUSED_HOOK_RETENTION_MS) {
    try { if (opts.prune !== false) fs.rmSync(file, { force: true }); } catch { /* reported as none either way */ }
    return null;
  }
  return value;
}

/** What a refusal kind means, in the words status and doctor use. */
export function refusedHookWords(record: RefusedHookRecord): string {
  const reasons: Record<RefusedHookKind, string> = {
    'no-harness': 'named no harness Myco knows (`--symbiont <harness>`)',
    'no-credential': 'declared no credential source (`--credential registry|env`)',
    'unknown-hook': 'named an unknown hook',
  };
  return `${record.count} hook invocation(s) on this machine ${reasons[record.kind]}, so captured nothing`;
}
