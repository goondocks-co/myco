/**
 * What a turn no person typed was, in plain words, ahead of its substance. The words are composed at read time from the
 * turn's stored lead facts (written when it settles, `content/lead-facts.ts`), its origin and the session's launch
 * lineage, so the turn list and the tools say the same thing. Nothing here reads a document.
 */
import { cleanSessionText } from '@goondocks/myco-shared/prompt-text';
import { NOTICE_DESCRIPTION_CHARS, promptEnvelope, type PromptNotice } from '@goondocks/myco-shared/capture-rules';

const SPEAKERS: Readonly<Record<string, string>> = { user: 'Person', agent_dispatch: 'Another agent', system: 'Harness', hook_injected: 'Myco' };
/** Who spoke a prompt, by its origin, in the words titling and the turn list share. */
export const speaker = (origin: string): string => SPEAKERS[origin] ?? 'Unknown origin';

/** Characters a lead keeps of the line it carries. */
const LEAD_LINE_CHARS = 160;

export interface LeadFacts { read?: string; notice?: PromptNotice }

export function isPromptNotice(value: unknown): value is PromptNotice {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const { kind, description, exitCode } = value as Record<string, unknown>;
  return kind === 'background_command' && typeof description === 'string' && description.trim() !== ''
    && description.length <= NOTICE_DESCRIPTION_CHARS && (exitCode === null || Number.isSafeInteger(exitCode));
}

export const clipLine = (line: string): string => line.length <= LEAD_LINE_CHARS ? line : `${line.slice(0, LEAD_LINE_CHARS - 1).trimEnd()}…`;
function storedFacts(stored: string | null): LeadFacts {
  if (stored === null) return {};
  try {
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    return { ...(typeof parsed.read === 'string' ? { read: parsed.read } : {}), ...(isPromptNotice(parsed.notice) ? { notice: parsed.notice } : {}) };
  } catch { return {}; }
}

/** What a session tells every turn's lead: its agent, whether another agent launched it, and its opening turn. */
interface LeadSession { agent: string | null; launched: boolean; openingTurn: string | null }
interface LeadTurn { promptId: string; origin: string; preview: string | null; leadFacts: string | null }

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
  // Nested elements are structure, not words: such a turn is named by its outer element.
  const element = line !== null && /<\/?[A-Za-z]/.test(line) ? /^\s*<([A-Za-z][\w.-]*)/.exec(turn.preview ?? '')?.[1] : undefined;
  if (element !== undefined) return `${speaker(turn.origin)}: ${element.replace(/[-_.]+/g, ' ')}`;
  return line ? `${speaker(turn.origin)}: ${clipLine(line)}` : speaker(turn.origin);
}
