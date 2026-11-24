import type { QuickJobs, QuickJobsAnswerer } from '@goondocks/myco-shared/settings-contract';
import type { OutboundFetch, RelationalStore, SecretWrappingKey } from '../adapters.js';
import { storedSettings } from '../settings.js';
import { openCompletionCredential } from '../provider-credentials.js';
import { providerHttp } from '../provider-http.js';
import { boundedCompletion, completionInput, CompletionUnavailable, DEFAULT_COMPLETION_MODEL, type CompletionProvider } from './provider.js';

export interface CompletionPlatform {
  target: 'bun' | 'cloudflare';
  bindingProvider?: (model: string) => CompletionProvider;
}

/** The answerers each target can use: only Cloudflare includes a model, and only there is no model left to a runner. */
const QUICK_JOBS_OFFERED: Readonly<Record<CompletionPlatform['target'], readonly QuickJobsAnswerer[]>> = {
  cloudflare: ['included', 'address'],
  bun: ['address', 'runner'],
};

export type QuickJobsRoute =
  | { answeredBy: 'runner' }
  | { answeredBy: 'included'; model: string }
  | { answeredBy: 'address'; model: string; base: string };

/** Cloudflare's model service names each of its models with a leading `@`, as `@cf/…` or `@hf/…`. */
const includedModel = (model: string | undefined): string => (model?.startsWith('@') ? model : DEFAULT_COMPLETION_MODEL);

/**
 * Who answers quick jobs on `target` given the stored model and address: an address needs both, the included model
 * never takes a model name meant for an address, and a runner takes what no model answers.
 */
export function quickJobsRoute(target: CompletionPlatform['target'], stored: { model?: string; base?: string }): QuickJobsRoute {
  if (stored.base !== undefined && stored.model !== undefined) return { answeredBy: 'address', model: stored.model, base: stored.base };
  return target === 'cloudflare' && stored.base === undefined ? { answeredBy: 'included', model: includedModel(stored.model) } : { answeredBy: 'runner' };
}

/** The stored model and address, each only where its stored value applies. */
async function storedRoute(db: RelationalStore, target: CompletionPlatform['target']): Promise<QuickJobsRoute> {
  const settings = await storedSettings(db, ['single_turn.model', 'single_turn.base_url']);
  const value = (leaf: string): string | undefined => {
    const row = settings.get(leaf);
    return row?.violation === null && typeof row.value === 'string' ? row.value : undefined;
  };
  return quickJobsRoute(target, { model: value('single_turn.model'), base: value('single_turn.base_url') });
}

/** Who answers quick jobs now, and which answerers this target offers. */
export async function readQuickJobs(db: RelationalStore, target: CompletionPlatform['target']): Promise<QuickJobs> {
  return { answeredBy: (await storedRoute(db, target)).answeredBy, offered: QUICK_JOBS_OFFERED[target] };
}

/** The model and optional HTTP endpoint selected by Deployment settings. */
export async function configuredCompletionProvider(db: RelationalStore, key: SecretWrappingKey, outbound: OutboundFetch, platform: CompletionPlatform): Promise<CompletionProvider | null> {
  const route = await storedRoute(db, platform.target);
  if (route.answeredBy === 'runner') return null;
  if (route.answeredBy === 'included') return platform.bindingProvider?.(route.model) ?? null;
  const { model, base } = route;
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
