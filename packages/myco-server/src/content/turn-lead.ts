/**
 * What a turn no person typed was, in plain words, ahead of its substance. The facts are recorded once, when the turn
 * settles: the opening line of the file its prompt points at, read by the turn itself, and the notice its harness's
 * capture recorded. The words are composed at read time from those facts, the turn's origin and the session's launch
 * lineage, so the turn list and the tools say the same thing.
 */
import { cleanSessionText } from '@goondocks/myco-shared/prompt-text';
import { NOTICE_DESCRIPTION_CHARS, promptEnvelope, type PromptNotice } from '@goondocks/myco-shared/capture-rules';
import type { DocRecord } from './document.js';
import { openingRead } from './prompt-file-read.js';

const SPEAKERS: Readonly<Record<string, string>> = { user: 'Person', agent_dispatch: 'Another agent', system: 'Harness', hook_injected: 'Myco' };
/** Who spoke a prompt, by its origin, in the words titling and the turn list share. */
export const speaker = (origin: string): string => SPEAKERS[origin] ?? 'Unknown origin';

/** Characters a lead keeps of the line it carries. */
export const LEAD_LINE_CHARS = 160;

interface LeadFacts { read?: string; notice?: PromptNotice }

export function isPromptNotice(value: unknown): value is PromptNotice {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const { kind, description, exitCode } = value as Record<string, unknown>;
  return kind === 'background_command' && typeof description === 'string' && description.trim() !== ''
    && description.length <= NOTICE_DESCRIPTION_CHARS && (exitCode === null || Number.isSafeInteger(exitCode));
}

const clipLine = (line: string): string => line.length <= LEAD_LINE_CHARS ? line : `${line.slice(0, LEAD_LINE_CHARS - 1).trimEnd()}…`;
const NUMBERED = /^\s*\d+(?:\t|→)/;
const FENCE = /^(?:`{3,}|~{3,})/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;

/**
 * The first heading or prose line of a file's opening text: front matter, fences and the code they hold, rules and
 * comment lines are passed over, and a numbered listing's line numbers are removed when every line carries one.
 */
export function openingLine(text: string): string | null {
  let lines = text.split(/\r?\n/);
  if (lines.filter(line => line.trim() !== '').every(line => NUMBERED.test(line))) lines = lines.map(line => line.replace(NUMBERED, ''));
  let skipping: 'front' | 'fence' | null = null;
  let first = true;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    const opening = first;
    first = false;
    if (skipping === 'front') { if (line === '---') skipping = null; continue; }
    if (skipping === 'fence') { if (FENCE.test(line)) skipping = null; continue; }
    if (opening && line === '---') { skipping = 'front'; continue; }
    if (FENCE.test(line)) { skipping = 'fence'; continue; }
    if (RULE.test(line) || /^<!--.*-->$/.test(line)) continue;
    const heading = /^#{1,6}\s+(.*?)\s*#*$/.exec(line)?.[1];
    const shown = (heading ?? line).replace(/\s+/g, ' ').trim();
    if (shown !== '') return clipLine(shown);
  }
  return null;
}

/** A settled turn's lead facts as stored, or null when it has none: what its prompt's file read opens with, and its notice. */
export function leadFacts(prompt: DocRecord, records: readonly DocRecord[]): string | null {
  const read = typeof prompt.text === 'string' ? openingRead(records, prompt.text) : null;
  const line = read === null ? null : openingLine(read);
  const notice = isPromptNotice(prompt.notice) ? prompt.notice : null;
  if (line === null && notice === null) return null;
  const facts: LeadFacts = { ...(line === null ? {} : { read: line }), ...(notice === null ? {} : { notice }) };
  return JSON.stringify(facts);
}

function storedFacts(stored: string | null): LeadFacts {
  if (stored === null) return {};
  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    return { ...(typeof parsed.read === 'string' ? { read: parsed.read } : {}), ...(isPromptNotice(parsed.notice) ? { notice: parsed.notice } : {}) };
  } catch { return {}; }
}

/** What a session tells every turn's lead: its agent, whether another agent launched it, and its opening turn. */
export interface LeadSession { agent: string | null; launched: boolean; openingTurn: string | null }
export interface LeadTurn { promptId: string; origin: string; preview: string | null; leadFacts: string | null }

/** A turn's lead, or null for a person's turn, whose own words lead it. */
export function turnLead(turn: LeadTurn, session: LeadSession): string | null {
  if (turn.origin === 'user') return null;
  const { read, notice } = storedFacts(turn.leadFacts);
  if (notice !== undefined) return `Background command finished: ${notice.description}${notice.exitCode === null ? '' : ` (exit ${notice.exitCode})`}`;
  if (read !== undefined) {
    if (session.launched && turn.promptId === session.openingTurn) return `Task from the launching agent: ${read}`;
    return `${session.launched ? 'From the launching agent' : 'Message'}: ${read}`;
  }
  // An outer element is presentation: its inner text when the preview holds it whole, else the text after its opening tag.
  const cleaned = cleanSessionText(turn.preview, session.agent);
  const line = cleaned === null ? null : promptEnvelope(cleaned)?.text ?? cleaned.replace(/^<[A-Za-z][\w.-]*(?:\s[^<>]*)?>\s*/, '');
  return line ? `${speaker(turn.origin)}: ${clipLine(line)}` : speaker(turn.origin);
}
