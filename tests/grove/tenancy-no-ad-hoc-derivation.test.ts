import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Modules routed through `grove/project-tenancy.ts`. They must NOT re-derive
 * tenancy ad-hoc; project-tenancy.ts is the authority and is intentionally
 * excluded from this guard (it owns the raw `teamRegistry` reads).
 */
const GUARDED = [
  'packages/myco/src/db/queries/team-outbox.ts',
];

const FORBIDDEN = [
  /teamRegistry\.list\(\)\s*\.\s*flatMap/,
  /joinedAnyTeam\s*=\s*teamRegistry\.list\(\)\.length/,
];

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 20; i += 1) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate repo root (no package.json) walking up from ${start}`);
}

const REPO_ROOT = findRepoRoot(import.meta.dir);

describe('tenancy: guarded modules route through the authority', () => {
  for (const file of GUARDED) {
    it(`${file} exists, is non-empty, and has no ad-hoc tenancy derivation`, () => {
      const abs = path.join(REPO_ROOT, file);
      expect(fs.existsSync(abs)).toBe(true);
      const src = fs.readFileSync(abs, 'utf8');
      expect(src.length).toBeGreaterThan(0);
      for (const re of FORBIDDEN) {
        expect(re.test(src)).toBe(false);
      }
    });
  }
});
