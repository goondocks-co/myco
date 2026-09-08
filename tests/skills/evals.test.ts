/**
 * The trigger-eval cases every shipped skill carries.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT. It proves the case exists, is
 * well-formed, covers both polarities, and asks for the skill using vocabulary
 * the skill's own listing text actually shows a model. It does NOT prove the
 * skill fires: that needs a model, and the eval runner that would supply one is
 * early-access gated, so no per-PR gate can call it. Firing is measured by the
 * judged run that owns the eval suite.
 *
 * Saying so here matters more than the cases do. A gate whose name implies more
 * than it checks is how "the evals pass" comes to mean nothing, and this is
 * exactly the shape that invites it.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { SHIPPED_SKILLS_DIR } from '@myco/skills/names.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SKILLS_ROOT = path.join(REPO_ROOT, 'packages/myco', SHIPPED_SKILLS_DIR);
const EVALS_ROOT = path.join(REPO_ROOT, 'packages/myco/evals');

/** The graders the runner implements. A case naming anything else cannot be scored. */
const GRADERS = ['regex', 'contains', 'tool_used', 'tool_order', 'file_exists', 'exit_code', 'llm', 'baseline'];

/** Both polarities every skill owes: one request it should answer, one near-miss it should not. */
const POLARITIES = ['trigger', 'no-trigger'];

const skillNames = (): string[] =>
  fs
    .readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(SKILLS_ROOT, d.name, 'SKILL.md')))
    .map((d) => d.name)
    .sort();

const caseFile = (skill: string, polarity: string): string => path.join(EVALS_ROOT, skill, polarity, 'case.yaml');

/** The words a prompt asks with, lowercased, minus the ones every sentence carries. */
const STOPWORDS = new Set(
  'a an and are as at be been but by can do does for from has have how i if in into is it its me my no not of on or our so that the their them then there this to up was we what when where which who why will with you your'.split(
    ' ',
  ),
);
const words = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w));

const listingText = (skill: string): string => {
  const markdown = fs.readFileSync(path.join(SKILLS_ROOT, skill, 'SKILL.md'), 'utf-8');
  const match = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  return (match === null ? '' : match[1]).toLowerCase();
};

const NAMES = skillNames();

describe('shipped skill trigger evals', () => {
  it('enumerates a non-empty tree, and every case directory names a shipped skill', () => {
    expect(NAMES.length).toBeGreaterThan(0);
    const dirs = fs
      .readdirSync(EVALS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    // Both directions: a skill with no case, and a case for a skill that is gone.
    expect(dirs).toEqual(NAMES);
  });

  for (const skill of NAMES) {
    for (const polarity of POLARITIES) {
      describe(`${skill} / ${polarity}`, () => {
        it('has a case naming a grader the runner implements', () => {
          const file = caseFile(skill, polarity);
          expect(fs.existsSync(file)).toBe(true);
          const body = fs.readFileSync(file, 'utf-8');
          expect(/\nprompt: \|\n\s+\S/.test(body)).toBe(true);
          const named = [...body.matchAll(/^\s*-\s+([a-z_]+):/gm)].map((m) => m[1]);
          expect(named.length).toBeGreaterThan(0);
          expect(named.filter((g) => !GRADERS.includes(g))).toEqual([]);
          expect(body).toContain(`input_match: ${skill}`);
        });
      });
    }

    it(`${skill}: the trigger prompt asks in vocabulary the listing shows`, () => {
      // A case that fires on words the model never sees in the listing is
      // measuring the model's guesswork, not the skill's description.
      //
      // The skill's OWN NAME is excluded from the shared set. Every listing
      // contains it, so counting it would satisfy this for any prompt that
      // mentioned Myco at all — a near-vacuous pass, which is worse here than
      // no case, because the whole point is that the description carries the
      // trigger.
      const prompt = fs.readFileSync(caseFile(skill, 'trigger'), 'utf-8');
      const body = /\nprompt: \|\n([\s\S]*?)\ngraders:/.exec(prompt)?.[1] ?? '';
      const listing = listingText(skill);
      const ownName = new Set(skill.split('-'));
      const shared = words(body).filter((w) => !ownName.has(w) && listing.includes(w));
      expect({ skill, shared: shared.length > 0 }).toEqual({ skill, shared: true });
    });
  }
});
