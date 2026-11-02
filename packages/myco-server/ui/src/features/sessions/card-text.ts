import { readCard } from '@goondocks/myco-shared/turn-card';

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
  files: string[];
  commands: string[];
  openQuestions: string[];
}

/** The canonical fields of a versioned card, or null for verbatim text. */
export function parseCard(card: string): CardText | null {
  const fields = readCard(card);
  if (fields === null) return null;
  return {
    done: fields.done, outcome: fields.outcome,
    decisions: fields.decisions.map(item => ({ text: item.decision, detail: item.reason })),
    rejected: fields.rejected.map(item => ({ text: item.approach, detail: item.reason })),
    errors: fields.errors.map(item => ({ text: item.error, detail: item.fix })),
    corrections: fields.corrections.map(item => ({ text: item.wrong, detail: item.right })),
    files: fields.files, commands: fields.commands, openQuestions: fields.open_questions,
  };
}

const MECHANICAL = /^mechanical turn\b/;

/** Whether this is what triage writes on a turn it does not send to a model, so no summary is coming. */
export function isMechanical(text: string | null | undefined): boolean {
  return text != null && MECHANICAL.test(text);
}
