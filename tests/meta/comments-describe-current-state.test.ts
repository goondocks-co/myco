/*
 * Copyright 2026 Myco Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * Comments describe the CURRENT state of the code.
 *
 * Myco is where this project keeps its memory. A comment that narrates what
 * something used to be, or promises what will land later, duplicates that
 * memory somewhere nothing maintains — and unlike the vault, source comments
 * are never revisited when the thing they describe changes.
 *
 * TWO CLASSES, and the second is the one that has actually cost us:
 *
 *   HISTORY — "used to", "no longer", "was removed". Rots quietly. Costs
 *   reading time and misleads whoever trusts it.
 *
 *   DEFERRAL — "unavailable on this build", "until that lands". A promise about
 *   the future, recorded where nothing checks it. Three commands shipped dead
 *   behind exactly this: `host rotate-key`, `host enable --emit-join`, and the
 *   `join_unavailable` refusal each waited on work that had ALREADY shipped,
 *   and nothing failed when it did. Deferral belongs in a plan, which gets read.
 *
 *   WHAT THIS IS NOT: a gate on the CONCEPT. It matches known phrasings, and
 *   an author who writes "left dead for now, wire it up later" sails past. It
 *   is a cheap tripwire for the wordings that have already cost us, not a
 *   guarantee. The only thing that actually catches a dead command is a test
 *   that RUNS it — `tests/cli/host-rotate-key.test.ts` is that test, written
 *   after `rotate-key` shipped dead a SECOND time, in the very PR that added
 *   this gate, past both of its static siblings.
 *
 * A term that NAMES something currently true is fine — a `legacySecrets` field
 * really is legacy today, and a compatibility path that still carries
 * old-format data should say so. Only COMMENTS are scanned, never identifiers
 * or user-facing strings, so naming stays free.
 *
 * ALLOWLIST: files not yet swept. It only shrinks — a new entry means someone
 * added narration, and that shows up in review as a line in this list rather
 * than as a silent comment.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The dashboard's own source is scanned too: a stale mechanism comment in
// `ui/src` (e.g. "Inviting is DISABLED in this build") rotted unseen because
// this gate stopped at the daemon's `src`. The UI is user-facing surface — it
// gets the same discipline.
const SRC_ROOTS = [
  path.join(REPO_ROOT, 'packages', 'myco', 'src'),
  path.join(REPO_ROOT, 'packages', 'myco', 'ui', 'src'),
];

/**
 * Narrates a CHANGE TO THE CODE.
 *
 * Deliberately excludes "no longer", which is usually a RUNTIME condition —
 * "a Grove that no longer exists", "the partial no longer matches the offset" —
 * and is accurate present-tense description. A gate that flagged those would
 * push authors to reword true statements, and a noisy gate gets switched off.
 */
const HISTORY = new RegExp([
  // "it used to be", "this module used to run" — the narrating sense.
  /\b(it|this|that|they|we|which|module|host|member|daemon|code|flow)\s+used to\b/,
  // "used to be/also/carry/…" — narrating regardless of subject. Excludes the
  // INSTRUMENTAL sense ("a check used to tell X from Y" = employed to), which
  // is present-tense description and must stay unflagged.
  /\bused to (be|also|have|carry|require|live|run|do|mean|exist|sit|take|need|derive|reserve|record|accept|stop|provision)\b/,
  /\b(was removed|were removed|has been removed|the old |overlay-era|pre-Funnel)\b/,
].map((r) => r.source).join('|'), 'i');

/** Promises future state from a place nothing checks. */
const DEFERRAL = /(unavailable on this build|until (that|it|enrollment|the .{0,30}) (lands|ships)\b|will land\b|lands with the (rebuilt|new|designation)|is being (rebuilt|rewritten)|is not rebuilt|not yet an enforced|temporarily unavailable|not yet implemented|not implemented yet|coming soon|stubbed for|placeholder until|arrives in a (later|future) release|pending the new)/i;

/**
 * Files still carrying narration, to be emptied by the repo-wide sweep.
 * DO NOT ADD. A new entry is new debt.
 */
const NOT_YET_SWEPT: ReadonlySet<string> = new Set<string>([]);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', '.git']);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...listSourceFiles(full)); continue; }
    // `.ts` and `.tsx`, never their `.test.*` siblings — the UI root carries both.
    const isSource = (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
      || (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx'));
    if (entry.isFile() && isSource) out.push(full);
  }
  return out;
}

/**
 * Comment text only, with line numbers. String literals are matched first and
 * discarded so a user-facing message containing "no longer" is never flagged —
 * copy is not a comment, and this gate must not push anyone into rewording an
 * error message to get green.
 */
function commentLines(source: string): Array<{ line: number; text: string }> {
  const re = /(['"`])(?:\\.|(?!\1)[^\\])*\1|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
  const out: Array<{ line: number; text: string }> = [];
  for (const m of source.matchAll(re)) {
    if (m[0][0] !== '/') continue;
    const line = source.slice(0, m.index).split('\n').length;
    m[0].split('\n').forEach((text, i) => out.push({ line: line + i, text }));
  }
  return out;
}

function scan(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const root of SRC_ROOTS) {
    for (const abs of listSourceFiles(root)) {
      const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
      if (NOT_YET_SWEPT.has(rel)) continue;
      for (const { line, text } of commentLines(fs.readFileSync(abs, 'utf8'))) {
        if (pattern.test(text)) hits.push(`${rel}:${line}  ${text.trim().slice(0, 110)}`);
      }
    }
  }
  return hits;
}

describe('comments describe the current state', () => {
  it('no comment PROMISES future state — deferral belongs in a plan', () => {
    const hits = scan(DEFERRAL);
    expect(
      hits,
      'A comment here promises work that will land later. Nothing checks that promise, so when the '
      + 'work lands the stub stays — three commands shipped dead exactly this way. Record the '
      + 'deferral in a Myco plan and make the code state what it does TODAY (including refusing, '
      + 'if it refuses).\n\n' + hits.join('\n'),
    ).toEqual([]);
  });

  it('the allowlist only SHRINKS — every entry must still be dirty', () => {
    // The docstring claims this list ratchets; nothing enforced that. A file
    // cleaned by the sweep would keep its exemption forever, and the list would
    // drift from "work remaining" to decoration. Requiring every entry to still
    // produce a hit means sweeping a file forces its line out of the list in the
    // SAME diff — which is the property the ratchet was supposed to have.
    const stale = [...NOT_YET_SWEPT].filter((rel) => {
      const abs = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(abs)) return true;
      // Accepts EITHER pattern, because `scan()` skips an allowlisted file for
      // BOTH gates: an entry kept alive only by HISTORY dirt would silently
      // excuse a DEFERRAL hit the file later acquires. What keeps an exemption
      // alive has to match what the exemption covers.
      return !commentLines(fs.readFileSync(abs, 'utf8'))
        .some(({ text }) => HISTORY.test(text) || DEFERRAL.test(text));
    });
    expect(
      stale,
      'These files are allowlisted but are already clean (or gone). Delete their lines from '
      + 'NOT_YET_SWEPT — an exemption that protects nothing hides the next file that needs one.\n\n'
      + stale.join('\n'),
    ).toEqual([]);
  });

  it('no comment narrates what the code USED to do', () => {
    const hits = scan(HISTORY);
    expect(
      hits,
      'A comment here describes a past state. Myco holds the history; source comments are never '
      + 'revisited when the thing they describe changes, so this rots in place. State what the code '
      + 'does now.\n\n' + hits.join('\n'),
    ).toEqual([]);
  });
});
