import type { WorkerUsage } from '@goondocks/myco-shared/worker-usage';
import type { RunEvent } from '../events.js';
import { numberOf, recordOf, stringOf } from './stream.js';

const TOOL_STATUS = { pending: 'started', in_progress: 'started', completed: 'ok', failed: 'error' } as const;
type RunToolStatus = (typeof TOOL_STATUS)[keyof typeof TOOL_STATUS];
const LAST_RESPONSE_VERSIONS = new Set(['1.18.21', '1.18.29']);

function countOf(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid ACP token count');
  return value;
}

function modelOf(value: Record<string, unknown>): string | null {
  const options = Array.isArray(value.configOptions) ? value.configOptions.map(recordOf) : [];
  const model = options.find((option) => option?.category === 'model' || option?.id === 'model');
  return stringOf(model?.currentValue) ?? stringOf(recordOf(value.models)?.currentModelId);
}

/** One newly created ACP session and its reported accounting. */
export class AcpEvents {
  private readonly calls = new Map<string, { name: string; status: RunToolStatus | null }>();
  private model: string | null;
  private estimatedCostUsd: number | null = null;

  constructor(private readonly harness: string, private readonly version: string | null, session: Record<string, unknown>) {
    this.model = modelOf(session);
  }

  *update(message: Record<string, unknown>, sessionId: string): Iterable<RunEvent> {
    if (message.method !== 'session/update') return;
    const params = recordOf(message.params);
    if (params?.sessionId !== sessionId) return;
    const update = recordOf(params.update);
    if (update === null) return;
    const type = update.sessionUpdate;
    if (type === 'agent_message_chunk' || type === 'agent_thought_chunk') {
      const text = stringOf(recordOf(update.content)?.text);
      if (text !== null) yield { kind: 'message', role: type === 'agent_thought_chunk' ? 'thought' : 'assistant', text };
    } else if (type === 'tool_call' || type === 'tool_call_update') {
      const id = stringOf(update.toolCallId);
      if (id === null) return;
      const raw = stringOf(update.status);
      yield* this.call(id, stringOf(update.title), raw !== null && Object.hasOwn(TOOL_STATUS, raw) ? TOOL_STATUS[raw as keyof typeof TOOL_STATUS] : null);
    } else if (type === 'config_option_update') {
      this.model = modelOf(update) ?? this.model;
    } else if (type === 'current_model_update') {
      this.model = stringOf(update.currentModelId) ?? this.model;
    } else if (type === 'usage_update') {
      const cost = recordOf(update.cost);
      const amount = numberOf(cost?.amount);
      if (cost?.currency === 'USD' && amount !== null && amount > 0) this.estimatedCostUsd = amount;
    }
  }

  /**
   * A call this client refused the agent, as that call's failure. The agent
   * reports the refused call failed as well, and that is the same outcome.
   */
  *refused(params: Record<string, unknown>, sessionId: string): Iterable<RunEvent> {
    if (params.sessionId !== sessionId) return;
    const toolCall = recordOf(params.toolCall);
    const id = stringOf(toolCall?.toolCallId);
    const title = stringOf(toolCall?.title);
    if (id === null) yield { kind: 'tool_call', name: title ?? 'tool', status: 'error' };
    else yield* this.call(id, title, 'error');
  }

  /** A call's status, reported when it changes. */
  private *call(id: string, title: string | null, status: RunToolStatus | null): Iterable<RunEvent> {
    const previous = this.calls.get(id);
    const name = title ?? previous?.name ?? 'tool';
    this.calls.set(id, { name, status: status ?? previous?.status ?? null });
    if (status !== null && status !== previous?.status) yield { kind: 'tool_call', name, status };
  }

  usage(result: Record<string, unknown>): WorkerUsage {
    const reported = recordOf(result.usage);
    const fresh = countOf(reported?.inputTokens);
    const cached = countOf(reported?.cachedReadTokens);
    const written = countOf(reported?.cachedWriteTokens);
    const output = countOf(reported?.outputTokens);
    const isOpenCode = this.harness === 'opencode';
    const separator = isOpenCode ? this.model?.indexOf('/') ?? -1 : -1;
    return {
      inputTokens: fresh === null ? null : fresh + (cached ?? 0) + (written ?? 0),
      outputTokens: output,
      cachedTokens: cached,
      cacheCreationTokens: written,
      reasoningTokens: countOf(reported?.thoughtTokens),
      costUsd: null,
      estimatedCostUsd: this.estimatedCostUsd,
      ...(fresh === null && output === null ? {} : {
        tokenScope: isOpenCode && LAST_RESPONSE_VERSIONS.has(this.version ?? '') ? 'last_response' as const : 'unverified' as const,
      }),
      ...(this.model === null ? {} : { model: separator > 0 ? this.model.slice(separator + 1) : this.model }),
      ...(separator > 0 ? { provider: this.model!.slice(0, separator) } : {}),
    };
  }
}
