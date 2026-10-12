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



export interface PromptEnvelope { label: string; text: string; inlineText?: string }
export interface DisplayPrompt { text: string; envelopes: PromptEnvelope[] }

const ENVELOPE_LABELS: Record<string, string> = {
  'command-message': 'Command', 'command-args': 'Command arguments', 'command-contents': 'Command',
  'local-command-stdout': 'Command output', 'local-command-caveat': 'Command notice',
  'system-reminder': 'System reminder', 'task-notification': 'Task notification',
  skill: 'Skill', environment_context: 'Environment', subagent_notification: 'Sub-agent notification',
  timestamp: 'Timestamp', attached_files: 'Attached files', user_info: 'User context',
  additional_data: 'Additional context', pasted_content: 'Pasted content',
};

/** Leading envelopes are presentation metadata; capture rewrites never run on stored text. */
export function promptDisplay(text: string, agent: string | null): DisplayPrompt {
  return interpretPrompt(text, agent, true);
}

function interpretPrompt(text: string, agent: string | null, preserveUnclosed: boolean): DisplayPrompt {
  const bundle = CAPTURE_RULE_BUNDLES.find((item) => item.name === agent);
  const tags = new Set<string>(bundle?.displayEnvelopeTags);
  for (const rule of bundle?.rules ?? []) {
    if (rule.event !== 'user_prompt') continue;
    for (const tag of rule.when.prompt_envelope_tag_in ?? []) tags.add(tag);
    for (const open of [rule.when.prompt_starts_with, rule.strip_envelope?.open]) {
      const tag = open?.match(/^<([\w-]+)>$/)?.[1];
      if (tag !== undefined) tags.add(tag);
    }
  }
  const envelopes: PromptEnvelope[] = [];
  let rest = text;
  const person: string[] = [];
  while (true) {
    const opening = /^\s*<([\w-]+)(?:\s[^<>]*?)?>/.exec(rest);
    if (opening === null || !tags.has(opening[1]!)) break;
    const tag = opening[1]!;
    const inner = rest.slice(opening[0].length);
    const close = new RegExp('</' + tag + '\\s*>').exec(inner);
    if (close === null) { if (!preserveUnclosed) rest = inner; break; }
    const content = inner.slice(0, close.index);
    rest = inner.slice(close.index + close[0].length);
    if (tag === 'user_query' || tag === 'command-args') person.push(content);
    else if (content.trim() !== '') envelopes.push(tag === 'command-name'
      ? { label: 'Ran ' + content.trim(), text: '', inlineText: content.trim() }
      : { label: ENVELOPE_LABELS[tag] ?? tag.replace(/[-_]/g, ' '), text: content.trim() });
  }
  return { text: [...person, rest].filter(Boolean).join('\n\n'), envelopes };
}

/** Plain labels use the same envelope interpretation as the conversation. */
export function displayPrompt(text: string, agent: string | null): string {
  const shown = interpretPrompt(text, agent, false);
  const label = [...shown.envelopes.map((item) => item.inlineText), shown.text].filter(Boolean).join(' ').trim();
  return label || shown.envelopes[0]?.label || '';
}

export function cleanSessionText(text: string | null | undefined, agent: string | null): string | null {
  const line = text == null ? '' : displayPrompt(text, agent).replace(/\s+/g, ' ').trim();
  return line === '' ? null : line;
}
