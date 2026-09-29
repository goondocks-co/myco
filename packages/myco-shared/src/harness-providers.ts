/**
 * Which provider each harness authenticates against, and the variable it reads
 * its credential under.
 *
 * A harness is not a provider: `claude` reads Anthropic's variables and `agy`
 * reads Google's, and handing one the other's key is a failure that looks like
 * a bad credential rather than like a wrong table. The server opens a
 * Deployment secret by this, and the worker's manifest declares the same ids,
 * so the two cannot name different harnesses.
 *
 * A harness absent here has no Deployment credential to inject and runs under
 * its own login, which is the ordinary case on a machine a person uses.
 *
 * A harness reads the Deployment secret slot named here and no other
 * (`secret-slots.ts`). Codex reads a slot of its own rather than the `openai`
 * slot the embedding provider reads: a key stored for embeddings is not a login
 * for every Codex run (#1212). A harness whose slot is null, or empty, runs
 * under the worker machine's own login.
 */
import type { SecretSlotName } from './secret-slots.js';

export type HarnessProvider = 'anthropic' | 'openai' | 'google';

export interface HarnessCredential {
  provider: HarnessProvider;
  /** The Deployment secret slot the harness's runs read, or null where the Deployment holds none for it. */
  slot: SecretSlotName | null;
  /** The variables the harness reads, in the order a value is matched to one. */
  variables: readonly string[];
}

export const HARNESS_CREDENTIALS: Readonly<Record<string, HarnessCredential>> = {
  'claude-code': { provider: 'anthropic', slot: 'anthropic', variables: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] },
  codex: { provider: 'openai', slot: 'codex', variables: ['OPENAI_API_KEY'] },
  opencode: { provider: 'anthropic', slot: 'anthropic', variables: ['ANTHROPIC_API_KEY'] },
  cursor: { provider: 'anthropic', slot: 'anthropic', variables: ['ANTHROPIC_API_KEY'] },
  antigravity: { provider: 'google', slot: null, variables: ['GEMINI_API_KEY'] },
};
