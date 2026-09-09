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
 * A provider is one secret slot, and a slot serves everything the Deployment
 * authenticates with it: the `openai` slot a codex run reads is the same one
 * the embedding provider reads, so a Deployment holding a key for embeddings is
 * holding one for every codex run as well.
 */
export type HarnessProvider = 'anthropic' | 'openai' | 'google';

export interface HarnessCredential {
  provider: HarnessProvider;
  /** The variables the harness reads, in the order a value is matched to one. */
  variables: readonly string[];
}

export const HARNESS_CREDENTIALS: Readonly<Record<string, HarnessCredential>> = {
  'claude-code': { provider: 'anthropic', variables: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] },
  codex: { provider: 'openai', variables: ['OPENAI_API_KEY'] },
  opencode: { provider: 'anthropic', variables: ['ANTHROPIC_API_KEY'] },
  cursor: { provider: 'anthropic', variables: ['ANTHROPIC_API_KEY'] },
  antigravity: { provider: 'google', variables: ['GEMINI_API_KEY'] },
};
