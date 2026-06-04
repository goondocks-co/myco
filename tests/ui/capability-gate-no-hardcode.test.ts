/**
 * Enforces that no site in packages/myco/src reads capability master gates
 * directly for a gate decision — every gate call must go through
 * `capabilityEnabled(config, capId)` from config/capabilities.ts.
 *
 * Mirrors the scope-policy-no-hardcode.test.ts pattern (grep + fail).
 *
 * Excluded files:
 *   - capabilities.ts — owns the predicate and the registry (authoritative)
 *   - schema.ts       — field declarations (z.boolean().default(true) etc.)
 *   - focus.ts        — path strings for UI breadcrumb/navigation, not gate logic
 *   - paths.ts        — config path constants, not gate logic
 *   - *.test.ts       — test helpers may reference fields directly
 */

import { describe, it, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '../../packages/myco/src');

// Property-access patterns for master gate fields that should only appear
// inside capabilities.ts (as registry values) or schema.ts (as field defs).
// Matches: `.cortex.canopy.enabled`, `['cortex']['canopy']['enabled']`, etc.
// Does NOT match innocuous sub-toggles like `.cortex.instructions.inject_on_session_start`
// or `.cortex.spores.inject_on_prompt_submit`.
const BANNED = /\.cortex\.canopy\.enabled\b|\bcortex\.canopy\.enabled\b/;

const ALLOWED_SUFFIXES = [
  'config/capabilities.ts',
  'config/schema.ts',
  'config/focus.ts',
  'config/paths.ts',
];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

function isAllowed(filePath: string): boolean {
  const rel = filePath.replace(SRC + '/', '');
  return (
    rel.endsWith('.test.ts') ||
    ALLOWED_SUFFIXES.some((suffix) => rel.endsWith(suffix))
  );
}

describe('capability gate not hardcoded outside capabilities.ts', () => {
  it('no direct .cortex.canopy.enabled access outside capabilities.ts/schema.ts', () => {
    const offenders = walk(SRC)
      .filter((f) => !isAllowed(f))
      .filter((f) => BANNED.test(fs.readFileSync(f, 'utf-8')));
    expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
  });
});
