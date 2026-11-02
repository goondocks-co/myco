/** The structured fields admitted by the card writer and read by the dashboard. */
export interface CardFields {
  asked: string; done: string; outcome: string;
  decisions: { decision: string; reason: string }[];
  rejected: { approach: string; reason: string }[];
  errors: { error: string; fix: string }[];
  corrections: { wrong: string; right: string }[];
  files: string[]; commands: string[]; open_questions: string[];
}

const PAIR_FIELDS = [['decisions', 'decision', 'reason'], ['rejected', 'approach', 'reason'], ['errors', 'error', 'fix'], ['corrections', 'wrong', 'right']] as const;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every admitted field has the same shape at write and read time. */
export function isCardFields(value: unknown): value is CardFields {
  return record(value)
    && ['asked', 'done', 'outcome'].every(field => typeof value[field] === 'string')
    && ['files', 'commands', 'open_questions'].every(field => {
      const items = value[field];
      return Array.isArray(items) && items.every(item => typeof item === 'string');
    })
    && PAIR_FIELDS.every(([field, text, detail]) => {
      const items = value[field];
      return Array.isArray(items) && items.every(item => record(item) && typeof item[text] === 'string' && typeof item[detail] === 'string');
    });
}

const CARD_FORMAT = 'Myco card v1\n';

/** A versioned JSON representation preserves field boundaries and every string value. */
export function encodeCard(card: CardFields): string {
  return CARD_FORMAT + JSON.stringify(card);
}

/** Unversioned or malformed text has no structured interpretation. */
export function readCard(text: string): CardFields | null {
  if (!text.startsWith(CARD_FORMAT)) return null;
  let value: unknown;
  try { value = JSON.parse(text.slice(CARD_FORMAT.length)); } catch { return null; }
  return isCardFields(value) ? value : null;
}

/** Readable authored content for search and model context. */
export function renderCard(card: CardFields): string {
  const pairs = (items: readonly Record<string, string>[], text: string, detail: string) =>
    items.map(item => `- ${item[text]}${item[detail] === '' ? '' : ` — ${detail}: ${item[detail]}`}`).join('\n');
  return [
    `Asked: ${card.asked}`, `Done: ${card.done}`, `Outcome: ${card.outcome}`,
    card.decisions.length === 0 ? '' : `Decisions:\n${pairs(card.decisions, 'decision', 'reason')}`,
    card.rejected.length === 0 ? '' : `Rejected:\n${pairs(card.rejected, 'approach', 'reason')}`,
    card.errors.length === 0 ? '' : `Errors:\n${pairs(card.errors, 'error', 'fix')}`,
    card.corrections.length === 0 ? '' : `Corrections:\n${pairs(card.corrections, 'wrong', 'right')}`,
    card.files.length === 0 ? '' : `Files: ${card.files.join(', ')}`,
    card.commands.length === 0 ? '' : `Commands:\n${card.commands.map(command => `- ${command}`).join('\n')}`,
    card.open_questions.length === 0 ? '' : `Open questions:\n${card.open_questions.map(question => `- ${question}`).join('\n')}`,
  ].filter(line => line !== '').join('\n');
}

/** A dedicated stored fields payload must decode to an admitted card. */
export function storedCardFields(encoded: string | null): CardFields | null {
  if (encoded === null) return null;
  const fields = readCard(encoded);
  if (fields === null) throw new Error('Stored turn card fields are invalid');
  return fields;
}
