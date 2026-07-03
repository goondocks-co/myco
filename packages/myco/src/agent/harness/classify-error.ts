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

export function isCapHitMessage(message: string): boolean {
  return /max[\s_-]?turns/i.test(message);
}
