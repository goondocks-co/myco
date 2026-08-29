/**
 * Meta gate: the 2.0 dashboard speaks the 2.0 vocabulary.
 *
 * `docs/architecture/myco-2.0.md` §3 replaces Grove, Team and the machine tier
 * with Deployment and Project, and the standing UI rule is that surfaces name
 * outcomes in the user's vocabulary. A word from the retired model in the new
 * package — in copy, a comment, or an identifier — is a 1.4 concept arriving
 * through a carried file, and the place to catch it is the source, not a
 * screenshot.
 *
 * Static source scan, no build.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI_SRC = path.join(REPO_ROOT, 'packages', 'myco-server', 'ui', 'src');

/** Words the retired model owned. `\bhost\b` does not match `localhost`. */
const RETIRED_VOCABULARY = /\b(grove|daemon|host|team|mycelium|symbiont)\b/i;

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (/\.(tsx?|css|html)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe('server dashboard vocabulary', () => {
  it('scans a non-trivial package (guards against a silently empty scan)', () => {
    expect(sources(UI_SRC).length).toBeGreaterThan(20);
  });

  it('carries no word from the retired Grove, Team, daemon or machine model', () => {
    const hits: string[] = [];
    for (const file of sources(UI_SRC)) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        const m = RETIRED_VOCABULARY.exec(line);
        if (m) hits.push(`${path.relative(REPO_ROOT, file)}:${i + 1} "${m[1]}"`);
      });
    }
    expect(hits, 'the 2.0 dashboard names Deployments and Projects; a retired word here is a carried 1.4 concept').toEqual([]);
  });
});
