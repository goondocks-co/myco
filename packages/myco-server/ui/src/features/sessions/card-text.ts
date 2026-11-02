/**
 * A turn's card as a reader wants it: the rendered text the server stores, in the
 * sections `renderCard` writes (`core/turn-cards.ts`), taken apart again.
 * `tests/myco-server-ui/sessions.test.tsx` holds this parser to that renderer.
 */

/** One item of a section that pairs what happened with why, or with its fix. */
export interface CardPair {
  text: string;
  detail: string;
}

export interface CardText {
  done: string;
  outcome: string;
  decisions: CardPair[];
  rejected: CardPair[];
  errors: CardPair[];
  corrections: CardPair[];
  openQuestions: string[];
}

const TEXT_SECTIONS = { 'Asked: ': 'asked', 'Done: ': 'done', 'Outcome: ': 'outcome', 'Files: ': 'files' } as const;
const LIST_SECTIONS = { 'Decisions:': ['decisions', 'reason'], 'Rejected:': ['rejected', 'reason'], 'Errors:': ['errors', 'fix'], 'Corrections:': ['corrections', 'right'], 'Commands:': ['commands', ''], 'Open questions:': ['openQuestions', ''] } as const;
const SECTION_ORDER = ['Asked: ', 'Done: ', 'Outcome: ', 'Decisions:', 'Rejected:', 'Errors:', 'Corrections:', 'Files: ', 'Commands:', 'Open questions:'] as const;
type Section = (typeof SECTION_ORDER)[number];

const isText = (section: Section): section is keyof typeof TEXT_SECTIONS => section in TEXT_SECTIONS;

/** A card's sections, in the order they are written; a line that opens no later section continues the one before it. */
function sections(card: string): Map<Section, string[]> {
  const found = new Map<Section, string[]>();
  let at = -1;
  for (const line of card.split('\n')) {
    const next = SECTION_ORDER.findIndex((section, index) => index > at && (isText(section) ? line.startsWith(section) : line === section));
    if (next >= 0) {
      at = next;
      const section = SECTION_ORDER[next]!;
      found.set(section, isText(section) ? [line.slice(section.length)] : []);
    } else if (at >= 0) {
      found.get(SECTION_ORDER[at]!)!.push(line);
    }
  }
  return found;
}

/** A section's items: each starts at `- `, and a line without one continues the item before it. */
function items(lines: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith('- ') || out.length === 0) out.push(line.replace(/^- /, ''));
    else out[out.length - 1] += `\n${line}`;
  }
  return out;
}

function pairs(lines: readonly string[], label: string): CardPair[] {
  const mark = ` — ${label}: `;
  return items(lines).map((item) => {
    const split = item.indexOf(mark);
    return split < 0 ? { text: item, detail: '' } : { text: item.slice(0, split), detail: item.slice(split + mark.length) };
  });
}

/** The card's parts, or null for text that is not a rendered card. */
export function parseCard(card: string): CardText | null {
  const found = sections(card);
  if (!found.has('Done: ')) return null;
  const list = (section: keyof typeof LIST_SECTIONS) => found.get(section) ?? [];
  return {
    done: (found.get('Done: ') ?? []).join('\n').trim(),
    outcome: (found.get('Outcome: ') ?? []).join('\n').trim(),
    decisions: pairs(list('Decisions:'), LIST_SECTIONS['Decisions:'][1]),
    rejected: pairs(list('Rejected:'), LIST_SECTIONS['Rejected:'][1]),
    errors: pairs(list('Errors:'), LIST_SECTIONS['Errors:'][1]),
    corrections: pairs(list('Corrections:'), LIST_SECTIONS['Corrections:'][1]),
    openQuestions: items(list('Open questions:')),
  };
}

const MECHANICAL = /^mechanical turn\b/;

/** Whether this is what triage writes on a turn it does not send to a model, so no summary is coming. */
export function isMechanical(text: string | null | undefined): boolean {
  return text != null && MECHANICAL.test(text);
}
