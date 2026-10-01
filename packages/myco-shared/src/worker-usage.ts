const REQUIRED_FIELDS = { inputTokens: 'count', outputTokens: 'count', costUsd: 'dollars' } as const;
const OPTIONAL_FIELDS = { cachedTokens: 'count', cacheCreationTokens: 'count', reasoningTokens: 'count', estimatedCostUsd: 'dollars' } as const;
const FIELDS = { ...REQUIRED_FIELDS, ...OPTIONAL_FIELDS };
const METADATA_FIELDS = ['provider', 'model', 'tokenScope', 'models'] as const;
const MAX_MODEL_CHARS = 256;
const MAX_ACCOUNTED_MODELS = 64;

/** Reported accounting; omitted tokenScope means attempt totals. Null means unavailable. */
export type WorkerUsage = Record<keyof typeof REQUIRED_FIELDS, number | null>
  & Partial<Record<keyof typeof OPTIONAL_FIELDS, number | null>>
  & { provider?: string; model?: string; tokenScope?: 'last_response' | 'unverified'; models?: WorkerModelUsage[] };

export const WORKER_ACCOUNTING_VERSION = 1;

export interface ModelIdentity { model: string; provider?: string }
export interface WorkerModelUsage extends ModelIdentity {
  source: string;
  usage: Omit<WorkerUsage, 'models'> | null;
}
export type ExecutionIdentity =
  | { status: 'reported' | 'launched'; source: string; primary: ModelIdentity; models: WorkerModelUsage[] }
  | { status: 'unknown'; reason: string };
export interface WorkerExecutionAccounting {
  accountingVersion: typeof WORKER_ACCOUNTING_VERSION;
  attemptId: string;
  identity: ExecutionIdentity;
  usage: WorkerUsage | null;
}

export type RecordedIdentity = ExecutionIdentity | { status: 'not_recorded' };
export type CostProvenance = 'harness_actual' | 'harness_estimate' | 'model_pricing' | 'unavailable';

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
  if (raw.models !== undefined) usage.models = parseModels(raw.models);
  return usage;
}

function textField(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0 || value.length > MAX_MODEL_CHARS || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new WorkerUsageError(`Invalid accounting ${name}.`);
  }
  return value;
}

function modelIdentity(value: unknown): ModelIdentity {
  const raw = object(value);
  if (Object.keys(raw).some((k) => !['model', 'provider'].includes(k))) throw new WorkerUsageError('Unknown primary identity field.');
  return { model: textField(raw.model, 'model'), ...(raw.provider === undefined ? {} : { provider: textField(raw.provider, 'provider') }) };
}

function parseModels(value: unknown): WorkerModelUsage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ACCOUNTED_MODELS) throw new WorkerUsageError(`Accounting names 1..${MAX_ACCOUNTED_MODELS} models.`);
  const models = value.map((entry) => {
    const raw = object(entry);
    if (Object.keys(raw).some((k) => !['model', 'provider', 'source', 'usage'].includes(k))) throw new WorkerUsageError('Unknown model accounting field.');
    if (raw.usage != null && Object.hasOwn(object(raw.usage), 'models')) throw new WorkerUsageError('Nested model accounting is not allowed.');
    return { ...modelIdentity({ model: raw.model, ...(raw.provider === undefined ? {} : { provider: raw.provider }) }), source: textField(raw.source, 'source'), usage: raw.usage == null ? null : parseWorkerUsage(raw.usage) };
  });
  const keys = models.map((m) => JSON.stringify([m.provider, m.model]));
  if (new Set(keys).size !== keys.length) throw new WorkerUsageError('Duplicate model accounting.');
  return models;
}

export function parseExecutionIdentity(value: unknown): ExecutionIdentity {
  const raw = object(value);
  if (raw.status === 'unknown') {
    if (Object.keys(raw).some((k) => !['status', 'reason'].includes(k))) throw new WorkerUsageError('Unknown identity field.');
    return { status: 'unknown', reason: textField(raw.reason, 'reason') };
  }
  if (raw.status !== 'reported' && raw.status !== 'launched') throw new WorkerUsageError('Invalid execution identity status.');
  if (Object.keys(raw).some((k) => !['status', 'source', 'primary', 'models'].includes(k))) throw new WorkerUsageError('Unknown identity field.');
  const primary = modelIdentity(raw.primary);
  const models = parseModels(raw.models);
  if (!models.some((m) => m.model === primary.model && m.provider === primary.provider)) throw new WorkerUsageError('Primary model is in the accounting models.');
  return { status: raw.status, source: textField(raw.source, 'source'), primary, models };
}

/** Claims without an attempt identity can complete, but cannot attach accounting. */
export function parseWorkerAccounting(value: unknown): { attemptId?: string; usage: WorkerUsage | null; accountingVersion?: number; identity?: ExecutionIdentity } {
  const raw = object(value);
  const usage = raw.usage == null ? null : parseWorkerUsage(raw.usage);
  const attemptId = raw.attemptId;
  if (attemptId !== undefined && (typeof attemptId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(attemptId))) {
    throw new WorkerUsageError('Invalid claimed attemptId.');
  }
  if (usage !== null && attemptId === undefined) throw new WorkerUsageError('Usage names its claimed attemptId.');
  if (raw.accountingVersion !== undefined && raw.accountingVersion !== WORKER_ACCOUNTING_VERSION) throw new WorkerUsageError('Unsupported worker accounting version.');
  if (raw.accountingVersion !== undefined && raw.identity === undefined) throw new WorkerUsageError('Versioned accounting requires an identity.');
  const identity = raw.identity === undefined ? undefined : parseExecutionIdentity(raw.identity);
  if (identity !== undefined && raw.accountingVersion === undefined) throw new WorkerUsageError('Identity names its accounting version.');
  if (identity !== undefined && attemptId === undefined) throw new WorkerUsageError('Identity names its claimed attemptId.');
  return { attemptId, usage, ...(identity === undefined ? {} : { accountingVersion: WORKER_ACCOUNTING_VERSION, identity }) };
}
