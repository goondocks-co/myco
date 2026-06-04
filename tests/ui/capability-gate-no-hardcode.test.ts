/**
 * Enforces that no site in packages/myco/src reads a capability master gate
 * directly for a gate decision — every gate call must go through
 * `capabilityEnabled(config, capId)` from config/capabilities.ts.
 *
 * Mirrors the scope-policy-no-hardcode.test.ts pattern (grep + fail).
 *
 * Excluded files (definitions / non-gate references):
 *   - config/capabilities.ts — owns the predicate and the registry (authoritative)
 *   - config/schema.ts       — field declarations (z.boolean().default(true) etc.)
 *   - config/focus.ts        — path strings for UI navigation, not gate logic
 *   - config/paths.ts        — config path-string constants, not gate logic
 *   - config/migrations.ts   — relocates legacy values; references gate paths by name
 *   - *.test.ts              — test helpers may reference fields directly
 *
 * The single surviving direct `.cortex.enabled` read is the prompt-input
 * payload field in context/cortex-brief.ts (`enabled: config.cortex.enabled`),
 * which describes config STATE to the agent — it is not a gate decision.
 * The line filter below allows that `enabled:`-keyed assignment shape while
 * still catching any gate-style read (`if (!config.cortex.enabled)` etc.).
 */

import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '../../packages/myco/src');

// The four capability master gates. `.cortex.enabled` is matched as a bare
// property access; the string-literal forms ('cortex.enabled') used as config
// path constants are excluded by file (focus.ts/paths.ts/migrations.ts) and by
// the quote-guard in the regex.
const MASTER_GATE_READS: RegExp[] = [
  /\.cortex\.canopy\.enabled\b/,
  /\.skills\.enabled\b/,
  /\.vault_evolution\.enabled\b/,
  /\.cortex\.enabled\b/,
];

const ALLOWED_SUFFIXES = [
  'config/capabilities.ts',
  'config/schema.ts',
  'config/focus.ts',
  'config/paths.ts',
  'config/migrations.ts',
];

// A `.cortex.enabled` read that is a prompt-input payload field (object key
// `enabled:` set to the config value) is descriptive state, not a gate. Allow
// only that exact assignment shape.
const PAYLOAD_FIELD = /^\s*enabled:\s*config\.cortex\.enabled\s*,?\s*$/;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

function isAllowedFile(filePath: string): boolean {
  const rel = filePath.replace(SRC + '/', '');
  return (
    rel.endsWith('.test.ts') ||
    ALLOWED_SUFFIXES.some((suffix) => rel.endsWith(suffix))
  );
}

/** Lines in a file that read a master gate directly and are not the allowed payload field. */
function offendingLines(content: string): string[] {
  return content.split('\n').filter((line) => {
    if (PAYLOAD_FIELD.test(line)) return false;
    return MASTER_GATE_READS.some((re) => re.test(line));
  });
}

describe('capability master gates not hardcoded outside capabilities.ts', () => {
  it('no direct master-gate read for any capability outside the predicate', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (isAllowedFile(file)) continue;
      const lines = offendingLines(fs.readFileSync(file, 'utf-8'));
      if (lines.length > 0) {
        offenders.push(`${path.relative(SRC, file)}: ${lines.map((l) => l.trim()).join(' | ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
