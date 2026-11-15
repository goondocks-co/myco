import { boundedCompletion, completionInput, type CompletionProvider } from '../../core/completion/provider.js';
import type { CompletionRequest } from '../../core/completion/provider.js';

export interface CompletionBinding {
  run(model: string, input: Omit<ReturnType<typeof completionInput>, 'response_format'> & { response_format?: { type: string; json_schema: Record<string, unknown> } }, options?: { signal?: AbortSignal }): Promise<unknown>;
}

/** Workers AI accepts its schema directly beneath response_format. */
export function cloudflareCompletionProvider(ai: CompletionBinding, model: string): CompletionProvider {
  return { model, complete: (request: CompletionRequest) => boundedCompletion(signal => {
    const input = completionInput(request);
    return ai.run(model, { ...input, ...(request.schema === undefined ? {} : {
      response_format: { type: 'json_schema', json_schema: request.schema },
    }) }, { signal });
  }, request.timeoutMs) };
}
