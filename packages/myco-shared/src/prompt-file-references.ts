export const PROMPT_PROSE_EXTENSION = /\.(?:md|markdown|mdx|txt|rst|adoc)$/i;

/** Local prose file tokens in prose, quotes, Markdown links, or @mentions, in appearance order. */
export function promptFileReferences(text: string): string[] {
  const tokens = text.matchAll(/(?:^|[\s([<{=])(?:@?`([^`\n]+)`|@?"([^"\n]+)"|@?'([^'\n]+)'|([^\s`"'<>()[\]{},;!?]+))/g);
  const paths: string[] = [];
  for (const token of tokens) {
    const quoted = token[1] !== undefined || token[2] !== undefined || token[3] !== undefined;
    const raw = token[1] ?? token[2] ?? token[3] ?? token[4]!;
    const named = raw.replace(/^@/, '').replace(/[.:]+$/, '');
    const pathLike = /^(?:[A-Za-z]:[\\/]|[~./\\])/.test(named) || /[\\/]/.test(named);
    if (!named || /(?:^[a-z][a-z0-9+.-]*:\/\/|[?*|$]|^--)/i.test(named) || (named.includes('@') && !pathLike && !quoted && !raw.startsWith('@'))) continue;
    if (PROMPT_PROSE_EXTENSION.test(named)) paths.push(named);
  }
  return paths;
}

/** A captured read names a referenced full path or a whole path-segment suffix. */
export function promptReferencesFile(prompt: string, file: string): boolean {
  const normalized = file.replace(/\\/g, '/');
  return promptFileReferences(prompt).some(named => {
    const relative = named.replace(/\\/g, '/').replace(/^(?:\.|~)\//, '');
    return normalized === relative || (!/^(?:[A-Za-z]:|[~/])/.test(relative) && normalized.endsWith('/' + relative));
  });
}
