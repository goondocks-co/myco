import type { OutboundFetch, RelationalStore, SecretWrappingKey } from '../adapters.js';
import { settingTexts } from '../settings.js';
import { openCompletionCredential } from '../provider-credentials.js';
import { boundedCompletion, completionInput, CompletionUnavailable, DEFAULT_COMPLETION_MODEL, type CompletionProvider } from './provider.js';

export interface CompletionPlatform {
  target: 'bun' | 'cloudflare';
  bindingProvider?: (model: string) => CompletionProvider;
}

/** The model and optional HTTP endpoint selected by Deployment settings. */
export async function configuredCompletionProvider(db: RelationalStore, key: SecretWrappingKey, outbound: OutboundFetch, platform: CompletionPlatform): Promise<CompletionProvider | null> {
  const settings = await settingTexts(db, ['single_turn.model', 'single_turn.base_url']);
  const model = (settings.has('single_turn.model') ? JSON.parse(settings.get('single_turn.model')!) as string : null) ?? (platform.target === 'cloudflare' ? DEFAULT_COMPLETION_MODEL : null);
  const base = settings.has('single_turn.base_url') ? JSON.parse(settings.get('single_turn.base_url')!) as string : undefined;
  if (model === null) return null;
  if (base === undefined) return platform.bindingProvider?.(model) ?? null;
  const credential = await openCompletionCredential(db, key);
  return {
    model,
    complete: (request) => boundedCompletion(async signal => {
      const response = await outbound(`${base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'content-type': 'application/json', ...(credential === null ? {} : { authorization: `Bearer ${credential}` }) },
        body: JSON.stringify({ model, ...completionInput(request) }),
      });
      if (!response.ok) throw new CompletionUnavailable('http', response.status);
      try { return await response.json(); } catch { throw new CompletionUnavailable('invalid_response'); }
    }, request.timeoutMs),
  };
}
