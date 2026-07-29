// packages/myco/src/agent/harness/classify-error.ts

// Connection-class failures mean the provider endpoint was never reached (or
// dropped mid-request): the work item was not evaluated. Bun's fetch emits
// "Was there a typo in the url or port?" / "Unable to connect" on a refused
// socket; Node-style errors surface ECONNREFUSED/ETIMEDOUT/ECONNRESET. These
// must NOT consume a per-item retry budget — they are infrastructure, not content.
//
// `openrouter upstream provider failure` / `provider_unavailable` is the
// wording openai.ts's harnessFetch synthesizes when OpenRouter's
// /api/v1/responses returns HTTP 200 with status:"failed" (or
// "incomplete" + no non-reasoning output) — the upstream provider (e.g. an
// Azure OpenAI deployment behind an openai/* route) rejected the request,
// but OpenRouter's own transport succeeded. That is content-adjacent
// plumbing failure, not a caller mistake — it belongs in the same
// retryable bucket as a dropped socket.
const CONNECTION_PATTERNS = [
  /typo in the url or port/i,
  /unable to connect/i,
  /fetch failed/i,
  /econnrefused/i,
  /econnreset/i,
  /etimedout/i,
  /ehostunreach/i,
  /enetunreach/i,
  /socket hang up/i,
  /network/i,
  /\btimeout\b/i,
  /AbortError/,
  /provider_unavailable/i,
  /upstream provider failure/i,
];

export function isConnectionError(message: string): boolean {
  return CONNECTION_PATTERNS.some((p) => p.test(message));
}

// Auth-class failures: the spawned Claude Code CLI could not authenticate.
// Harness runs execute under the isolated agent-sessions CLAUDE_CONFIG_DIR
// (see getAgentSessionConfigDir in claude.ts), which does not share the
// user's interactive login — the CLI scopes login state to its config dir.
// Without CLAUDE_CODE_OAUTH_TOKEN in the environment (or credentials
// provisioned inside that directory) every Anthropic-provider run fails
// before its first turn, and no retry can change that. "Not logged in" /
// "Please run /login" is the CLI's no-credentials wording; the OAuth and
// authentication_error variants cover expired or revoked tokens.
const AUTH_PATTERNS = [
  /not logged in/i,
  /please run \/login/i,
  /invalid api key/i,
  /oauth (?:access )?token (?:is )?(?:invalid|expired|revoked)/i,
  /authentication_error/i,
  /failed to authenticate/i,
];

export function isAuthErrorMessage(message: string): boolean {
  return AUTH_PATTERNS.some((p) => p.test(message));
}

/**
 * Actionable replacement for the CLI's bare auth error. The bare message
 * says "run /login", which cannot fix a harness run — the user's
 * interactive login lives in a different config dir than the one harness
 * runs use. Point at the headless credential instead. Shared with the
 * doctor's agent-runtime auth check so run errors and doctor output name
 * the same remediation.
 */
export function buildHarnessAuthGuidance(originalMessage: string, secretsPath: string): string {
  return `${originalMessage} — background agent runs use an isolated Claude Code session directory that does not share your interactive login. Run \`claude setup-token\` and add CLAUDE_CODE_OAUTH_TOKEN=<token> to ${secretsPath}, then re-run. \`myco doctor\` verifies agent runtime auth.`;
}

export function isCapHitMessage(message: string): boolean {
  return /max[\s_-]?turns/i.test(message);
}
