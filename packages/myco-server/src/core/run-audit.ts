/**
 * The audit a run's report carries: the agent's own account of how it did the task.
 *
 * Five fields: the steps taken, the files and areas examined, the commands run, each failure with its recovery, and
 * the reasoning behind the outcome. An audit is refused only where it says nothing a reader can check — it is not an
 * object, or it names no step or no reasoning — and is judged by its shape alone, never by what it says. Everything
 * else is repaired rather than refused: an undeclared field is dropped, an empty or non-text entry is dropped, a long
 * string is cut, a list past its bound is cut with the entries cut counted in `omitted`, and a failure given as text
 * reads as one with no recovery. The commands are kept in the allowed shape of a command (`commandShape`), and each
 * file examined only where it is a path (`pathShape`), anything else reading `…`, so neither ever holds a body, a
 * flag's value, prose or a credential; every string is stored with known
 * access-key shapes masked. The stored audit holds the six declared fields and nothing else.
 */
import { commandShape, pathShape } from '@goondocks/myco-shared/command-shape';
import { redactSecrets } from '@goondocks/myco-shared/redact-secrets';

export interface RunAuditFailure {
  what: string;
  recovery: string;
}

export interface RunAudit {
  steps: string[];
  examined: string[];
  commands: string[];
  failures: RunAuditFailure[];
  reasoning: string;
  /** How many entries past their list's bound were cut. */
  omitted: number;
}

const MAX_ITEM_CHARS = 500;
const MAX_REASONING_CHARS = 4_000;
const MAX_STEPS = 60;
const MAX_LISTED = 100;
const MAX_FAILURES = 40;
/** The most characters a serialized audit offered as text may hold before it is read. */
export const MAX_AUDIT_CHARS = 256 * 1024;

export const RUN_AUDIT_FIELDS = ['steps', 'examined', 'commands', 'failures', 'reasoning'] as const;

/** What a report whose audit is refused is told to file: the fields, their shape and their bounds. */
export const RUN_AUDIT_SHAPE = `audit is an object of steps (what you did, in order; at least one), examined (the files and areas you read), commands (the commands you ran), failures (each failure as {what, recovery}) and reasoning (why the outcome is what it is; required); up to ${MAX_STEPS} steps, ${MAX_LISTED} files or commands and ${MAX_FAILURES} failures, each entry at most ${MAX_ITEM_CHARS} characters`;

/** What one audit answered: the stored shape and the repairs that reach it, or why it is refused. */
export type AuditParse = { ok: true; audit: RunAudit; repairs: string[] } | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** One line of prose, cut to `max`, with known access-key shapes masked; null for an empty one. */
function prose(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const folded = redactSecrets(value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim());
  if (folded === '') return null;
  return folded.length > max ? `${folded.slice(0, max - 1)}…` : folded;
}

/** A file examined as a path, or `…` where the entry is anything else; null for none. */
function examinedPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return prose(pathShape(value) ?? '…', MAX_ITEM_CHARS);
}

/** A command in the allowed shape of a command, cut to the item bound; null for none. */
function shaped(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const shape = commandShape(value);
  return shape === null ? null : prose(shape, MAX_ITEM_CHARS);
}

class Repair {
  readonly notes: string[] = [];
  omitted = 0;

  /** A list as stored: a lone value read as a list of one, each entry kept by `keep`, and the list cut at `max`. */
  list<T>(field: string, value: unknown, max: number, keep: (entry: unknown) => T | null): T[] {
    if (value === undefined || value === null) return [];
    const entries = Array.isArray(value) ? value : [value];
    if (!Array.isArray(value)) this.notes.push(`${field} read as a list of one`);
    const kept = entries.map(keep).filter((entry): entry is T => entry !== null);
    if (kept.length < entries.length) this.notes.push(`${field}: ${entries.length - kept.length} empty or unreadable entries dropped`);
    if (kept.length <= max) return kept;
    this.omitted += kept.length - max;
    this.notes.push(`${field}: ${kept.length - max} entries past ${max} cut`);
    return kept.slice(0, max);
  }
}

/** A failure as stored: text reads as a failure with no recovery, and an object keeps its what and recovery alone. */
function failureOf(entry: unknown): RunAuditFailure | null {
  if (typeof entry === 'string') {
    const what = prose(entry, MAX_ITEM_CHARS);
    return what === null ? null : { what, recovery: '' };
  }
  if (!isRecord(entry)) return null;
  const what = prose(entry.what, MAX_ITEM_CHARS);
  return what === null ? null : { what, recovery: prose(entry.recovery, MAX_ITEM_CHARS) ?? '' };
}

/** The audit as stored, from an object or its serialized form, with the repairs made; or why it is refused. */
export function parseRunAudit(value: unknown): AuditParse {
  let raw = value;
  if (typeof raw === 'string') {
    if (raw.length > MAX_AUDIT_CHARS) return { ok: false, error: `audit is at most ${MAX_AUDIT_CHARS} characters` };
    try { raw = JSON.parse(raw); } catch { return { ok: false, error: 'audit is not a readable object' }; }
  }
  if (!isRecord(raw)) return { ok: false, error: 'audit must be an object' };
  const repair = new Repair();
  const steps = repair.list('steps', raw.steps, MAX_STEPS, (entry) => prose(entry, MAX_ITEM_CHARS));
  if (steps.length === 0) return { ok: false, error: 'audit is missing steps' };
  const reasoning = prose(raw.reasoning, MAX_REASONING_CHARS);
  if (reasoning === null) return { ok: false, error: 'audit is missing reasoning' };
  if (typeof raw.reasoning === 'string' && raw.reasoning.trim().length > MAX_REASONING_CHARS) repair.notes.push(`reasoning cut to ${MAX_REASONING_CHARS} characters`);
  const unknown = Object.keys(raw).filter((key) => !(RUN_AUDIT_FIELDS as readonly string[]).includes(key));
  if (unknown.length > 0) repair.notes.push(`unknown fields dropped: ${unknown.join(', ')}`);
  const audit: RunAudit = {
    steps,
    examined: repair.list('examined', raw.examined, MAX_LISTED, examinedPath),
    commands: repair.list('commands', raw.commands, MAX_LISTED, shaped),
    failures: repair.list('failures', raw.failures, MAX_FAILURES, failureOf),
    reasoning,
    omitted: repair.omitted,
  };
  return { ok: true, audit, repairs: repair.notes };
}

/** A stored audit as a reader is served it, or null where the report carries none it can read. */
export function storedAudit(raw: string | null): RunAudit | null {
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  const read = parseRunAudit(parsed);
  if (!read.ok) return null;
  const omitted = isRecord(parsed) && typeof parsed.omitted === 'number' && Number.isSafeInteger(parsed.omitted) && parsed.omitted >= 0 ? parsed.omitted : 0;
  return { ...read.audit, omitted };
}

/** The sentence every task's close step carries, telling the agent what the report's audit holds and what to do when it is refused. */
export const RUN_AUDIT_INSTRUCTION = 'Every report carries `audit`, your account of this pass for the people who check it: `steps` (what you did, in order), `examined` (the files and areas you read), `commands` (the commands you ran), `failures` (each call or step that failed, as {"what", "recovery"}) and `reasoning` (why the outcome is what it is). Use empty lists where nothing applies. A report without its audit cannot close the run as completed. If the report answers with an error, fix the audit and report again, then stop.';
