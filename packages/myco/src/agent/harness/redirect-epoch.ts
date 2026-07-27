import fs from 'node:fs';
import path from 'node:path';

import { resolveMycoHome } from '@myco/grove/paths.js';

/**
 * The moment harness transcripts stopped being written into the user's
 * session tree.
 *
 * Harness runs spawn the Claude Code CLI, which persists sessions under
 * `CLAUDE_CONFIG_DIR`. That defaulted to `~/.claude`, so agent transcripts
 * accumulated in the directory `claude-code.yaml` declares as its discovery
 * root, carrying no marker distinguishing them from a developer's own work.
 * Redirection moved them out, but the files already written stay where they
 * are, and nothing in them says which produced them.
 *
 * This timestamp is the boundary that makes them separable: a transcript in
 * the discovery root written after it cannot be a harness run, because the
 * harness no longer writes there. One older than it is genuinely ambiguous,
 * and a reader must say so rather than attribute it.
 *
 * Recorded as a file rather than read from the directory's own birthtime,
 * which several filesystems do not report.
 */

const EPOCH_FILENAME = '.myco-redirect-epoch';

export const HARNESS_SESSION_DIRNAME = 'agent-sessions';

/** Directory the harness redirects CLI session storage into. */
export function harnessSessionDir(mycoHome = resolveMycoHome()): string {
  return path.join(mycoHome, HARNESS_SESSION_DIRNAME);
}

/**
 * Stamp the epoch once, on first creation. Never rewritten — a later stamp
 * would move the boundary forward and reclassify already-separable
 * transcripts as ambiguous.
 */
export function writeHarnessRedirectEpoch(dir: string, now = Date.now()): void {
  const marker = path.join(dir, EPOCH_FILENAME);
  try {
    if (fs.existsSync(marker)) return;
    fs.writeFileSync(marker, JSON.stringify({ redirected_at: Math.floor(now / 1000) }), 'utf8');
  } catch {
    // A missing marker degrades to "no epoch known", which readers treat as
    // everything being ambiguous — conservative, never wrong in the unsafe
    // direction.
  }
}

/**
 * Epoch in seconds, or undefined when redirection has not yet run on this
 * machine. Undefined means no transcript can be dated relative to it.
 */
export function readHarnessRedirectEpoch(mycoHome = resolveMycoHome()): number | undefined {
  try {
    const raw = fs.readFileSync(path.join(harnessSessionDir(mycoHome), EPOCH_FILENAME), 'utf8');
    const parsed = JSON.parse(raw) as { redirected_at?: unknown };
    return typeof parsed.redirected_at === 'number' ? parsed.redirected_at : undefined;
  } catch {
    return undefined;
  }
}
