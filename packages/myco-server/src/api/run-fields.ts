import { isTerminalRunStatus, type RunUpdate } from '../core/runs.js';
import { recordShape, shapeRunError, strictId, strictName, strictRunId } from '@goondocks/myco-shared/run-text';
import { MAX_REPORT_DETAILS_CHARS, MAX_REPORT_SUMMARY_CHARS } from '../core/run-postconditions.js';
import { refusal, type Refusal } from '../telemetry.js';

/** The longest a task name or state key may be, matching the identifier bound the ingest envelope applies. */
const MAX_ID_CHARS = 192;
/** The largest state value this surface accepts, bounding one row against a caller that would grow it without limit. */
export const MAX_STATE_BYTES = 256 * 1024;

export const BAD_BODY: Refusal = refusal('body is not an object', 'parse');

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = MAX_ID_CHARS): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
const strOrNull = (v: unknown, max = MAX_ID_CHARS): string | null | undefined =>
  v === undefined || v === null ? null : str(v, max) ?? undefined;
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);
/** The longest model text an embedding claim may carry. */
const MAX_MODEL_CHARS = 1024;
/** An embedding claim names the server's stored model; its text stays bounded and contains no controls. */
const modelOrNull = (v: unknown, embedding: boolean): string | null | undefined => {
  if (v === undefined || v === null) return null;
  if (embedding) return typeof v === 'string' && v.length > 0 && v.length <= MAX_MODEL_CHARS
    && !/[\u0000-\u001f\u007f-\u009f]/.test(v) ? v : undefined;
  return strictId(v) ?? undefined;
};
/** A name, null where none is given, or undefined where what is given is not one. */
const nameOrNull = (v: unknown): string | null | undefined => (v === undefined || v === null ? null : strictName(v) ?? undefined);

type Field = (value: unknown, body: Readonly<Record<string, unknown>>) => unknown;
type FieldTable = Readonly<Record<string, Field>>;
type Fields<T extends FieldTable> = { [K in keyof T]: ReturnType<T[K]> };
const unchanged = (value: unknown) => value;
const boolean = (value: unknown) => value === true;
const object = (value: unknown) => isRecord(value) ? value : null;
const record = (value: unknown) => value == null ? value : typeof value === 'string' && value.length <= MAX_STATE_BYTES ? recordShape(value, MAX_STATE_BYTES) ?? undefined : undefined;
const number = (value: unknown) => value === null ? null : typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const text = (value: unknown) => value === null ? null : typeof value === 'string' ? value : undefined;

/** Each column a run's own update accepts, with its wire validator. */
export const RUN_UPDATE_FIELDS = {
  status: unchanged, completed_at: number, tokens_used: number, error: text, usage_data: record,
  cost_usd: number, actual_cost_usd: number, estimated_cost_usd: number, cost_source: nameOrNull, cost_data: record,
} as const;

/** Fields consumed by each active run route; task-owned records retain their domain validation. */
export const RUN_REQUEST_FIELDS = {
  '/runs/claim': {
    id: strictRunId, agentId: strictName, task: strictName, capability: unchanged, captureDriven: boolean,
    maxAgeSeconds: unchanged, instruction: unchanged, startedAt: int, harness: nameOrNull, provider: nameOrNull,
    model: (value: unknown, body: Readonly<Record<string, unknown>>) => modelOrNull(value, body.task === 'embedding-reconcile'),
    runContext: (value: unknown) => value == null ? null : record(value), dryRun: boolean,
  },
  '/runs/update': { runId: (value: unknown) => str(value), update: object, replaced: boolean, refusalId: (value: unknown) => value == null ? null : strictId(value) ?? undefined },
  '/runs/report': { runId: strictId, agentId: strictName, action: strictName,
    summary: (value: unknown) => str(value, MAX_REPORT_SUMMARY_CHARS),
    details: (value: unknown) => strOrNull(value, MAX_REPORT_DETAILS_CHARS), audit: unchanged },
  '/runs/embedding-step': { runId: (value: unknown) => str(value) },
  '/runs/repository': { runId: (value: unknown) => str(value), commit: unchanged, url: unchanged, branch: unchanged },
  '/runs/canopy-map': { runId: (value: unknown) => str(value), op: unchanged, source: unchanged, artifact: unchanged },
} as const;

/** Decode only declared fields; handler reads outside its table are an invalid contract. */
export function decodeRunFields<T extends FieldTable>(body: Record<string, unknown>, fields: T, partial = false): Fields<T> {
  const declared = <V extends Record<string, unknown>>(target: V): V => new Proxy(target, { get: (target, key) => {
    if (typeof key === 'string' && !Object.hasOwn(fields, key)) throw new Error(`undeclared run field: ${key}`);
    return Reflect.get(target, key);
  } });
  const input = declared(body);
  return declared(Object.fromEntries(Object.entries(fields).filter(([key]) => !partial || Object.hasOwn(body, key))
    .map(([key, decode]) => [key, decode(input[key], input)]))) as Fields<T>;
}

/** A JSON object decoded through its route's field table, or null for a malformed body. */
export function readRunFields<P extends keyof typeof RUN_REQUEST_FIELDS>(text: string, path: P): Fields<(typeof RUN_REQUEST_FIELDS)[P]> | null {
  let body: unknown;
  try { body = JSON.parse(text); } catch { return null; }
  return isRecord(body) ? decodeRunFields(body, RUN_REQUEST_FIELDS[path]) : null;
}

export function decodeRunUpdate(update: Record<string, unknown>, harness: string | null): RunUpdate | null {
  const decoded = decodeRunFields(update, RUN_UPDATE_FIELDS, true);
  if (Object.values(decoded).some((value) => value === undefined)) return null;
  return { ...decoded, ...('error' in update ? { error: shapeRunError(decoded.error ?? null, harness) } : {}) } as RunUpdate;
}

/** The answer a status change gets on a run that has already ended under a DIFFERENT ending: nothing moved, and the row's own ending stands. */
const TERMINAL_ANSWER = { persisted: true, changed: 0, applied: false, reason: 'terminal' } as const;
/** The answer a status change gets on a run already carrying that very status: nothing moved, and nothing needs to. */
const SETTLED_ANSWER = { persisted: true, changed: 0, applied: true } as const;

/**
 * What a status write answers on a run that has already ended, or nothing when
 * the run is still open.
 *
 * A repeat of the ending the row carries is the same close arriving twice — a
 * retried request, or a runtime offering its terminal status the second time the
 * update surface allows it — and it is answered as applied: the row says what
 * the caller asked it to say. A DIFFERENT ending is the race, and it is refused
 * by name.
 */
export function endedAnswer(status: string | undefined, posted: unknown): Response | null {
  if (!isTerminalRunStatus(status)) return null;
  return Response.json(status === posted ? SETTLED_ANSWER : TERMINAL_ANSWER);
}
