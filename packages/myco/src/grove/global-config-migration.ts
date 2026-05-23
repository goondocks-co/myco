/**
 * Global-config one-shot migrations — companion to `runProjectLocalMigration`
 * in `migration-walker.ts` for filesystem state outside any single project.
 *
 * Currently:
 *   - {@link scrubGeminiTrustedHooks} — removes stale `myco-*:--symbiont gemini`
 *     entries from `~/.gemini/trusted_hooks.json`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export interface GlobalConfigMigrationOutcome {
  filePath: string;
  entriesRemoved: number;
  rewritten: boolean;
  error?: string;
}

export interface GlobalConfigMigrationResult {
  outcomes: GlobalConfigMigrationOutcome[];
  noOp: boolean;
}

/** Matches `myco-*:<cmd>` entries that reference the per-project Gemini launcher. */
const GEMINI_ERA_MYCO_HOOK = /^myco-[\w-]+:.*\.agents\/myco-run\.cjs hook [\w-]+ --symbiont gemini\b/;

/**
 * Strip Gemini-era Myco entries from `~/.gemini/trusted_hooks.json`. Idempotent,
 * best-effort, atomic. Returns an outcome describing what changed.
 */
export function scrubGeminiTrustedHooks(
  filePath: string = path.join(os.homedir(), '.gemini', 'trusted_hooks.json'),
): GlobalConfigMigrationOutcome {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return { filePath, entriesRemoved: 0, rewritten: false };
    }
    return { filePath, entriesRemoved: 0, rewritten: false, error: `read failed: ${String(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { filePath, entriesRemoved: 0, rewritten: false, error: 'invalid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { filePath, entriesRemoved: 0, rewritten: false, error: 'unexpected shape' };
  }

  const input = parsed as Record<string, unknown>;
  const cleaned: Record<string, string[]> = {};
  let entriesRemoved = 0;
  for (const [project, entries] of Object.entries(input)) {
    if (!Array.isArray(entries)) {
      (cleaned as Record<string, unknown>)[project] = entries;
      continue;
    }
    const keep: string[] = [];
    for (const entry of entries as unknown[]) {
      if (typeof entry !== 'string') {
        keep.push(entry as string);
        continue;
      }
      if (GEMINI_ERA_MYCO_HOOK.test(entry)) {
        entriesRemoved += 1;
        continue;
      }
      keep.push(entry);
    }
    if (keep.length > 0) cleaned[project] = keep;
  }

  if (entriesRemoved === 0) {
    return { filePath, entriesRemoved: 0, rewritten: false };
  }

  try {
    atomicWriteFileSync(filePath, JSON.stringify(cleaned, null, 2) + '\n');
  } catch (err) {
    return {
      filePath,
      entriesRemoved,
      rewritten: false,
      error: `write failed: ${String(err)}`,
    };
  }
  return { filePath, entriesRemoved, rewritten: true };
}

/**
 * Run every global-config scrub. Idempotent across passes; safe to call from
 * `runGlobalBootstrap`.
 */
export function runGlobalConfigMigration(): GlobalConfigMigrationResult {
  const outcomes: GlobalConfigMigrationOutcome[] = [
    scrubGeminiTrustedHooks(),
  ];
  return {
    outcomes,
    noOp: outcomes.every((o) => o.entriesRemoved === 0),
  };
}
