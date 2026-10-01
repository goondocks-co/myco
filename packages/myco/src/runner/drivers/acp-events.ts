import type { WorkerUsage, WorkerModelUsage } from '@goondocks/myco-shared/worker-usage';
import { harnessById } from '../harnesses.js';
import { modelSelection, reportedModel } from '../accounting.js';
import type { RunEvent } from '../events.js';
import { numberOf, recordOf, stringOf } from './stream.js';

const TOOL_STATUS = { pending: 'started', in_progress: 'started', completed: 'ok', failed: 'error' } as const;
type RunToolStatus = (typeof TOOL_STATUS)[keyof typeof TOOL_STATUS];

function countOf(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid ACP token count');
  return value;
}

function modelOf(value: Record<string, unknown>): { model: string; source: string } | null {
  const options = Array.isArray(value.configOptions) ? value.configOptions.map(recordOf) : [];
  const model = options.find((option) => option?.category === 'model' || option?.id === 'model');
  const configured = stringOf(model?.currentValue);
  if (configured !== null) return { model: configured, source: 'session.configOptions' };
  const selected = stringOf(recordOf(value.models)?.currentModelId);
  return selected === null ? null : { model: selected, source: 'session.models' };
}

/** One newly created ACP session and its reported accounting. */
export class AcpEvents {
  private readonly calls = new Map<string, { name: string; status: RunToolStatus | null }>();
  /** Calls this client refused, whose failure is final. */
  private readonly refusals = new Set<string>();
  private model: string | null;
  private modelSource: string;
  private readonly models = new Map<string, WorkerModelUsage>();
  private readonly used = new Set<string>();
  private selected: string | null = null;
  private estimatedCostUsd: number | null = null;

  constructor(private readonly harness: string, private readonly version: string | null, session: Record<string, unknown>) {
    const selected = modelOf(session);
    this.model = selected?.model ?? null;
    this.modelSource = selected?.source ?? 'session.models';
  }

  *update(message: Record<string, unknown>, sessionId: string): Iterable<RunEvent> {
    if (message.method !== 'session/update') return;
    const params = recordOf(message.params);
    if (params?.sessionId !== sessionId) return;
    const update = recordOf(params.update);
    if (update === null) return;
    const type = update.sessionUpdate;
    if (type === 'agent_message_chunk' || type === 'agent_thought_chunk') {
      if (this.selected !== null) this.used.add(this.selected);
      const text = stringOf(recordOf(update.content)?.text);
      if (text !== null) yield { kind: 'message', role: type === 'agent_thought_chunk' ? 'thought' : 'assistant', text };
    } else if (type === 'tool_call' || type === 'tool_call_update') {
      if (this.selected !== null) this.used.add(this.selected);
      const id = stringOf(update.toolCallId);
      if (id === null) return;
      const raw = stringOf(update.status);
      yield* this.call(id, stringOf(update.title), raw !== null && Object.hasOwn(TOOL_STATUS, raw) ? TOOL_STATUS[raw as keyof typeof TOOL_STATUS] : null);
    } else if (type === 'config_option_update') {
      const selected = modelOf(update);
      if (selected !== null) { this.model = selected.model; this.modelSource = selected.source; }
      yield* this.identity();
    } else if (type === 'current_model_update') {
      const selected = stringOf(update.currentModelId);
      if (selected !== null) { this.model = selected; this.modelSource = 'session.currentModelId'; }
      yield* this.identity();
    } else if (type === 'usage_update') {
      const cost = recordOf(update.cost);
      const amount = numberOf(cost?.amount);
      if (cost?.currency === 'USD' && amount !== null && amount >= 0) this.estimatedCostUsd = amount;
      if (this.selected !== null && ((cost?.currency === 'USD' && amount !== null && amount > 0) || (numberOf(update.used) ?? 0) > 0)) this.used.add(this.selected);
    }
  }

  /**
   * A call this client refused the agent, as that call's failure. The refusal
   * is the call's outcome: whatever the agent reports about the call afterwards,
   * failed or completed, changes nothing.
   */
  *refused(toolCall: Record<string, unknown>, detail: string): Iterable<RunEvent> {
    const id = stringOf(toolCall.toolCallId);
    const name = stringOf(toolCall.title) ?? (id === null ? undefined : this.calls.get(id)?.name) ?? 'tool';
    if (id !== null) {
      if (this.refusals.has(id)) return;
      this.refusals.add(id);
      this.calls.set(id, { name, status: 'error' });
    }
    yield { kind: 'tool_call', name, status: 'error', detail };
  }

  /** A call's status, reported when it changes, and never after the call was refused. */
  private *call(id: string, title: string | null, status: RunToolStatus | null): Iterable<RunEvent> {
    if (this.refusals.has(id)) return;
    const previous = this.calls.get(id);
    const name = title ?? previous?.name ?? 'tool';
    this.calls.set(id, { name, status: status ?? previous?.status ?? null });
    if (status !== null && status !== previous?.status) yield { kind: 'tool_call', name, status };
  }

  *identity(source = this.modelSource): Iterable<RunEvent> {
    if (this.model === null) return;
    const model = reportedModel(harnessById(this.harness)!, this.model, source);
    const key = JSON.stringify([model.provider, model.model]);
    if (this.selected !== null && !this.used.has(this.selected)) this.models.delete(this.selected);
    this.models.set(key, model);
    this.selected = key;
    yield { kind: 'identity', snapshot: true, identity: { ...modelSelection(model), models: [...this.models.values()] } };
  }

  usage(result: Record<string, unknown>): WorkerUsage {
    const reported = recordOf(result.usage);
    const fresh = countOf(reported?.inputTokens);
    const cached = countOf(reported?.cachedReadTokens);
    const written = countOf(reported?.cachedWriteTokens);
    const output = countOf(reported?.outputTokens);
    const harness = harnessById(this.harness)!;
    const selected = this.model === null ? null : reportedModel(harness, this.model, this.modelSource);
    return {
      inputTokens: fresh === null ? null : fresh + (cached ?? 0) + (written ?? 0),
      outputTokens: output,
      cachedTokens: cached,
      cacheCreationTokens: written,
      reasoningTokens: countOf(reported?.thoughtTokens),
      costUsd: null,
      estimatedCostUsd: this.estimatedCostUsd,
      ...((fresh === null && output === null) || harness.accounting.tokenScope === 'attempt' ? {} : {
        tokenScope: harness.accounting.lastResponseVersions?.includes(this.version ?? '') === true ? 'last_response' as const : 'unverified' as const,
      }),
      ...(selected === null ? {} : { model: selected.model, ...(selected.provider === undefined ? {} : { provider: selected.provider }) }),
    };
  }
}
