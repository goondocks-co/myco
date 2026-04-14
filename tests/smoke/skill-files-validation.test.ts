import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { MAX_SKILL_DESCRIPTION_CHARS } from '@myco/agent/tools/skill-validator.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SKILLS_DIR = path.join(REPO_ROOT, '.agents', 'skills');
const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---/;

describe('checked-in .agents skills', () => {
  it('have YAML-parseable frontmatter and Codex-compatible descriptions', () => {
    const failures: string[] = [];

    for (const skillName of fs.readdirSync(SKILLS_DIR)) {
      const skillPath = path.join(SKILLS_DIR, skillName, 'SKILL.md');
      if (!fs.existsSync(skillPath)) continue;

      const content = fs.readFileSync(skillPath, 'utf8');
      const frontmatter = content.match(FRONTMATTER_PATTERN)?.[1];
      if (!frontmatter) {
        failures.push(`${skillName}: missing frontmatter`);
        continue;
      }

      try {
        const parsed = parseYaml(frontmatter) as { description?: unknown } | null;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          failures.push(`${skillName}: frontmatter did not parse to an object`);
          continue;
        }

        const description = typeof parsed.description === 'string' ? parsed.description : '';
        if (description.length > MAX_SKILL_DESCRIPTION_CHARS) {
          failures.push(
            `${skillName}: description is ${description.length} chars ` +
            `(max ${MAX_SKILL_DESCRIPTION_CHARS})`,
          );
        }
      } catch (error) {
        failures.push(
          `${skillName}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
        );
      }
    }

    expect(failures).toEqual([]);
  });
});
