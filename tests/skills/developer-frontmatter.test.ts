import { expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const MAX_DESCRIPTION_CHARS = 1024;
const root = path.resolve('.agents/skills');
const skills = fs.readdirSync(root).map(name => path.join(root, name, 'SKILL.md')).filter(file => fs.existsSync(file));
it('discovers developer skills', () => expect(skills.length).toBeGreaterThan(0));
it.each(skills)('%s has YAML frontmatter and a bounded description', (file) => {
  const frontmatter = fs.readFileSync(file, 'utf8').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  expect(frontmatter).not.toBeNull();
  const fields = parse(frontmatter![1]);
  expect(typeof fields.description).toBe('string');
  expect(fields.description.length).toBeGreaterThan(0);
  expect(fields.description.length).toBeLessThanOrEqual(MAX_DESCRIPTION_CHARS);
});
