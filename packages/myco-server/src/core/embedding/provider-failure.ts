import { EmbeddingUnavailable, embeddingDiagnostic, inputRefusal } from './provider.js';
import { VECTOR_DIMENSIONS } from './vectors.js';

const RETRY_BASE_MS = 60_000;
export const PROVIDER_PAUSE_RETRY_MS = 60 * 60_000;
const RETRY_MAX_MS = 60 * 60_000;

/** A failure of the new model, which holds off or pauses the switch rather than failing the run. */
export class EmbeddingSwitchFailure extends Error {
  constructor(readonly failure: unknown) { super(failure instanceof Error ? failure.message : String(failure)); }
}

/**
 * The provider failure policy: pass this one source over, hold the model off until `until`, or
 * pause for an admin.
 */
export type SwitchFailureAction =
  | { action: 'skip'; reason: string }
  | { action: 'wait'; until: number; reason: string }
  | { action: 'pause'; reason: string };

/** The wait after the switch's `failures`-th failure in a row. */
const backoff = (failures: number): number => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures, 16));

/**
 * What a failure of the embedding model does, in the reader's words. A refusal of one source's text passes that source over;
 * a provider that is busy, slow, unreachable or out of its daily quota is asked again later; one that turns the key
 * down, refuses the request, or answers with results too large for search waits for a configuration change or an admin retry.
 */
export function providerFailureAction(error: unknown, failures: number, now: number): SwitchFailureAction {
  const later = (reason: string, at = now + backoff(failures)): SwitchFailureAction => ({ action: 'wait', until: at, reason });
  const pause = (reason: string): SwitchFailureAction => ({ action: 'pause', reason });
  const refused = inputRefusal(error);
  if (refused !== null) return { action: 'skip', reason: refused };
  if (error instanceof EmbeddingUnavailable) {
    const failure = error.failure;
    const diagnostic = ` (${embeddingDiagnostic(failure)})`;
    switch (failure.kind) {
      case 'input':
        return { action: 'skip', reason: 'the model refused its text' };
      case 'quota':
        return later(`The embedding model's daily allowance is used up${diagnostic}. Myco tries again when it renews.`, failure.resetsAt);
      case 'timeout':
        return later(`The embedding model's provider did not answer in time${diagnostic}. Myco tries again shortly.`);
      case 'unreachable':
        return later(`Myco could not reach the embedding model's provider${diagnostic}. It tries again shortly.`);
      case 'http': {
        const { status } = failure;
        if (status === 401 || status === 403) return pause(`The embedding model's provider turned down its key (HTTP ${status})${diagnostic}. Check the key under Provider keys, then resume.`);
        if (status === 429) return later(`The embedding model's provider asked Myco to slow down (HTTP 429)${diagnostic}. Myco tries again when it allows more.`, now + Math.max(backoff(failures), failure.retryAfterMs ?? 0));
        if (status >= 500 || status === 408) return later(`The embedding model's provider had a problem (HTTP ${status})${diagnostic}. Myco tries again shortly.`);
        return pause(`The embedding model's provider refused the request (HTTP ${status})${diagnostic}. Check the model name and the server it runs on, then resume.`);
      }
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/dimensions/.test(message)) {
    return pause(`The embedding model's results are too large for search, which holds up to ${VECTOR_DIMENSIONS} numbers for each. Cancel the switch and choose a smaller model.`);
  }
  return later('The embedding model\'s provider answered with something search cannot use. Myco tries again shortly.');
}
