import { CAPTURE_RULE_BUNDLES } from './capture-rules.generated.js';

/**
 * A block the agent adds around or instead of what a person typed. Cursor
 * names every one in snake_case (`<git_status>`, `<image_files>`,
 * `<available_subagent_types>`), besides `<timestamp>`; a tag a person types,
 * such as `<b>`, is neither.
 */
const AGENT_BLOCK = String.raw`<((?:[a-z]+_)+[a-z]+|timestamp)>[\s\S]*?</\1>`;
const ONLY_AGENT_BLOCKS = new RegExp(`^(?:\\s*${AGENT_BLOCK})+\\s*$`);

/**
 * What the person typed: every `<user_query>` block the line carries, in
 * order; else, for a line with none, its text as typed — or nothing, when the
 * line is only blocks the agent injected.
 */
export function cursorPromptText(text: string): string {
  const queries = [...text.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/g)].map((m) => (m[1] ?? '').trim()).filter((q) => q !== '');
  if (queries.length > 0) return queries.join('\n\n');
  return ONLY_AGENT_BLOCKS.test(text) ? '' : text.trim();
}


/** Display text keeps the contents of manifest-named envelopes and removes only their markup. */
export function displayPrompt(text: string, agent: string | null): string {
  const bundle = CAPTURE_RULE_BUNDLES.find((item) => item.name === agent);
  if (bundle === undefined) return text;
  if (bundle.rules.some((rule) => rule.event === 'user_prompt' && rule.strip_envelope?.open === '<user_query>')) return cursorPromptText(text);
  const tags = new Set<string>();
  let displayed = text;
  for (const rule of bundle.rules) {
    if (rule.event !== 'user_prompt') continue;
    for (const tag of rule.when.prompt_envelope_tag_in ?? []) tags.add(tag);
    const prefix = rule.when.prompt_starts_with?.match(/^<([\w-]+)>$/)?.[1];
    if (prefix !== undefined) tags.add(prefix);
    if (rule.strip_envelope !== undefined) {
      const tag = rule.strip_envelope.open.match(/^<([\w-]+)>$/)?.[1];
      if (tag !== undefined) tags.add(tag);
    }
    if (rule.extract_after !== undefined && displayed.includes(rule.extract_after)) displayed = displayed.slice(displayed.indexOf(rule.extract_after) + rule.extract_after.length);
  }
  if (!tags.has(displayed.trimStart().match(/^<([A-Za-z][\w-]*)[\s>]/)?.[1] ?? '')) return displayed;
  return displayed.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, index) => index % 2 === 1 ? part : part.replace(/<\/?([A-Za-z][\w-]*)(?:\s[^<>]*?)?\s*\/?>/g, (markup, tag: string) => tags.has(tag) ? '' : markup)).join('').trim();
}
