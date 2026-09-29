/**
 * The committed recall baseline, as a TypeScript module under the server's
 * `src` (which holds only TypeScript sources): two headline constants the
 * Measures page imports, and the per-target record the parity eval holds each
 * release to. The record sits between fixed markers so the eval reads and
 * rewrites it as JSON without importing a module it is about to replace.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { RecallBaseline } from './score.ts';

export const RECALL_BASELINE_FILE = path.resolve(import.meta.dir, '..', '..', '..', 'packages', 'myco-server', 'src', 'evals', 'recall-baseline.ts');

const OPEN = 'export const recallBaseline = ';
const CLOSE = ';\n// end of recorded baseline\n';

export function readRecallBaseline(file = RECALL_BASELINE_FILE): RecallBaseline | null {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const start = text.indexOf(OPEN);
  const end = text.indexOf(CLOSE);
  if (start < 0 || end < start) throw new Error(`${file} does not hold a recorded recall baseline between its markers`);
  return JSON.parse(text.slice(start + OPEN.length, end)) as RecallBaseline;
}

export function renderRecallBaseline(baseline: RecallBaseline): string {
  return [
    '/**',
    ' * The recall gold set baseline (#1154): what each front door served for every case, and the Recall quality it scores.',
    ' *',
    ' * Recorded, never edited: `MYCO_EVAL_RECORD=1 npm run test:parity` writes it, the parity eval holds every release to it,',
    ' * and `tests/myco-server/recall-gold.test.ts` recomputes both headline figures from the record.',
    ' */',
    `export const recallQuality = ${baseline.recallQuality};`,
    `export const caseCount = ${baseline.caseCount};`,
    '',
    `${OPEN}${JSON.stringify(baseline, null, 1)}${CLOSE}`,
  ].join('\n');
}

export function writeRecallBaseline(baseline: RecallBaseline, file = RECALL_BASELINE_FILE): void {
  writeFileSync(file, renderRecallBaseline(baseline));
}
