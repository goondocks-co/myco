const TERMINAL_TEXT_LIMIT = 200;

/** Bound untrusted terminal text to one line without terminal control characters. */
export function terminalText(text: string): string {
  const safe = text.slice(0, TERMINAL_TEXT_LIMIT).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  return text.length > TERMINAL_TEXT_LIMIT ? `${safe.slice(0, TERMINAL_TEXT_LIMIT - 1)}…` : safe;
}
