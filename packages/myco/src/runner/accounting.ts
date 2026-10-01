import { parseExecutionIdentity, type ExecutionIdentity, type WorkerModelUsage, type WorkerUsage } from '@goondocks/myco-shared/worker-usage';
import type { Harness } from './harnesses.js';

/** Decode the provider syntax declared by the runner manifest. */
export function reportedModel(harness: Harness, model: string, source: string, usage: WorkerUsage | null = null, provider?: string): WorkerModelUsage {
  if (!harness.accounting.modelSources.includes(source) && !(source === 'launch.config.model' && harness.accounting.launchFallback === 'resolved-config')) throw new Error(`Undeclared model source: ${source}`);
  const policy = harness.accounting.provider;
  const separator = policy.kind === 'model-prefix' ? model.indexOf('/') : -1;
  return {
    model: separator > 0 ? model.slice(separator + 1) : model,
    ...(provider !== undefined ? { provider } : policy.kind === 'fixed' ? { provider: policy.id }
      : separator > 0 ? { provider: model.slice(0, separator) } : {}),
    source, usage,
  };
}

/** One explicit model selection, carrying the evidence that named it. */
export function modelSelection(model: WorkerModelUsage, status: 'reported' | 'launched' = 'reported'): Extract<ExecutionIdentity, { status: 'reported' | 'launched' }> {
  const identity = parseExecutionIdentity({ status, source: model.source, primary: { model: model.model, ...(model.provider === undefined ? {} : { provider: model.provider }) }, models: [model] });
  if (identity.status === 'unknown') throw new Error('A model selection requires a model identity');
  return identity;
}

/** Reported models replace launch intent; repeated observations enrich the same model's accounting. */
export class ExecutionAccounting {
  identity: ExecutionIdentity = { status: 'unknown', reason: 'harness_did_not_report_model_and_launch_choice_unresolved' };

  observe(identity: ExecutionIdentity, snapshot = false): void {
    const next = parseExecutionIdentity(identity);
    if (next.status === 'unknown') return;
    const previous = this.identity;
    if (previous.status === 'reported' && next.status === 'launched') return;
    const models = new Map<string, WorkerModelUsage>();
    const key = (m: WorkerModelUsage) => JSON.stringify([m.provider, m.model]);
    if (!snapshot && previous.status === next.status) for (const model of previous.models) models.set(key(model), model);
    for (const model of next.models) {
      const before = models.get(key(model));
      models.set(key(model), model.usage === null && before?.usage != null ? { ...model, usage: before.usage } : model);
    }
    this.identity = { ...next, models: [...models.values()] };
  }

  usage(usage: WorkerUsage): void {
    const { models: _models, model: _model, provider: _provider, ...tokens } = usage;
    if (usage.models !== undefined) {
      const previous = this.identity;
      const primary = previous.status === 'reported' && usage.models.find((m) => m.model === previous.primary.model && m.provider === previous.primary.provider);
      const dominant = [...usage.models].sort((a, b) => ((b.usage?.inputTokens ?? 0) + (b.usage?.outputTokens ?? 0)) - ((a.usage?.inputTokens ?? 0) + (a.usage?.outputTokens ?? 0)) || a.model.localeCompare(b.model))[0]!;
      const selected = primary || dominant;
      this.observe({ status: 'reported', source: selected.source, primary: { model: selected.model, ...(selected.provider === undefined ? {} : { provider: selected.provider }) }, models: usage.models });
    } else if (usage.model !== undefined) {
      const observed = this.identity.status === 'unknown' ? undefined : this.identity.models.find((m) => m.model === usage.model && m.provider === usage.provider);
      const several = this.identity.status !== 'unknown' && this.identity.models.length > 1;
      const attributed = several ? (usage.tokenScope === undefined ? null : { ...tokens, costUsd: null, estimatedCostUsd: null }) : tokens;
      this.observe(modelSelection({ model: usage.model, ...(usage.provider === undefined ? {} : { provider: usage.provider }), source: observed?.source ?? 'harness.usage', usage: attributed }));
    } else if (this.identity.status !== 'unknown' && this.identity.models.length === 1) {
      this.observe({ ...this.identity, models: this.identity.models.map((m) => ({ ...m, usage: tokens })) });
    }
  }
}
