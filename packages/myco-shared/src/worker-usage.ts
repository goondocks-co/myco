const REQUIRED_FIELDS = { inputTokens: 'count', outputTokens: 'count', costUsd: 'dollars' } as const;
const OPTIONAL_FIELDS = { cachedTokens: 'count', cacheCreationTokens: 'count', reasoningTokens: 'count', estimatedCostUsd: 'dollars' } as const;
const FIELDS = { ...REQUIRED_FIELDS, ...OPTIONAL_FIELDS };
const METADATA_FIELDS = ['provider', 'model', 'tokenScope'] as const;
const MAX_MODEL_CHARS = 256;

/** Reported accounting; omitted tokenScope means attempt totals. Null means unavailable. */
export type WorkerUsage = Record<keyof typeof REQUIRED_FIELDS, number | null>
  & Partial<Record<keyof typeof OPTIONAL_FIELDS, number | null>>
  & { provider?: string; model?: string; tokenScope?: 'last_response' | 'unverified' };

export class WorkerUsageError extends Error {}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new WorkerUsageError('Worker accounting must be an object.');
  return value as Record<string, unknown>;
}

/** Validate counts, dollar figures and the total before accepting worker accounting. */
export function parseWorkerUsage(value: unknown): WorkerUsage {
  const raw = object(value);
  if (Object.keys(raw).some((key) => !Object.hasOwn(FIELDS, key) && !METADATA_FIELDS.some((field) => field === key))) throw new WorkerUsageError('Unknown worker usage field.');
  const parsed: Record<string, number | null> = {};
  for (const [key, kind] of Object.entries(FIELDS)) {
    const field = raw[key];
    if (field === undefined && Object.hasOwn(OPTIONAL_FIELDS, key)) continue;
    if (field !== null && (typeof field !== 'number' || !Number.isFinite(field) || field < 0
      || field > Number.MAX_SAFE_INTEGER || (kind === 'count' && !Number.isSafeInteger(field)))) {
      throw new WorkerUsageError(`Invalid worker usage ${key}.`);
    }
    parsed[key] = field as number | null;
  }
  const usage = parsed as WorkerUsage;
  for (const key of ['provider', 'model'] as const) {
    const field = raw[key];
    if (field === undefined) continue;
    if (typeof field !== 'string' || field.length === 0 || field.length > MAX_MODEL_CHARS || /[\u0000-\u001f\u007f]/.test(field)) {
      throw new WorkerUsageError(`Invalid worker usage ${key}.`);
    }
    usage[key] = field;
  }
  if (raw.tokenScope !== undefined) {
    if (raw.tokenScope !== 'last_response' && raw.tokenScope !== 'unverified') throw new WorkerUsageError('Invalid worker usage tokenScope.');
    usage.tokenScope = raw.tokenScope;
  }
  if (usage.inputTokens !== null && usage.outputTokens !== null && !Number.isSafeInteger(usage.inputTokens + usage.outputTokens)) {
    throw new WorkerUsageError('Total tokens exceed the safe integer range.');
  }
  return usage;
}

/** Claims without an attempt identity can complete, but cannot attach accounting. */
export function parseWorkerAccounting(value: unknown): { attemptId?: string; usage: WorkerUsage | null } {
  const raw = object(value);
  const usage = raw.usage == null ? null : parseWorkerUsage(raw.usage);
  const attemptId = raw.attemptId;
  if (attemptId !== undefined && (typeof attemptId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(attemptId))) {
    throw new WorkerUsageError('Invalid claimed attemptId.');
  }
  if (usage !== null && attemptId === undefined) throw new WorkerUsageError('Usage names its claimed attemptId.');
  return { attemptId, usage };
}
