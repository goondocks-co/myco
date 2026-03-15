/**
 * Clean LLM response text before parsing.
 *
 * Reasoning models (DeepSeek, Qwen, GLM, etc.) embed chain-of-thought
 * in the response using special tags. These must be stripped before
 * JSON parsing or value extraction.
 */

// Patterns for reasoning model chain-of-thought tokens.
// Order matters: most specific patterns first.
const REASONING_PATTERNS = [
  // <think>...</think>answer  (DeepSeek, Qwen, GLM, many others)
  /<think>[\s\S]*?<\/think>\s*/gi,
  // Implicit opening: reasoning...</think>answer  (GLM-4.7 observed)
  /^[\s\S]*?<\/think>\s*/i,
  // <reasoning>...</reasoning>answer
  /<reasoning>[\s\S]*?<\/reasoning>\s*/gi,
  // <|thinking|>...<|/thinking|>answer
  /<\|thinking\|>[\s\S]*?<\|\/thinking\|>\s*/gi,
];

/**
 * Strip reasoning/chain-of-thought tokens from LLM response text.
 * Returns the final answer without the thinking process.
 */
export function stripReasoningTokens(text: string): string {
  if (!text) return text;

  for (const pattern of REASONING_PATTERNS) {
    const stripped = text.replace(pattern, '').trim();
    if (stripped && stripped !== text.trim()) {
      return stripped;
    }
  }

  return text;
}

/**
 * Extract JSON from an LLM response that may contain markdown fences,
 * reasoning tokens, or other wrapper text.
 *
 * Tries in order:
 * 1. Strip reasoning tokens
 * 2. Extract from ```json ... ``` code fences
 * 3. Find bare {...} JSON object
 * 4. Parse the cleaned text directly
 */
export function extractJson(text: string): unknown {
  const cleaned = stripReasoningTokens(text);

  // Try code fence extraction
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    return JSON.parse(fenceMatch[1].trim());
  }

  // Try bare JSON object
  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    return JSON.parse(objectMatch[0]);
  }

  // Try direct parse
  return JSON.parse(cleaned);
}

/**
 * Extract a numeric value from an LLM response that may contain
 * reasoning tokens or extra text around the number.
 */
export function extractNumber(text: string): number {
  const cleaned = stripReasoningTokens(text).trim();
  const match = cleaned.match(/(\d+\.?\d*)/);
  if (match) return parseFloat(match[1]);
  return parseFloat(cleaned);
}
