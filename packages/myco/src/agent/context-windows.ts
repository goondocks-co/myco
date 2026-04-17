/** Default context window Myco applies for local agent runs when no override is set. */
export const DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS = 32_768;

/** Inferred frontier-model context window when the provider does not expose one. */
export const DEFAULT_FRONTIER_CONTEXT_WINDOW_TOKENS = 200_000;

/** Inferred OpenAI-compatible cloud context window when the provider does not expose one. */
export const DEFAULT_COMPATIBLE_CONTEXT_WINDOW_TOKENS = 128_000;
