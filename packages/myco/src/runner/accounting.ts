import { parseExecutionIdentity, parseWorkerUsage, type ExecutionIdentity, type ModelIdentity, type WorkerModelUsage, type WorkerUsage } from '@goondocks/myco-shared/worker-usage';
import type { Harness, HarnessAccounting } from './harnesses.js';
import type { RunEvent } from './events.js';

export class AccountingIssue extends Error {
  constructor(readonly reason: string) { super(reason); }
}

/** Accounting failures carry diagnostics independently of the harness's outcome. */
function accountingEvidence<T>(extract: () => T): { value: T; error?: never } | { value?: never; error: Extract<ExecutionIdentity, { status: 'unknown' }> } {
  try { return { value: extract() }; }
  catch (error) {
    return { error: { status: 'unknown', reason: error instanceof AccountingIssue ? error.reason : `accounting_extraction_failed:${error instanceof Error ? error.name : 'unknown'}` } };
  }
}

/** Every driver emits accounting through the same failure boundary. */
export function accountingEvents(extract: () => RunEvent[]): RunEvent[] {
  const evidence = accountingEvidence(extract);
  return evidence.error === undefined ? evidence.value : [{ kind: 'identity', identity: evidence.error }];
}

/** Zero is a price only when the manifest declares the reported dollars usable at zero. */
export const reportedDollars = (policy: HarnessAccounting, value: number | null): number | null =>
  value === 0 && policy.zeroDollars !== 'reported' ? null : value;

/** Resolve only the provider settings declared by the runner manifest. */
export function configuredProvider(harness: Harness, environment: Record<string, string | undefined>): string | undefined {
  const policy = harness.accounting.provider;
  if (policy.kind === 'fixed') return policy.id;
  if (policy.kind !== 'environment') return undefined;
  const active = policy.selectors.filter(({ variable }) => environment[variable] === '1' || environment[variable] === 'true');
  const unresolved = policy.selectors.some(({ variable }) => environment[variable] !== undefined && !['', '0', 'false', '1', 'true'].includes(environment[variable]!));
  if (active.length > 1 || unresolved || policy.unknownIfSet.some((variable) => Boolean(environment[variable]))) return undefined;
  return active[0]?.provider ?? policy.default;
}

/** Decode model variants and provider syntax declared by the runner manifest. */
export function reportedModel(harness: Harness, model: string, source: string, usage: WorkerUsage | null = null, provider?: string, environment: Record<string, string | undefined> = process.env): WorkerModelUsage {
  if (!harness.accounting.modelSources.includes(source) && !(source === 'launch.config.model' && harness.accounting.launchFallback === 'resolved-config')) throw new AccountingIssue('undeclared_model_source');
  const normalized = model.trim();
  const variant = harness.accounting.modelVariants?.find(({ suffix }) => normalized.endsWith(suffix));
  const bare = variant === undefined ? normalized : normalized.slice(0, -variant.suffix.length);
  const policy = harness.accounting.provider;
  const separator = policy.kind === 'model-prefix' ? bare.indexOf('/') : -1;
  const resolved = provider ?? (separator > 0 ? bare.slice(0, separator) : configuredProvider(harness, environment));
  return {
    model: separator > 0 ? bare.slice(separator + 1) : bare,
    ...(resolved === undefined ? {} : { provider: resolved }),
    ...(variant === undefined ? {} : { context: variant.context }), source, usage,
  };
}

const modelKey = (model: ModelIdentity): string => JSON.stringify([model.provider, model.model]);
const primaryOf = ({ model, provider, context }: ModelIdentity): ModelIdentity => ({ model, ...(provider === undefined ? {} : { provider }), ...(context === undefined ? {} : { context }) });

/** One model selection; normalization and bounds are applied by the accounting owner. */
export function modelSelection(model: WorkerModelUsage, status: 'reported' | 'launched' = 'reported'): Extract<ExecutionIdentity, { status: 'reported' | 'launched' }> {
  return { status, source: model.source, primary: primaryOf(model), models: [model] };
}

/** Identity and usage share a failure boundary and cannot change the run's outcome. */
export class ExecutionAccounting {
  identity: ExecutionIdentity = { status: 'unknown', reason: 'harness_did_not_report_model_and_launch_choice_unresolved' };
  totals: WorkerUsage | null = null;
  private failure: Extract<ExecutionIdentity, { status: 'unknown' }> | null = null;
  private preferred: ModelIdentity | null = null;

  constructor(private readonly primarySources: readonly string[] = []) {}

  private record(operation: () => void): void {
    const result = accountingEvidence(operation);
    if (result.error !== undefined) this.failure = result.error;
    if (this.failure !== null) this.identity = this.failure;
  }

  observe(identity: ExecutionIdentity, snapshot = false): void {
    this.record(() => {
      const next = parseExecutionIdentity(identity);
      if (next.status === 'unknown') { this.failure = next; return; }
      const previous = this.identity;
      if (previous.status === 'reported' && next.status === 'launched') return;
      if (this.primarySources.includes(next.source)) this.preferred = next.primary;
      const models = new Map<string, WorkerModelUsage>();
      if (!snapshot && previous.status === next.status) for (const model of previous.models) models.set(modelKey(model), model);
      for (const model of next.models) {
        const before = models.get(modelKey(model));
        const enriched = model.usage === null && before?.usage != null ? { ...model, usage: before.usage } : model;
        models.set(modelKey(model), before?.context === undefined || model.context !== undefined ? enriched : { ...enriched, context: before.context });
      }
      const preferred = this.preferred === null ? undefined : models.get(modelKey(this.preferred));
      const selected = preferred ?? models.get(modelKey(next.primary))!;
      const warnings = [...(previous.status === 'unknown' ? [] : previous.warnings ?? []), ...(next.warnings ?? [])];
      this.identity = parseExecutionIdentity({ ...next, primary: primaryOf(selected), models: [...models.values()], ...(warnings.length === 0 ? {} : { warnings }) });
    });
  }

  usage(usage: WorkerUsage): void {
    this.record(() => {
      const { models: _models, model: _model, provider: _provider, ...raw } = usage;
      const tokens = parseWorkerUsage(raw);
      if (Object.values(tokens).some((value) => typeof value === 'number')) this.totals = tokens;
      else if (this.totals !== null && tokens.tokenScope !== undefined) this.totals = { ...this.totals, tokenScope: tokens.tokenScope };
      const warnings: string[] = [];
      const parsed = parseWorkerUsage(usage, warnings);
      if (this.failure !== null) return;
      if (parsed.models !== undefined) {
        const previous = this.identity;
        const primary = previous.status === 'reported' && parsed.models.find((m) => modelKey(m) === modelKey(previous.primary));
        const dominant = [...parsed.models].sort((a, b) => ((b.usage?.inputTokens ?? 0) + (b.usage?.outputTokens ?? 0)) - ((a.usage?.inputTokens ?? 0) + (a.usage?.outputTokens ?? 0)) || a.model.localeCompare(b.model))[0]!;
        const selected = primary || dominant;
        this.observe({ status: 'reported', source: selected.source, primary: primaryOf(selected), models: parsed.models, ...(warnings.length === 0 ? {} : { warnings }) });
      } else if (parsed.model !== undefined) {
        const observed = this.identity.status === 'unknown' ? undefined : this.identity.models.find((m) => m.model === parsed.model && m.provider === parsed.provider);
        const several = this.identity.status !== 'unknown' && this.identity.models.length > 1;
        const attributed = several ? (parsed.tokenScope === undefined ? null : { ...tokens, costUsd: null, estimatedCostUsd: null }) : tokens;
        this.observe({ ...modelSelection({ model: parsed.model, ...(parsed.provider === undefined ? {} : { provider: parsed.provider }), source: observed?.source ?? 'harness.usage', usage: attributed }), ...(warnings.length === 0 ? {} : { warnings }) });
      } else if (this.identity.status !== 'unknown' && this.identity.models.length === 1) {
        this.observe({ ...this.identity, models: this.identity.models.map((m) => ({ ...m, usage: tokens })) });
      }
    });
  }
}
