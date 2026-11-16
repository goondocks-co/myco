import crypto from 'node:crypto';
import path from 'node:path';
import { withFileLockSync } from '../utils/lifecycle-lock.js';
import { ensurePrivateFile, pathIsAbsent, readPrivateJson, writePrivateFileAtomic } from './store.js';
import type { SessionState } from './session-state.js';

export const CAPTURE_LOSS_FILE = 'capture-losses.json';
export const MAX_RECENT_CAPTURE_LOSSES = 500;
export type CaptureLossKind = 'payload' | 'plan' | 'record' | 'transcript';
export const CAPTURE_LOSS_DAY_MS = 24 * 60 * 60 * 1000;
export const CAPTURE_LOSS_DAYS = 7;
const RETAIN_LOSS_DAYS = 30;
export interface CaptureLoss { key: string; kind: CaptureLossKind; at: number; count?: number }
export type CaptureLossTotals = { payloads: number; plans: number; records: number; transcripts: number };
type DatedLosses = CaptureLossTotals & { day: number; lastAt: number };
type ImportedDay = [day: number, payloads: number, plans: number, records: number, transcripts: number];
type ImportedLosses = CaptureLossTotals & { key: string; days?: ImportedDay[]; undated?: CaptureLossTotals };
interface Losses extends CaptureLossTotals { version: 1; recent: string[]; lastAt?: number; imports?: ImportedLosses[]; days?: DatedLosses[]; undated?: CaptureLossTotals }
export const CAPTURE_LOSS_FIELDS = ['payloads', 'plans', 'records', 'transcripts'] as const;
const validCaptureLossTotals = (value: CaptureLossTotals): boolean => value !== null && typeof value === 'object' && CAPTURE_LOSS_FIELDS.every((field) => Number.isSafeInteger(value[field]) && value[field] >= 0);
const addCount = (previous: number, added: number): number => Math.min(Number.MAX_SAFE_INTEGER, previous + added);
const emptyTotals = (): CaptureLossTotals => ({ payloads: 0, plans: 0, records: 0, transcripts: 0 });
const validDays = (days: DatedLosses[] | undefined): boolean => days === undefined || Array.isArray(days) && days.every(day => validCaptureLossTotals(day) && Number.isSafeInteger(day.day) && Number.isFinite(day.lastAt));

/** Bounded project accounting, independent of session-state retirement and refusal-log rotation. */
export class CaptureLossLedger {
  constructor(private readonly dir: string) {}

  read(): Losses {
    const file = path.join(this.dir, CAPTURE_LOSS_FILE);
    const read = readPrivateJson<Losses>(file);
    if (!read.ok && read.reason === 'missing' && pathIsAbsent(file)) return { version: 1, ...emptyTotals(), recent: [] };
    if (!read.ok) throw new Error(`Capture loss counts could not be read (${read.reason})`);
    const value = read.value;
    if (value && typeof value === 'object') {
      value.records ??= 0;
      value.transcripts ??= 0;
      if (Array.isArray(value.imports)) for (const entry of value.imports) {
        if (entry !== null && typeof entry === 'object') entry.transcripts ??= 0;
      }
    }
    if (value?.version !== 1 || !validCaptureLossTotals(value) || !Array.isArray(value.recent)
      || value.recent.some((key) => typeof key !== 'string')
      || !validDays(value.days)
      || (value.undated !== undefined && !validCaptureLossTotals(value.undated))
      || (value.imports !== undefined && (!Array.isArray(value.imports) || value.imports.some((entry) => !entry || typeof entry.key !== 'string' || !validCaptureLossTotals(entry) || entry.days !== undefined && (!Array.isArray(entry.days) || entry.days.some(day => !Array.isArray(day) || day.length !== CAPTURE_LOSS_FIELDS.length + 1 || day.some(n => !Number.isSafeInteger(n)))) || entry.undated !== undefined && !validCaptureLossTotals(entry.undated))))) throw new Error('Capture loss counts could not be read');
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
        const field: keyof CaptureLossTotals = `${loss.kind}s`;
        const day = Math.floor(loss.at / CAPTURE_LOSS_DAY_MS);
        if (!Number.isSafeInteger(day) || !Number.isFinite(loss.at) || Number.isNaN(new Date(loss.at).getTime())) throw new Error('Invalid capture loss time');
        const bucket = counts.days!.find(entry => entry.day === day);
        const dated = bucket ?? { day, lastAt: loss.at, payloads: 0, plans: 0, records: 0, transcripts: 0 };
        dated[field] = addCount(dated[field], count);
        dated.lastAt = Math.max(dated.lastAt, loss.at);
        if (!bucket) counts.days!.push(dated);
        counts[field] = addCount(counts[field], count);
        counts.lastAt = Math.max(counts.lastAt ?? loss.at, loss.at);
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
      if (counts.days === undefined) {
        counts.undated = { payloads: counts.payloads, plans: counts.plans, records: counts.records, transcripts: counts.transcripts };
        counts.days = [];
      }
      counts.undated ??= emptyTotals();
      if (!change(counts)) return;
      const latestDay = Math.max(...counts.days.map(entry => entry.day));
      counts.days = counts.days.filter(entry => entry.day > latestDay - RETAIN_LOSS_DAYS);
      counts.recent = counts.recent.slice(-MAX_RECENT_CAPTURE_LOSSES);
      if (counts.imports) counts.imports = counts.imports.slice(-MAX_RECENT_CAPTURE_LOSSES);
      writePrivateFileAtomic(path.join(this.dir, CAPTURE_LOSS_FILE), JSON.stringify(counts));
    });
  }

  /** Import a held ledger before its repository's migration removes it. */
  transferFrom(sourceDir: string, stableIdentity: string): void {
    const source = new CaptureLossLedger(sourceDir).read();
    if (CAPTURE_LOSS_FIELDS.every((field) => source[field] === 0)) return;
    const key = crypto.createHash('sha256').update(stableIdentity).digest('hex');
    this.mutate((counts) => {
      const previous = counts.imports?.find((entry) => entry.key === key);
      if (CAPTURE_LOSS_FIELDS.every((field) => source[field] <= (previous?.[field] ?? 0))) return false;
      const dated = source.days !== undefined && (previous === undefined || previous.days !== undefined);
      for (const field of CAPTURE_LOSS_FIELDS) {
        const added = Math.max(0, source[field] - (previous?.[field] ?? 0));
        counts[field] = addCount(counts[field], added);
        const undated = dated ? Math.max(0, (source.undated?.[field] ?? 0) - (previous?.undated?.[field] ?? 0)) : added;
        counts.undated![field] = addCount(counts.undated![field], undated);
      }
      if (dated) for (const day of source.days!) {
        const prior = previous?.days?.find(entry => entry[0] === day.day);
        const held = counts.days!.find(entry => entry.day === day.day);
        const merged = held ?? { ...emptyTotals(), day: day.day, lastAt: day.lastAt };
        for (const [index, field] of CAPTURE_LOSS_FIELDS.entries()) merged[field] = addCount(merged[field], Math.max(0, day[field] - (prior?.[index + 1] ?? 0)));
        merged.lastAt = Math.max(merged.lastAt, day.lastAt);
        if (!held) counts.days!.push(merged);
      }
      counts.imports = [...(counts.imports ?? []).filter((entry) => entry.key !== key), {
        key, ...Object.fromEntries(CAPTURE_LOSS_FIELDS.map(field => [field, Math.max(previous?.[field] ?? 0, source[field])])) as CaptureLossTotals,
        days: source.days?.map(day => [day.day, day.payloads, day.plans, day.records, day.transcripts]),
        undated: source.undated && CAPTURE_LOSS_FIELDS.some(field => source.undated![field] > 0) ? source.undated : undefined,
      }];
      counts.lastAt = Math.max(counts.lastAt ?? 0, source.lastAt ?? 0);
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
