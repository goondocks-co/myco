import { createInterface } from 'node:readline/promises';

export type Ask = (question: string) => Promise<string | null>;

/** A missing terminal yields no answer and grants no consent. */
export const askOnTerminal: Ask = async (question) => {
  if (!process.stdin.isTTY) return null;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const abort = new AbortController();
  terminal.once('SIGINT', () => abort.abort(new Error('Setup interrupted; run myco setup again to resume.')));
  try { return await terminal.question(question, { signal: abort.signal }); }
  finally { terminal.close(); }
};

export async function askRequired(ask: Ask, question: string, flag: string): Promise<string> {
  const answer = await ask(`${question} `);
  if (answer === null) throw new Error(`no terminal to ask "${question}"; pass ${flag}`);
  if (answer.trim() === '') throw new Error(`an answer is required; pass ${flag}`);
  return answer.trim();
}

export async function confirm(ask: Ask, question: string, flag: string, defaultYes = false): Promise<boolean> {
  const raw = await ask(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `);
  if (raw === null) throw new Error(`no terminal to ask "${question}"; pass ${flag}`);
  const answer = raw.trim();
  if (answer === '') return defaultYes;
  if (/^(y|yes)$/i.test(answer)) return true;
  if (/^(n|no)$/i.test(answer)) return false;
  throw new Error(`answer yes or no; pass ${flag}`);
}
