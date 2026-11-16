/** Antigravity transcript steps; the hook contract names transcriptPath: https://antigravity.google/docs/hooks */
export const isAntigravityUserInput = (entry: Record<string, unknown>): boolean =>
  entry.type === 'USER_INPUT' && entry.source !== 'SYSTEM_SDK';

/** The human request, with harness metadata envelopes removed. */
export function cleanAntigravityUserPrompt(raw: string): string {
  const requestMatch = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  const body = requestMatch ? requestMatch[1] : raw;
  return body
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, '')
    .trim();
}

