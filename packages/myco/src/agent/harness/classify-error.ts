// packages/myco/src/agent/harness/classify-error.ts

// Connection-class failures mean the provider endpoint was never reached (or
// dropped mid-request): the work item was not evaluated. Bun's fetch emits
// "Was there a typo in the url or port?" / "Unable to connect" on a refused
// socket; Node-style errors surface ECONNREFUSED/ETIMEDOUT/ECONNRESET. These
// must NOT consume a per-item retry budget — they are infrastructure, not content.
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
];

export function isConnectionError(message: string): boolean {
  return CONNECTION_PATTERNS.some((p) => p.test(message));
}

export function isCapHitMessage(message: string): boolean {
  return /max[\s_-]?turns/i.test(message);
}
