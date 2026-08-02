import { describe, expect, it } from 'bun:test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Meta-gate: any skill a doc presents as a slash command must actually be
 * user-invocable. Built-in skills live in packages/myco/skills/<name>/SKILL.md;
 * only those whose frontmatter carries `user-invocable: true` can be typed as
 * `/<name>` in an agent. The docs drifted on this twice, in two different
 * directions (a two-skill list; a list including the non-invocable `myco`),
 * so the invariant is pinned here instead of remembered.
 */

const ROOT = path.resolve(import.meta.dir, '../..');
const SKILLS_DIR = path.join(ROOT, 'packages/myco/skills');

/** Every markdown doc a user reads: repo-root files + docs/. Driven by
 *  `git ls-files` — TRACKED files only — so gitignored local content
 *  (docs/superpowers/ specs, docs/_site build output) can never fail the
 *  gate on a contributor's machine while CI stays green on its clean
 *  checkout. */
function docFiles(): string[] {
  const listed = execSync(
    "git ls-files -- README.md CONTRIBUTING.md AGENTS.md 'docs/*.md' 'docs/**/*.md'",
    { cwd: ROOT, encoding: 'utf-8' },
  );
  return listed.split('\n').filter((line) => line.trim() !== '');
}

function userInvocableSkills(): Set<string> {
  const out = new Set<string>();
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const head = fs.readFileSync(skillPath, 'utf-8').slice(0, 2000);
    if (/^user-invocable:\s*true$/m.test(head)) out.add(entry.name);
  }
  return out;
}

/** `/myco...` mentions inside backticks, e.g. `` `/myco-rules` ``. */
const SLASH_COMMAND_PATTERN = /`\/(myco[a-z0-9-]*)`/g;

describe('docs slash-command claims', () => {
  it('every documented /command maps to a user-invocable built-in skill', () => {
    const invocable = userInvocableSkills();
    expect(invocable.size).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const rel of docFiles()) {
      const content = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
      for (const match of content.matchAll(SLASH_COMMAND_PATTERN)) {
        const name = match[1];
        if (!invocable.has(name)) {
          violations.push(`${rel}: \`/${name}\` is documented as a slash command but ${
            fs.existsSync(path.join(SKILLS_DIR, name, 'SKILL.md'))
              ? 'its SKILL.md is not user-invocable'
              : 'no such built-in skill exists'
          }`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
