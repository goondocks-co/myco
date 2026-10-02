const REQUIRED_FIELDS = { inputTokens: 'count', outputTokens: 'count', costUsd: 'dollars' } as const;
const OPTIONAL_FIELDS = { cachedTokens: 'count', cacheCreationTokens: 'count', reasoningTokens: 'count', cacheCreation5mTokens: 'count', cacheCreation1hTokens: 'count', estimatedCostUsd: 'dollars' } as const;
const FIELDS = { ...REQUIRED_FIELDS, ...OPTIONAL_FIELDS };
const METADATA_FIELDS = ['provider', 'model', 'tokenScope', 'models'] as const;
const MAX_MODEL_CHARS = 256;
const MAX_ACCOUNTED_MODELS = 64;

/** Reported accounting; omitted tokenScope means attempt totals. Null means unavailable. */
export type WorkerUsage = Record<keyof typeof REQUIRED_FIELDS, number | null>
  & Partial<Record<keyof typeof OPTIONAL_FIELDS, number | null>>
  & { provider?: string; model?: string; tokenScope?: 'last_response' | 'unverified'; models?: WorkerModelUsage[] };

export const WORKER_ACCOUNTING_VERSION = 1;
export const WORKER_ACCOUNTING_FEATURE = 'worker-accounting-v1';

export interface ModelIdentity { model: string; provider?: string; context?: '1m' }
export interface WorkerModelUsage extends ModelIdentity {
  source: string;
  usage: Omit<WorkerUsage, 'models'> | null;
}
export type ExecutionIdentity =
  | { status: 'reported' | 'launched'; source: string; primary: ModelIdentity; models: WorkerModelUsage[]; warnings?: string[] }
  | { status: 'unknown'; reason: string };
export interface WorkerExecutionAccounting {
  accountingVersion: typeof WORKER_ACCOUNTING_VERSION;
  attemptId: string;
  identity: ExecutionIdentity;
  usage: WorkerUsage | null;
}

export type RecordedIdentity = ExecutionIdentity | { status: 'not_recorded' };
export type CostProvenance = 'harness_actual' | 'harness_estimate' | 'model_pricing' | 'mixed' | 'unavailable';

export class WorkerUsageError extends Error {}

const validField = (value: unknown, kind: 'count' | 'dollars'): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0
    && value <= Number.MAX_SAFE_INTEGER && (kind === 'dollars' || Number.isSafeInteger(value)));

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new WorkerUsageError('Worker accounting must be an object.');
  return value as Record<string, unknown>;
}

/** Validate counts, dollar figures and the total before accepting worker accounting. */
export function parseWorkerUsage(value: unknown, warnings: string[] = []): WorkerUsage {
  const raw = object(value);
  if (Object.keys(raw).some((key) => !Object.hasOwn(FIELDS, key) && !METADATA_FIELDS.some((field) => field === key))) throw new WorkerUsageError('Unknown worker usage field.');
  const parsed: Record<string, number | null> = {};
  for (const [key, kind] of Object.entries(FIELDS)) {
    const field = raw[key];
    if (field === undefined && Object.hasOwn(OPTIONAL_FIELDS, key)) continue;
    if (!validField(field, kind)) {
      throw new WorkerUsageError(`Invalid worker usage ${key}.`);
    }
    parsed[key] = field as number | null;
  }
  const usage = parsed as WorkerUsage;
  for (const key of ['provider', 'model'] as const) {
    const field = raw[key];
    if (field === undefined) continue;
    if (typeof field !== 'string' || field.length === 0 || /[\u0000-\u001f\u007f]/.test(field)) {
      throw new WorkerUsageError(`Invalid worker usage ${key}.`);
    }
    usage[key] = textField(field, key, warnings);
  }
  if (raw.tokenScope !== undefined) {
    if (raw.tokenScope !== 'last_response' && raw.tokenScope !== 'unverified') throw new WorkerUsageError('Invalid worker usage tokenScope.');
    usage.tokenScope = raw.tokenScope;
  }
  if (usage.inputTokens !== null && usage.outputTokens !== null && !Number.isSafeInteger(usage.inputTokens + usage.outputTokens)) {
    throw new WorkerUsageError('Total tokens exceed the safe integer range.');
  }
  if (raw.models !== undefined) usage.models = parseModels(raw.models, warnings);
  return usage;
}

function textField(value: unknown, name: string, warnings: string[] = []): string {
  if (typeof value !== 'string' || value.trim().length === 0 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new WorkerUsageError(`Invalid accounting ${name}.`);
  }
  const normalized = value.trim();
  if (normalized.length > MAX_MODEL_CHARS) warnings.push(`${name}_name_truncated`);
  return normalized.slice(0, MAX_MODEL_CHARS);
}

function modelIdentity(value: unknown, warnings: string[] = []): ModelIdentity {
  const raw = object(value);
  if (Object.keys(raw).some((k) => !['model', 'provider', 'context'].includes(k))) throw new WorkerUsageError('Unknown primary identity field.');
  if (raw.context !== undefined && raw.context !== '1m') throw new WorkerUsageError('Invalid model context.');
  return { model: textField(raw.model, 'model', warnings), ...(raw.provider === undefined ? {} : { provider: textField(raw.provider, 'provider', warnings) }),
    ...(raw.context === undefined ? {} : { context: raw.context }) };
}

function parseModels(value: unknown, warnings: string[] = [], primary?: ModelIdentity): WorkerModelUsage[] {
  if (!Array.isArray(value) || value.length === 0) throw new WorkerUsageError(`Accounting names 1..${MAX_ACCOUNTED_MODELS} models.`);
  const entries = value.slice(0, MAX_ACCOUNTED_MODELS);
  if (value.length > MAX_ACCOUNTED_MODELS) {
    warnings.push('model_list_truncated');
    const preferred = primary === undefined ? undefined : value.find((entry) => entry != null && typeof entry.model === 'string'
      && entry.model.trim().slice(0, MAX_MODEL_CHARS) === primary.model && (typeof entry.provider === 'string' ? entry.provider.trim().slice(0, MAX_MODEL_CHARS) : undefined) === primary.provider);
    if (preferred !== undefined && !entries.includes(preferred)) entries[MAX_ACCOUNTED_MODELS - 1] = preferred;
  }
  const models = entries.map((entry) => {
    const raw = object(entry);
    if (Object.keys(raw).some((k) => !['model', 'provider', 'context', 'source', 'usage'].includes(k))) throw new WorkerUsageError('Unknown model accounting field.');
    if (raw.usage != null && Object.hasOwn(object(raw.usage), 'models')) throw new WorkerUsageError('Nested model accounting is not allowed.');
    return { ...modelIdentity({ model: raw.model, ...(raw.provider === undefined ? {} : { provider: raw.provider }), ...(raw.context === undefined ? {} : { context: raw.context }) }, warnings), source: textField(raw.source, 'source', warnings), usage: raw.usage == null ? null : parseWorkerUsage(raw.usage) };
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
  if (Object.keys(raw).some((k) => !['status', 'source', 'primary', 'models', 'warnings'].includes(k))) throw new WorkerUsageError('Unknown identity field.');
  if (raw.warnings !== undefined && (!Array.isArray(raw.warnings) || raw.warnings.some((v) => typeof v !== 'string'))) throw new WorkerUsageError('Invalid accounting warnings.');
  const warnings = (raw.warnings ?? []).slice(0, MAX_ACCOUNTED_MODELS).map((v: string) => textField(v, 'warning'));
  const primary = modelIdentity(raw.primary, warnings);
  const models = parseModels(raw.models, warnings, primary);
  if (!models.some((m) => m.model === primary.model && m.provider === primary.provider)) throw new WorkerUsageError('Primary model must be in the accounting models.');
  const source = textField(raw.source, 'source', warnings);
  return { status: raw.status, source, primary, models, ...(warnings.length === 0 ? {} : { warnings: [...new Set(warnings)] }) };
}

/** Claims without an attempt identity can complete, but cannot attach accounting. */
export function parseWorkerAccounting(value: unknown): { attemptId?: string; usage: WorkerUsage | null; accountingVersion?: number; identity?: ExecutionIdentity } {
  const raw = object(value);
  const future = raw.accountingVersion !== undefined && raw.accountingVersion !== WORKER_ACCOUNTING_VERSION;
  let usage: WorkerUsage | null = null;
  if (raw.usage != null) {
    if (!future) usage = parseWorkerUsage(raw.usage);
    else {
      try {
        const evidence = object(raw.usage);
        const scalars = Object.fromEntries(Object.entries(FIELDS).flatMap(([key, kind]) => validField(evidence[key], kind) ? [[key, evidence[key]]] : []));
        const tokenScope = evidence.tokenScope === undefined ? undefined : evidence.tokenScope === 'last_response' ? 'last_response' : 'unverified';
        usage = parseWorkerUsage({ inputTokens: null, outputTokens: null, costUsd: null, ...scalars, ...(tokenScope === undefined ? {} : { tokenScope }) });
      }
      catch { usage = null; }
    }
  }
  const attemptId = raw.attemptId;
  if (attemptId !== undefined && (typeof attemptId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(attemptId))) {
    throw new WorkerUsageError('Invalid claimed attemptId.');
  }
  if (usage !== null && attemptId === undefined) throw new WorkerUsageError('Usage names its claimed attemptId.');
  if (future) return { attemptId, usage };
  if (raw.accountingVersion !== undefined && raw.identity === undefined) throw new WorkerUsageError('Versioned accounting requires an identity.');
  const identity = raw.identity === undefined ? undefined : parseExecutionIdentity(raw.identity);
  if (identity !== undefined && raw.accountingVersion === undefined) throw new WorkerUsageError('Identity names its accounting version.');
  if (identity !== undefined && attemptId === undefined) throw new WorkerUsageError('Identity names its claimed attemptId.');
  return { attemptId, usage, ...(identity === undefined ? {} : { accountingVersion: WORKER_ACCOUNTING_VERSION, identity }) };
}
