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
 *   DEFERRAL — "unavailable on this build", "until that lands", "returns with".
 *   A promise about the future, recorded where nothing checks it. Three
 *   commands shipped dead behind exactly this: `host rotate-key`,
 *   `host enable --emit-join`, and the `join_unavailable` refusal each waited
 *   on work that had ALREADY shipped, and nothing failed when it did. The
 *   stubs simply sat there. Deferral belongs in a plan, which gets read.
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
const SRC_ROOTS = [path.join(REPO_ROOT, 'packages', 'myco', 'src')];

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
const DEFERRAL = /(unavailable on this build|until (that|it|enrollment|the .{0,30}) lands\b|will land\b|lands with the (rebuilt|new|designation)|is being (rebuilt|rewritten)|is not rebuilt|not yet an enforced|temporarily unavailable|not yet implemented|not implemented yet|coming soon)/i;

/**
 * Files still carrying narration, to be emptied by the repo-wide sweep.
 * DO NOT ADD. A new entry is new debt.
 */
const NOT_YET_SWEPT: ReadonlySet<string> = new Set<string>([
  'packages/myco/src/agent/prompt-composition.ts',
  'packages/myco/src/agent/registry.ts',
  'packages/myco/src/backup/migrate.ts',
  'packages/myco/src/capture/plan-drain.ts',
  'packages/myco/src/capture/transcript-drain.ts',
  'packages/myco/src/capture/transcript-miner.ts',
  'packages/myco/src/cli/update.ts',
  'packages/myco/src/config/loader.ts',
  'packages/myco/src/config/migrations.ts',
  'packages/myco/src/config/schema.ts',
  'packages/myco/src/config/scope.ts',
  'packages/myco/src/config/updates.ts',
  'packages/myco/src/constants.ts',
  'packages/myco/src/daemon/api/intent.ts',
  'packages/myco/src/daemon/api/provider-secrets.ts',
  'packages/myco/src/daemon/embedding/sqlite-vec-store.ts',
  'packages/myco/src/daemon/grove-pending-probe.ts',
  'packages/myco/src/daemon/intent.ts',
  'packages/myco/src/daemon/main.ts',
  'packages/myco/src/daemon/plan-capture.ts',
  'packages/myco/src/daemon/power-jobs.ts',
  'packages/myco/src/daemon/self-reconcile-wiring.ts',
  'packages/myco/src/daemon/self-reconcile.ts',
  'packages/myco/src/daemon/server.ts',
  'packages/myco/src/daemon/stop-processing.ts',
  'packages/myco/src/daemon/task-scheduling.ts',
  'packages/myco/src/db/migrations.ts',
  'packages/myco/src/db/queries/activities.ts',
  'packages/myco/src/db/queries/batches.ts',
  'packages/myco/src/db/queries/sessions.ts',
  'packages/myco/src/grove/activation.ts',
  'packages/myco/src/grove/global-install-migration.ts',
  'packages/myco/src/grove/project-lease.ts',
  'packages/myco/src/grove/request-context.ts',
  'packages/myco/src/machine-id.ts',
  'packages/myco/src/mcp/stdio-bridge.ts',
  'packages/myco/src/service/launchd.ts',
  'packages/myco/src/service/scoped.ts',
  'packages/myco/src/symbionts/detect.ts',
  'packages/myco/src/symbionts/install-helpers.ts',
  'packages/myco/src/symbionts/installer.ts',
  'packages/myco/src/symbionts/manifest-schema.ts',
  'packages/myco/src/symbionts/settings-merge.ts',
  'packages/myco/src/upgrade/apply-binary.ts',
  'packages/myco/src/upgrade/orchestrator.ts',
  'packages/myco/src/upgrade/spawn.ts',
  'packages/myco/src/vault/bootstrap.ts',
]);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'target', '.git', 'ui']);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { out.push(...listSourceFiles(full)); continue; }
    if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
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
