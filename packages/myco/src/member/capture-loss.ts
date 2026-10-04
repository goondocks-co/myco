import crypto from 'node:crypto';
import path from 'node:path';
import { withFileLockSync } from '../utils/lifecycle-lock.js';
import { ensurePrivateFile, pathIsAbsent, readPrivateJson, writePrivateFileAtomic } from './store.js';
import type { SessionState } from './session-state.js';

export const CAPTURE_LOSS_FILE = 'capture-losses.json';
export const MAX_RECENT_CAPTURE_LOSSES = 500;
export type CaptureLossKind = 'payload' | 'plan' | 'record';
export interface CaptureLoss { key: string; kind: CaptureLossKind; at: number; count?: number }
type Totals = { payloads: number; plans: number; records: number };
interface Losses extends Totals { version: 1; recent: string[]; lastAt?: number; imports?: Array<Totals & { key: string }> }
const LOSS_FIELDS = ['payloads', 'plans', 'records'] as const;
const validTotals = (value: Totals): boolean => LOSS_FIELDS.every((field) => Number.isSafeInteger(value[field]) && value[field] >= 0);

/** Bounded project accounting, independent of session-state retirement and refusal-log rotation. */
export class CaptureLossLedger {
  constructor(private readonly dir: string) {}

  read(): Losses {
    const file = path.join(this.dir, CAPTURE_LOSS_FILE);
    const read = readPrivateJson<Losses>(file);
    if (!read.ok && read.reason === 'missing' && pathIsAbsent(file)) return { version: 1, payloads: 0, plans: 0, records: 0, recent: [] };
    if (!read.ok) throw new Error(`Capture loss counts could not be read (${read.reason})`);
    const value = read.value;
    if (value && typeof value === 'object') value.records ??= 0;
    if (value?.version !== 1 || !validTotals(value) || !Array.isArray(value.recent)
      || value.recent.some((key) => typeof key !== 'string')
      || (value.imports !== undefined && (!Array.isArray(value.imports) || value.imports.some((entry) => !entry || typeof entry.key !== 'string' || !validTotals(entry))))) throw new Error('Capture loss counts could not be read');
    return value;
  }

  record(losses: readonly CaptureLoss[]): void {
    if (losses.length === 0) return;
    this.mutate((counts) => {
      let changed = false;
      for (const loss of losses) {
        const count = loss.count ?? 1;
        if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid capture loss count');
        if (count === 0) continue;
        const key = crypto.createHash('sha256').update(`${loss.kind}:${loss.key}`).digest('hex');
        if (counts.recent.includes(key)) continue;
        const field = loss.kind === 'payload' ? 'payloads' : loss.kind === 'plan' ? 'plans' : 'records';
        counts[field] = Math.min(Number.MAX_SAFE_INTEGER, counts[field] + count);
        counts.lastAt = loss.at;
        counts.recent.push(key);
        changed = true;
      }
      return changed;
    });
  }

  private mutate(change: (counts: Losses) => boolean): void {
    const lock = path.join(this.dir, '.capture-losses.lock');
    ensurePrivateFile(lock);
    withFileLockSync(lock, () => {
      const counts = this.read();
      if (!change(counts)) return;
      counts.recent = counts.recent.slice(-MAX_RECENT_CAPTURE_LOSSES);
      if (counts.imports) counts.imports = counts.imports.slice(-MAX_RECENT_CAPTURE_LOSSES);
      writePrivateFileAtomic(path.join(this.dir, CAPTURE_LOSS_FILE), JSON.stringify(counts));
    });
  }

  /** Import a held ledger before its repository's migration removes it. */
  transferFrom(sourceDir: string, stableIdentity: string): void {
    const source = new CaptureLossLedger(sourceDir).read();
    if (LOSS_FIELDS.every((field) => source[field] === 0)) return;
    const key = crypto.createHash('sha256').update(stableIdentity).digest('hex');
    this.mutate((counts) => {
      const previous = counts.imports?.find((entry) => entry.key === key) ?? { payloads: 0, plans: 0, records: 0 };
      if (LOSS_FIELDS.every((field) => source[field] <= previous[field])) return false;
      for (const field of LOSS_FIELDS) counts[field] = Math.min(Number.MAX_SAFE_INTEGER, counts[field] + Math.max(0, source[field] - previous[field]));
      counts.imports = [...(counts.imports ?? []).filter((entry) => entry.key !== key), {
        key, payloads: Math.max(previous.payloads, source.payloads), plans: Math.max(previous.plans, source.plans), records: Math.max(previous.records, source.records),
      }];
      counts.lastAt = source.lastAt ?? Date.now();
      return true;
    });
  }
}

/** Queue loss accounting with the receipt that gives the capture an explicit disposition. */
export function recordSessionLoss(state: SessionState, key: string, kind: CaptureLossKind, at: number): void {
  (state.pendingLosses ??= []).push({ key, kind, at });
}

export function readCaptureLoss(dir: string): { readable: true; payloads: number; plans: number; records: number } | { readable: false } {
  try {
    const { payloads, plans, records } = new CaptureLossLedger(dir).read();
    return { readable: true, payloads, plans, records };
  } catch {
    process.stderr.write('[myco] member: capture loss counts could not be read\n');
    return { readable: false };
  }
}
