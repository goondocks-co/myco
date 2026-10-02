import { accountingEvents, modelSelection, reportedModel } from '../accounting.js';
import type { Harness } from '../harnesses.js';
import type { RunEvent } from '../events.js';
import { claudeUsage } from './usage.js';
import { numberOf, recordOf, stringOf } from './stream.js';

/** Claude's message cache writes are keyed by message id; a repeated observation replaces that message's counts. */
export class ClaudeAccounting {
  private primaryModel: string | undefined;
  private messages = new Map<string, { model: string; cacheCreation5mTokens: number; cacheCreation1hTokens: number }>();

  constructor(private readonly harness: Harness, private readonly environment: Record<string, string | undefined>) {}

  events(line: Record<string, unknown>): RunEvent[] {
    return accountingEvents(() => {
      if (line.type === 'result') {
        const cacheWrites = new Map<string, { cacheCreation5mTokens: number; cacheCreation1hTokens: number }>();
        for (const row of this.messages.values()) {
          const old = cacheWrites.get(row.model);
          cacheWrites.set(row.model, { cacheCreation5mTokens: (old?.cacheCreation5mTokens ?? 0) + row.cacheCreation5mTokens, cacheCreation1hTokens: (old?.cacheCreation1hTokens ?? 0) + row.cacheCreation1hTokens });
        }
        return [{ kind: 'usage', ...claudeUsage(line, { environment: this.environment, primaryModel: this.primaryModel, cacheWrites }) }];
      }
      const init = line.type === 'system' && line.subtype === 'init';
      const message = line.type === 'assistant' ? recordOf(line.message) : null;
      const name = stringOf(init ? line.model : message?.model);
      if (name === null || name === '<synthetic>') return [];
      const model = reportedModel(this.harness, name, init ? 'system.init.model' : 'assistant.message.model', null, undefined, this.environment);
      if (init && line.parent_tool_use_id == null) this.primaryModel = model.model;
      const id = stringOf(message?.id);
      const cache = recordOf(recordOf(message?.usage)?.cache_creation);
      const cacheCreation5mTokens = numberOf(cache?.ephemeral_5m_input_tokens);
      const cacheCreation1hTokens = numberOf(cache?.ephemeral_1h_input_tokens);
      if (id !== null && cacheCreation5mTokens !== null && cacheCreation1hTokens !== null) {
        this.messages.set(id, { model: model.model, cacheCreation5mTokens, cacheCreation1hTokens });
      }
      return [{ kind: 'identity', identity: modelSelection(model) }];
    });
  }
}
