import type { OutboundFetch, RelationalStore, SecretWrappingKey } from '../adapters.js';
import { storedSettings } from '../settings.js';
import { openCompletionCredential } from '../provider-credentials.js';
import { providerHttp } from '../provider-http.js';
import { boundedCompletion, completionInput, CompletionUnavailable, DEFAULT_COMPLETION_MODEL, type CompletionProvider } from './provider.js';

export interface CompletionPlatform {
  target: 'bun' | 'cloudflare';
  bindingProvider?: (model: string) => CompletionProvider;
}

/** The model and optional HTTP endpoint selected by Deployment settings. */
export async function configuredCompletionProvider(db: RelationalStore, key: SecretWrappingKey, outbound: OutboundFetch, platform: CompletionPlatform): Promise<CompletionProvider | null> {
  const settings = await storedSettings(db, ['single_turn.model', 'single_turn.base_url']);
  const value = (leaf: string): string | undefined => {
    const row = settings.get(leaf);
    return row?.violation === null && typeof row.value === 'string' ? row.value : undefined;
  };
  const model = value('single_turn.model') ?? (platform.target === 'cloudflare' ? DEFAULT_COMPLETION_MODEL : null);
  const base = value('single_turn.base_url');
  if (model === null) return null;
  if (base === undefined) return platform.bindingProvider?.(model) ?? null;
  const credential = await openCompletionCredential(db, key);
  const post = providerHttp(outbound, (response, kind) => new CompletionUnavailable(kind, response.status));
  return {
    model,
    complete: (request) => boundedCompletion(async signal => {
      const response = await post({ url: `${base.replace(/\/$/, '')}/chat/completions`, credential, signal, body: { model, ...completionInput(request) } });
      try { return await response.json(); } catch { throw new CompletionUnavailable('invalid_response'); }
    }, request.timeoutMs),
  };
}
