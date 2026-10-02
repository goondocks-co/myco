import type { WorkerUsage, WorkerModelUsage } from '@goondocks/myco-shared/worker-usage';
import { harnessById, type HarnessAccounting } from '../harnesses.js';
import { accountingEvents, modelSelection, reportedDollars, reportedModel } from '../accounting.js';
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

/** What a call's events carry for its step: the agent's own kind of the call, and the input and locations it named. */
interface CallFacts {
  category?: string;
  input?: Record<string, unknown>;
}

/** The kinds of call the agent protocol defines; a call of any other kind reads as `other`. */
const ACP_TOOL_KINDS: ReadonlySet<string> = new Set(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other']);

/** A call update's step facts: its protocol kind, and its raw input and locations where it carries them; never its free-text title. */
function factsOf(update: Record<string, unknown>): CallFacts {
  const kind = stringOf(update.kind);
  const category = kind === null ? null : ACP_TOOL_KINDS.has(kind) ? kind : 'other';
  const rawInput = recordOf(update.rawInput);
  const locations = Array.isArray(update.locations) ? update.locations : undefined;
  const input = rawInput === null && locations === undefined ? undefined
    : { ...(rawInput === null ? {} : { rawInput }), ...(locations === undefined ? {} : { locations }) };
  return { ...(category === null ? {} : { category }), ...(input === undefined ? {} : { input }) };
}

/** Only the facts that are present, so an event carries no key holding undefined. */
const stepFacts = (facts: { category?: string; input?: Record<string, unknown> }): CallFacts =>
  ({ ...(facts.category === undefined ? {} : { category: facts.category }), ...(facts.input === undefined ? {} : { input: facts.input }) });

/** The session updates this driver reads; any other is counted as unrecognized. */
const READ_UPDATES: readonly string[] = ['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'config_option_update', 'current_model_update', 'usage_update'];

/** One newly created ACP session and its reported accounting. */
export class AcpEvents {
  private readonly calls = new Map<string, { name: string; status: RunToolStatus | null } & CallFacts>();
  /** Calls this client refused, whose failure is final. */
  private readonly refusals = new Set<string>();
  private model: string | null;
  private modelSource: string;
  private readonly models = new Map<string, WorkerModelUsage>();
  private readonly used = new Set<string>();
  private selected: string | null = null;
  private estimatedCostUsd: number | null = null;

  /**
   * `warnings` are what the identity says about how the run's profile was applied, carried on every identity this
   * session reports.
   */
  constructor(private readonly harness: string, private readonly version: string | null, session: Record<string, unknown>, private readonly policy: HarnessAccounting = harnessById(harness)!.accounting, private readonly warnings: readonly string[] = []) {
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
      yield* this.call(id, raw !== null && Object.hasOwn(TOOL_STATUS, raw) ? TOOL_STATUS[raw as keyof typeof TOOL_STATUS] : null, factsOf(update));
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
      if (cost?.currency === 'USD' && amount !== null && amount >= 0) this.estimatedCostUsd = reportedDollars(this.policy, amount);
      if (this.selected !== null && ((cost?.currency === 'USD' && amount !== null && amount > 0) || (numberOf(update.used) ?? 0) > 0)) this.used.add(this.selected);
    }
    if (typeof type !== 'string' || !READ_UPDATES.includes(type)) yield { kind: 'unrecognized', shape: `session/update:${typeof type === 'string' ? type : 'untyped'}` };
  }

  /**
   * A call this client refused the agent, as that call's failure. The refusal
   * is the call's outcome: whatever the agent reports about the call afterwards,
   * failed or completed, changes nothing.
   */
  *refused(toolCall: Record<string, unknown>, detail: string): Iterable<RunEvent> {
    const id = stringOf(toolCall.toolCallId);
    const name = factsOf(toolCall).category ?? (id === null ? undefined : this.calls.get(id)?.name) ?? 'tool';
    const facts = { ...(id === null ? {} : this.calls.get(id)), ...factsOf(toolCall) };
    if (id !== null) {
      if (this.refusals.has(id)) return;
      this.refusals.add(id);
      this.calls.set(id, { name, status: 'error', ...facts });
    }
    yield { kind: 'tool_call', name, status: 'error', detail, refused: true, ...(id === null ? {} : { callId: id }), ...stepFacts(facts) };
  }

  /**
   * A call's status, reported when it changes, and never after the call was refused. A call is named by the agent's own
   * kind of it, never by its free-text title.
   */
  private *call(id: string, status: RunToolStatus | null, facts: CallFacts): Iterable<RunEvent> {
    if (this.refusals.has(id)) return;
    const previous = this.calls.get(id);
    const name = facts.category ?? previous?.name ?? 'tool';
    const known = { category: facts.category ?? previous?.category, input: facts.input ?? previous?.input };
    this.calls.set(id, { name, status: status ?? previous?.status ?? null, ...stepFacts(known) });
    if (status !== null && status !== previous?.status) yield { kind: 'tool_call', name, status, callId: id, ...stepFacts(known) };
  }

  *identity(source = this.modelSource): Iterable<RunEvent> {
    yield* accountingEvents(() => {
      if (this.model === null) return [];
      const model = reportedModel(harnessById(this.harness)!, this.model, source);
      const key = JSON.stringify([model.provider, model.model]);
      if (this.selected !== null && !this.used.has(this.selected)) this.models.delete(this.selected);
      this.models.set(key, model);
      this.selected = key;
      return [{ kind: 'identity', snapshot: true, identity: { ...modelSelection(model), models: [...this.models.values()], ...(this.warnings.length === 0 ? {} : { warnings: [...this.warnings] }) } }];
    });
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
