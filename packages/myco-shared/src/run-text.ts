/**
 * What a run's record keeps of text a harness, a worker or an agent wrote.
 *
 * Nothing stored with a run may hold file contents, command output, a secret, a token or an environment value. Free
 * text reaches a run from two kinds of writer, and each is held to one rule here, applied by the worker that writes it
 * and again by the Deployment that stores it:
 *
 * - **A diagnostic** — a harness's stderr, its in-band error, the worker's own failure — is stored as a coded reason
 *   alone (`RunDiagnosticCode`), with the exit code and signal where the process gave them and, for a refused call,
 *   the tool identifiers it named. The code is read from structured fields first, then from the harness's own words
 *   by the patterns its manifest declares (`runner.diagnostics`), then from its exit status. The words themselves are
 *   kept only in the worker's local diagnostics log, never sent. The Deployment keeps a run error only where it parses
 *   as a sentence this module writes (`shapeRunError`), and codes anything else again from its words.
 * - **Agent prose** — a report's summary and details, and an audit's steps, reasoning and failures — is the agent's
 *   own account of its work, the point of the audit, so it cannot be allow-listed. It is stored bounded and masked
 *   (`agentProse`): code-fence and here-document bodies read `…`; a URL reads as its scheme and host; a `NAME=value`
 *   assignment, a key-like or UUID-like word, credentials before an `@`, and the word after a secret-named flag or
 *   label read `…`; known access-key shapes are masked (`redactSecrets`). What is left is the agent's own words,
 *   stored with the run and kept as long as the run is.
 */

import { commandShape, identifierShape, keyLike, urlShape, ZERO_WIDTH } from './command-shape.js';
import { redactSecrets } from './redact-secrets.js';
import { RUNNER_HARNESSES } from './runner-harnesses.generated.js';

const ELIDED = '…';

// ---------------------------------------------------------------------------------------------------------------
// Diagnostics: a coded reason, never the words.
// ---------------------------------------------------------------------------------------------------------------

/** The reasons a harness's own words can be read as, by the patterns its manifest declares. */
export const PATTERNED_DIAGNOSTIC_CODES = ['login_missing', 'rate_limited', 'model_refused', 'timed_out'] as const;

/**
 * Why a harness stopped with an error, as a code: one its words are read as (`PATTERNED_DIAGNOSTIC_CODES`); a process
 * that exited non-zero or on a signal with no other reason (`crashed`); one its driver knows from the stream's
 * structure (a granted call refused, the claimed profile unapplied, the run's tools unlisted, a session opened outside
 * the run's agent, a reply the protocol does not name, a launch that could not be prepared); or none of these
 * (`harness_error`).
 */
export const RUN_DIAGNOSTIC_CODES = [
  ...PATTERNED_DIAGNOSTIC_CODES,
  'crashed', 'permission_refused', 'profile_unapplied', 'tools_unlisted', 'session_unasked', 'protocol_error', 'launch_failed', 'harness_error',
] as const;
export type RunDiagnosticCode = (typeof RUN_DIAGNOSTIC_CODES)[number];
export type PatternedDiagnosticCode = (typeof PATTERNED_DIAGNOSTIC_CODES)[number];

/** Why a worker did not start a run's harness. */
export const WORKER_START_CODES = ['harness_not_offered', 'no_driver', 'profile_unapplied', 'no_instruction'] as const;
export type WorkerStartCode = (typeof WORKER_START_CODES)[number];

/** Why a worker stopped driving a run it had started: its repository could not be prepared, or anything else. */
export const WORKER_FAILURE_CODES = ['repository_unprepared', 'worker_error'] as const;
export type WorkerFailureCode = (typeof WORKER_FAILURE_CODES)[number];

/** The agent protocol's stop reasons, which every driver answers in. */
export const RUN_STOP_REASONS = ['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled', 'error'] as const;
export type RunStopReason = (typeof RUN_STOP_REASONS)[number];

/** A harness's error, coded: the reason, the exit code and signal where its process gave them, and the tools a refusal named. */
export interface RunDiagnostic {
  code: RunDiagnosticCode;
  exitCode?: number;
  signal?: string;
  names?: readonly string[];
}

/** What a driver knows of how a harness ended: a code where its stream's structure says one, its words, and its exit status. */
export interface HarnessEnding {
  code?: RunDiagnosticCode;
  names?: readonly string[];
  /** The harness's own words; read for a code here and kept only in the worker's local log. */
  detail?: string | null;
  exitCode?: number | null;
  signal?: string | null;
}

/** How many tool names a refusal's reason carries. */
const MAX_NAMES = 8;
/** How much of a harness's words its patterns read. */
const MAX_READ_CHARS = 64 * 1024;
const SIGNAL = /^SIG[A-Z0-9]{1,12}$/;
const isCode = <T extends string>(codes: readonly T[], value: string): value is T => (codes as readonly string[]).includes(value);

type Patterns = ReadonlyMap<string, ReadonlyArray<{ code: PatternedDiagnosticCode; pattern: RegExp }>>;
let compiled: Patterns | null = null;

/** Each harness's patterns, in the order its manifest declares them, compiled on first use. */
function patterns(): Patterns {
  compiled ??= new Map(RUNNER_HARNESSES.map((harness) => [harness.id, harness.diagnostics.map(({ code, pattern }) => ({ code: code as PatternedDiagnosticCode, pattern: new RegExp(pattern, 'i') }))]));
  return compiled;
}

/**
 * Words that say a process crashed — a fault, a panic, an unhandled exception, memory gone — read before any
 * harness's own patterns, so a crash whose words happen to hold `401` or `timeout` is never read as anything else.
 */
const CRASHED = /\bsegfault\b|segmentation fault|\bpanicked at\b|^panic:|core dumped|\bSIG(?:SEGV|ABRT|BUS|ILL|FPE)\b|index out of (?:range|bounds)|Traceback \(most recent call last\)|\bUnhandled(?:Promise)?Rejection\b|uncaught exception|^fatal error\b|out of memory/im;
/** How many of the last lines after a harness's first line of words its error is read from. */
const ERROR_TAIL_LINES = 3;
const MAX_LINE_CHARS = 512;
/** A stack frame or a traceback's file line, never the error itself. */
const STACK_FRAME = /^(?:at\s|File\s"|\.\.\.|note:|stack backtrace)/;

/**
 * The lines a harness's error is read from: the first line of its words (its own error, or the driver's sentence and
 * the first line of what it wrote to stderr), and the last few lines after it that are not stack frames. A pattern is
 * never matched against the whole of what it wrote.
 */
export function errorLines(words: string): string {
  const lines = words.slice(0, MAX_READ_CHARS).split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');
  if (lines.length === 0) return '';
  const tail = lines.slice(1).filter((line) => !STACK_FRAME.test(line)).slice(-ERROR_TAIL_LINES);
  return [lines[0]!, ...tail].map((line) => line.slice(0, MAX_LINE_CHARS)).join('\n');
}

/** The reason a harness's error lines are read as by its manifest's patterns; null where none matches or the harness is unknown. */
export function patternedDiagnostic(harnessId: string | null, words: string): PatternedDiagnosticCode | null {
  const declared = harnessId === null ? undefined : patterns().get(harnessId);
  if (declared === undefined) return null;
  const read = errorLines(words);
  return declared.find(({ pattern }) => pattern.test(read))?.code ?? null;
}

/** Tool names an identifier each, deduplicated and bounded; anything else is dropped. */
function namesOf(names: readonly string[] | undefined): string[] {
  const kept = (names ?? []).map((name) => identifierShape(name, 64)).filter((name): name is string => name !== null);
  return [...new Set(kept)].slice(0, MAX_NAMES);
}

/**
 * A harness's error as a code, read in this order: the code its driver read from the stream's structure; a code its
 * words open with (`profile_unapplied: …`); `crashed` for a process ended by a signal or whose words say it crashed
 * (`CRASHED`); the first of its manifest's patterns its error lines match (`errorLines`); `crashed` for a process that
 * exited non-zero; else `harness_error`. Its words are never part of what this answers.
 */
export function classifyDiagnostic(harnessId: string | null, ending: HarnessEnding): RunDiagnostic {
  const words = ending.detail ?? '';
  const opening = /^([a-z]+(?:_[a-z]+)+)(?::|$)/.exec(words.trim())?.[1];
  const exitCode = ending.exitCode != null && Number.isSafeInteger(ending.exitCode) && ending.exitCode !== 0 && Math.abs(ending.exitCode) < 1_000_000 ? ending.exitCode : undefined;
  const signal = ending.signal != null && SIGNAL.test(ending.signal) ? ending.signal : undefined;
  const code: RunDiagnosticCode = ending.code
    ?? (opening !== undefined && isCode(RUN_DIAGNOSTIC_CODES, opening) ? opening : null)
    ?? (signal !== undefined || CRASHED.test(words.slice(0, MAX_READ_CHARS)) ? 'crashed' : null)
    ?? patternedDiagnostic(harnessId, words)
    ?? (exitCode !== undefined || signal !== undefined ? 'crashed' : 'harness_error');
  const names = code === 'permission_refused' ? namesOf(ending.names) : [];
  return { code, ...(exitCode === undefined ? {} : { exitCode }), ...(signal === undefined ? {} : { signal }), ...(names.length === 0 ? {} : { names }) };
}

const STOPPED = 'the harness stopped';
const NO_ENDING = 'the harness wrote no ending';
const START = 'the worker could not start the run';
const FAILED = 'the worker failed while driving the run';
const REPORTED = 'the worker reported a failure';

/** A diagnostic's words in a run error: its code, the tools it names, its exit code and its signal. */
function diagnosticWords(diagnostic: RunDiagnostic): string {
  const names = diagnostic.names === undefined || diagnostic.names.length === 0 ? '' : `: ${diagnostic.names.join(', ')}`;
  const exit = diagnostic.exitCode === undefined ? '' : `; exit code ${diagnostic.exitCode}`;
  const signal = diagnostic.signal === undefined ? '' : `; signal ${diagnostic.signal}`;
  return `${diagnostic.code}${names}${exit}${signal}`;
}

/** A harness that stopped: its stop reason, and its coded diagnostic where it stopped with an error. */
export function harnessStoppedError(stop: RunStopReason, diagnostic?: RunDiagnostic): string {
  if (stop !== 'error') return `${STOPPED}: ${stop}`;
  return `${STOPPED}: error (${diagnosticWords(diagnostic ?? { code: 'harness_error' })})`;
}

/** A run whose harness the worker did not start, and the harness or task it names where it names one. */
export function workerStartError(code: WorkerStartCode, name?: string): string {
  const named = name === undefined ? null : identifierShape(name, 64);
  return `${START} (${code}${named === null ? '' : `: ${named}`})`;
}

/** A run the worker stopped driving on a failure of its own. */
export function workerFailedError(code: WorkerFailureCode): string {
  return `${FAILED} (${code})`;
}

/** A run that outlived the budget the Deployment gave it. */
export function budgetError(seconds: number): string {
  return `the run outlived its budget of ${Math.max(0, Math.trunc(seconds))}s`;
}

/** A harness whose stream ended without an ending. */
export const HARNESS_NO_ENDING_ERROR = NO_ENDING;

/** How the in-process runtime records a run that ran past its own bound. */
export const RUN_DEADLINE_ERROR = 'the run reached its deadline';
/** How the in-process runtime records a run the platform took the runtime away from before the run reached its end. */
export const RUN_RECLAIMED_ERROR = 'the platform reclaimed the runtime before the run ended';
/** The in-process runtime's own sentences, each with the reason it is read as. */
const RUNTIME_ERRORS: Readonly<Record<string, RunDiagnosticCode>> = { [RUN_DEADLINE_ERROR]: 'timed_out', [RUN_RECLAIMED_ERROR]: 'crashed' };

/** One kind of call that failed or was refused: the tool's identifier (or `tool`), its coded outcome, and how many times. */
export interface FailedCalls { name: string; outcome: string; count: number }

const CALL_OUTCOME = /^(?:refused|timed out|failed|exit code -?\d{1,7})$/;

/**
 * What a run's record says about the calls that failed or were refused: each kind by its tool's identifier and coded
 * outcome, with how many times, the kinds past `named` counted, and whether the turn ended right after the last of
 * them. Never what a call said or returned.
 */
export function failedCallsError(calls: readonly FailedCalls[], total: number, more: number, endedOnFailure: boolean): string {
  const named = calls.map(({ name, outcome, count }) => `${identifierShape(name, 64) ?? 'tool'} (${CALL_OUTCOME.test(outcome) ? outcome : 'failed'})${count === 1 ? '' : ` ×${count}`}`);
  const counted = total === 1 ? 'a call failed or was refused' : `${total} calls failed or were refused`;
  return `${counted}: ${named.join('; ')}${more > 0 ? `, and ${more} more` : ''}${endedOnFailure ? '; the turn ended right after the last of them' : ''}`;
}

/** What a run error this module wrote says: its diagnostic code where it carries one; null for a sentence it never writes. */
export type ParsedRunError = { code: RunDiagnosticCode | WorkerStartCode | WorkerFailureCode | null; stop: RunStopReason | null } | null;

const DIAGNOSTIC = new RegExp(`^(${RUN_DIAGNOSTIC_CODES.join('|')})(?:: ([^;]+))?(?:; exit code (-?\\d{1,6}))?(?:; signal (SIG[A-Z0-9]{1,12}))?$`);

/** A diagnostic's words as `diagnosticWords` writes them, or null. */
function parseDiagnostic(words: string): RunDiagnosticCode | null {
  const parsed = DIAGNOSTIC.exec(words);
  if (parsed === null) return null;
  const code = parsed[1] as RunDiagnosticCode;
  if (parsed[2] !== undefined) {
    const names = parsed[2].split(', ');
    if (code !== 'permission_refused' || names.length > MAX_NAMES || names.some((name) => identifierShape(name, 64) !== name)) return null;
  }
  return code;
}

/** Whether every kind of call a failed-calls note names is an identifier with a coded outcome. */
function failedCallsParse(text: string): boolean {
  const note = /^(?:a call failed or was refused|\d{1,9} calls failed or were refused): (.+?)(?:, and \d{1,9} more)?(?:; the turn ended right after the last of them)?$/.exec(text);
  if (note === null) return false;
  return note[1]!.split('; ').every((call) => {
    const parsed = /^(\S+) \((refused|timed out|failed|exit code -?\d{1,7})\)(?: ×\d{1,9})?$/.exec(call);
    return parsed !== null && (parsed[1] === 'tool' || identifierShape(parsed[1]!, 64) === parsed[1]);
  });
}

/** A run error as one of the sentences this module writes, with its code; null for any other text. */
export function parseRunError(text: string): ParsedRunError {
  const stopped = /^the harness stopped: ([a-z_]+)(?: \((.+)\))?$/.exec(text);
  if (stopped !== null) {
    const stop = stopped[1]!;
    if (!isCode(RUN_STOP_REASONS, stop)) return null;
    if (stop !== 'error') return stopped[2] === undefined ? { code: null, stop } : null;
    const code = stopped[2] === undefined ? null : parseDiagnostic(stopped[2]);
    return code === null ? null : { code, stop };
  }
  const worker = /^(the worker could not start the run|the worker failed while driving the run|the worker reported a failure) \(([a-z_]+)(?:: (\S+))?\)$/.exec(text);
  if (worker !== null) {
    const [, kind, code, name] = worker;
    if (kind === START && isCode(WORKER_START_CODES, code!) && (name === undefined || identifierShape(name, 64) === name)) return { code: code!, stop: null };
    if (kind === FAILED && isCode(WORKER_FAILURE_CODES, code!) && name === undefined) return { code: code!, stop: null };
    if (kind === REPORTED && isCode(RUN_DIAGNOSTIC_CODES, code!) && name === undefined) return { code: code!, stop: null };
    return null;
  }
  if (/^the run outlived its budget of \d{1,9}s$/.test(text)) return { code: 'timed_out', stop: null };
  if (Object.hasOwn(RUNTIME_ERRORS, text)) return { code: RUNTIME_ERRORS[text]!, stop: null };
  if (text === NO_ENDING) return { code: null, stop: null };
  return failedCallsParse(text) ? { code: null, stop: null } : null;
}

/**
 * A run error as the Deployment stores it: kept where it is a sentence this module writes; otherwise coded from its
 * words — a harness stop's reason and the words in its parentheses, or the whole text — by `classifyDiagnostic` under
 * the run's harness, and stored as that code alone. Never the words a worker sent.
 */
export function shapeRunError(text: string | null, harnessId: string | null): string | null {
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (parseRunError(trimmed) !== null) return trimmed;
  const stopped = /^the harness stopped: ([a-z_]+)(?: \(([\s\S]*)\))?$/.exec(trimmed);
  if (stopped !== null && isCode(RUN_STOP_REASONS, stopped[1]!)) {
    const stop = stopped[1] as RunStopReason;
    return stop === 'error' ? harnessStoppedError(stop, classifyDiagnostic(harnessId, { detail: stopped[2] ?? null })) : harnessStoppedError(stop);
  }
  return `${REPORTED} (${classifyDiagnostic(harnessId, { detail: trimmed }).code})`;
}

/** The diagnostic code a stored run error carries, or null; a harness's refusal to answer reads as `model_refused`. */
export function runErrorDiagnostic(text: string | null): RunDiagnosticCode | null {
  if (text === null) return null;
  const parsed = parseRunError(text);
  if (parsed === null) return null;
  if (parsed.stop === 'refusal') return 'model_refused';
  return parsed.code !== null && isCode(RUN_DIAGNOSTIC_CODES, parsed.code) ? parsed.code : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Identifiers and structured records: what a run route names things by, and the accounting it is sent.
// ---------------------------------------------------------------------------------------------------------------

/**
 * An identifier a run route names something by — a run, an agent, a task, a harness, a provider, a model or a report's
 * action: letters, digits and `. _ : / @ + [ ] -`, opening with a letter or a digit, at most 192 characters.
 */
export const RUN_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@+[\]-]{0,191}$/;

/** A value as a run route's identifier, or null where it is not one. */
export function strictId(value: unknown): string | null {
  return typeof value === 'string' && RUN_IDENTIFIER.test(value) ? value : null;
}

const UUIDS = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** A run's id, or null: an identifier that is not key-like once the UUIDs a run's id is minted with are set aside. */
export function strictRunId(value: unknown): string | null {
  const id = strictId(value);
  return id === null || keyLike(id.replace(UUIDS, '')) ? null : id;
}

/** A name a run route is sent — an agent, a task, a harness, a provider, an action, a cost source — or null: an identifier that is not key-like. */
export function strictName(value: unknown): string | null {
  const id = strictId(value);
  return id === null || keyLike(id) ? null : id;
}

const RECORD_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const MAX_RECORD_DEPTH = 6;
const MAX_RECORD_ITEMS = 100;

/** One value of a structured record as stored: numbers, booleans and identifiers kept; any other text `…`. */
function recordValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value === '' ? '' : identifierShape(value, 256) ?? ELIDED;
  if (typeof value !== 'object' || depth >= MAX_RECORD_DEPTH) return ELIDED;
  if (Array.isArray(value)) return value.slice(0, MAX_RECORD_ITEMS).map((item) => recordValue(item, depth + 1));
  return Object.fromEntries(Object.entries(value).filter(([key]) => RECORD_KEY.test(key)).slice(0, MAX_RECORD_ITEMS)
    .map(([key, item]) => [key, recordValue(item, depth + 1)]));
}

/**
 * A structured record a run route is sent — a run's usage, its cost, a claim's context — as the Deployment stores it:
 * a JSON object whose keys are names, whose numbers and booleans stand, and whose text is kept only where it is an
 * identifier (`identifierShape`), any other text reading `…`. Null where the text is no JSON object or its shape runs
 * past `max` characters.
 */
export function recordShape(text: string, max = 64 * 1024): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const shaped = JSON.stringify(recordValue(parsed, 0));
  return shaped.length > max ? null : shaped;
}

// ---------------------------------------------------------------------------------------------------------------
// Agent prose: the agent's own words, bounded and masked.
// ---------------------------------------------------------------------------------------------------------------

const LINE_BREAKS = /\r\n|[\r\u2028\u2029\u0085\v\f]/g;
/** A code fence and everything to its close, or to the end where it never closes. */
const FENCE = /(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g;
/** A here-document's opener: a quoted delimiter, a delimiter glued to `<<`, or a capitalized one after a space. */
const HEREDOC = /<<-?(?:[ \t]*(["'])([A-Za-z_][A-Za-z0-9_]*)\1|([A-Za-z_][A-Za-z0-9_]*)|[ \t]+([A-Z][A-Z0-9_]*)\b)/g;
const HERESTRING = /<<<[ \t]*\S+/g;
/** An inline code span, which may run across lines; an unmatched backtick pairs with the next one, and what lies between is shaped. */
const INLINE_CODE = /`([^`]{1,4000})`/g;
const URL_START = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const FLAG_ASSIGNMENT = /^(--?[A-Za-z][A-Za-z0-9-]{0,40})=/;
/** A flag whose name says the word after it carries a secret. */
const SECRET_FLAG = /^--?[A-Za-z0-9-]*(?:token|secret|pass|key|auth|credential)[A-Za-z0-9-]*$/i;
/** A label whose name says the word after it, past `is`, `was`, `=` or `:`, carries a secret. */
const SECRET_LABEL = /^(?:[A-Za-z0-9]+[_-])*(?:password|passwd|passphrase|passcode|secret|token|api[_-]?key|credentials?|creds)$/i;
/**
 * A label naming a secret, with what joins it to its value (`is`, `was`, `are`, `=`, `:` or a table's `|`), and the
 * value: a quoted span to its closing quote, or everything to the next table cell or the end of the line.
 */
const LABELED_VALUE = /(\b(?:[A-Za-z0-9]+[_-])*(?:password|passwd|passphrase|passcode|pass|pwd|pw|pin|secret|token|api[_-]?key|credentials?|creds)\b["']?)([ \t]*(?:\b(?:is|was|are)\b|=|:|\|)[ \t]*)("[^"\n]*"?|'[^'\n]*'?|[^|\n]*)/gi;
/** A line shaped like a record of `/etc/passwd` or `/etc/shadow`: a user name and six or more `:`-separated fields. */
const ACCOUNT_LINE = /^[ \t]*[A-Za-z_][A-Za-z0-9._-]*(?::[^:\n]*){6,}[ \t]*$/gm;
/** Three or more `*` in a row: a key echoed with its middle masked. */
const MASKED_ECHO = /\*{3,}/;
const CONNECTORS: ReadonlySet<string> = new Set(['is', 'was', 'were', 'are', '=', ':', '|', 'of', 'as', 'to']);
const LEADING = /^[("'`<[{*_]+/;
const TRAILING = /[)"'`>\]}.,;:!?*_]+$/;

/** Every here-document's body read as `…`, its opener and delimiter kept; a body that never closes runs to the end. */
function collapseHeredocs(text: string): string {
  let out = '';
  let at = 0;
  HEREDOC.lastIndex = 0;
  for (let found = HEREDOC.exec(text); found !== null; found = HEREDOC.exec(text)) {
    if (found.index < at || text.startsWith('<<<', found.index)) continue;
    const delimiter = found[2] ?? found[3] ?? found[4]!;
    const opened = found.index + found[0].length;
    const close = new RegExp(`(^|[\\s;|&)\`'"])${delimiter}(?=$|[\\s;|&)\`'".,])`, 'g');
    close.lastIndex = opened;
    const closing = close.exec(text);
    out += `${text.slice(at, opened)} ${ELIDED}`;
    if (closing === null) return out;
    const end = closing.index + closing[0].length;
    out += ` ${delimiter}`;
    at = end;
    HEREDOC.lastIndex = end;
  }
  return out + text.slice(at);
}

/** A word read as `…`, the punctuation around it kept. */
function elided(word: string): string {
  const lead = LEADING.exec(word)?.[0] ?? '';
  const rest = word.slice(lead.length);
  const trail = TRAILING.exec(rest)?.[0] ?? '';
  return rest.length === trail.length ? word : `${lead}${ELIDED}${trail}`;
}

/** One word in its stored shape: a URL as its scheme and host, anything key-like, an assignment or a credential `…`. */
function maskWord(word: string): string {
  if (MASKED_ECHO.test(word) && /[A-Za-z0-9]/.test(word)) return elided(word.replace(/\*/g, 'x'));
  const lead = LEADING.exec(word)?.[0] ?? '';
  const rest = word.slice(lead.length);
  const trail = TRAILING.exec(rest)?.[0] ?? '';
  const core = rest.slice(0, rest.length - trail.length);
  if (core === '' || core === ELIDED || core === '[REDACTED]') return word;
  // A word of six or more `:`-separated fields is a password-file record, wherever it stands.
  if ((word.match(/:/g)?.length ?? 0) >= 6) return ELIDED;
  if (URL_START.test(core)) return `${lead}${urlShape(core) ?? ELIDED}${trail}`;
  const flag = FLAG_ASSIGNMENT.exec(core);
  if (flag !== null) return `${lead}${keyLike(flag[1]!) ? ELIDED : `${flag[1]}=${ELIDED}`}${trail}`;
  if (ASSIGNMENT.test(core)) return `${lead}${ELIDED}${trail}`;
  // Credentials before an @, and the local part of an address, are never kept; a scope such as `@org/pkg` is.
  if (/^[^@]+@/.test(core)) return `${lead}${ELIDED}${trail}`;
  const colon = core.indexOf(':');
  if (colon > 0 && SECRET_LABEL.test(core.slice(0, colon).replace(/^-+/, '')) && colon < core.length - 1) return `${lead}${ELIDED}${trail}`;
  if (colon > 0 && /^(?:pass|key|auth|bearer)$/i.test(core.slice(0, colon)) && colon < core.length - 1) return `${lead}${ELIDED}${trail}`;
  return keyLike(core) ? `${lead}${ELIDED}${trail}` : word;
}

/** Whether the word after this one carries a secret by what this one says, and how many connecting words may come between. */
function secretNext(word: string): boolean {
  const core = word.replace(LEADING, '').replace(/[)"'`>\]}.,;!?*_]+$/, '');
  if (SECRET_FLAG.test(core) && !core.includes('=')) return true;
  return SECRET_LABEL.test(core.replace(/:$/, ''));
}

/** Every word in its stored shape, the word after a secret-named flag or label read `…`. */
function maskWords(text: string): string {
  const parts = text.split(/(\s+)/);
  let pending = false;
  let connectors = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (part === '' || /^\s+$/.test(part)) continue;
    if (pending && CONNECTORS.has(part.toLowerCase()) && connectors < 2) { connectors += 1; continue; }
    if (pending) {
      parts[i] = elided(part);
      pending = false;
      connectors = 0;
      continue;
    }
    parts[i] = maskWord(part);
    pending = secretNext(part);
    connectors = 0;
  }
  return parts.join('');
}

/** A labeled secret's whole value read as `…`: a quoted value keeps its quotes, a table cell its closing space. */
function maskLabeledValues(text: string): string {
  return text.replace(LABELED_VALUE, (_match, label: string, joint: string, value: string) => {
    if (value.trim() === '' || value.trim() === ELIDED) return `${label}${joint}${value}`;
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : '';
    if (quote !== '') return `${label}${joint}${quote}${ELIDED}${value.length > 1 && value.endsWith(quote) ? quote : ''}`;
    return `${label}${joint}${ELIDED}${/\s$/.test(value) ? ' ' : ''}`;
  });
}

/** An inline code span: a command shaped as one (`commandShape`), a single word masked as a word is. */
function inlineCode(_span: string, body: string): string {
  const shaped = /\s/.test(body.trim()) ? commandShape(body) ?? ELIDED : maskWord(body);
  return `\`${shaped}\``;
}

/**
 * Agent prose as a run stores it: zero-width characters dropped, line breaks made `\n` (or a space where `singleLine`),
 * other control characters a space; code-fence bodies `…`; a line shaped like a password-file record `…`; an inline code span holding a command in the allowed shape of a command; here-document
 * bodies `…`; a here-string's word `…`; every other word masked (`maskWord`), with the word after a secret-named flag or
 * label `…`; a secret label's whole value `…` (to its closing quote, the next table cell or the end of the line); a
 * word holding a masked echo (`***`) `…`; known access-key shapes masked (`redactSecrets`); and the whole cut to `max` characters. Null where
 * nothing is left.
 */
export function agentProse(value: string, max: number, options: { singleLine?: boolean } = {}): string | null {
  let text = value.replace(ZERO_WIDTH, '').replace(LINE_BREAKS, '\n').replace(/[\u0000-\u0008\u000e-\u001f\u007f\t]+/g, ' ');
  text = text.replace(FENCE, ELIDED);
  text = text.replace(ACCOUNT_LINE, ELIDED);
  // Inline code is shaped before here-documents are read, so a here-document quoted inline never runs past its span.
  text = text.replace(INLINE_CODE, inlineCode);
  text = collapseHeredocs(text);
  text = text.replace(HERESTRING, `<<< ${ELIDED}`);
  text = maskWords(text);
  text = maskLabeledValues(text);
  text = redactSecrets(text);
  if (options.singleLine === true) text = text.replace(/ *\n[\n ]*/g, ' ');
  text = text.trim();
  if (text === '') return null;
  return text.length > max ? `${text.slice(0, max - 1)}${ELIDED}` : text;
}
