export function joinSentences(...parts: string[]): string {
  const text = parts.map(part => part.trim().replace(/[.,;:]+$/, '')).filter(Boolean).join('. ');
  return text === '' ? '' : `${text}.`;
}
