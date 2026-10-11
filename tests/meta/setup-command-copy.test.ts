import { expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dir, '../..');
const files = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(directory, entry.name);
  return entry.isDirectory() ? files(file) : /\.(ts|tsx|md)$/.test(file) ? [file] : [];
});

it('shipped guidance names existing commands instead of an unimplemented setup verb', () => {
  const candidates = ['packages/myco/src', 'packages/myco-shared/src', 'packages/myco-server/ui/src', 'packages/myco/skills', 'plugins/myco/skills']
    .flatMap(directory => files(path.join(repo, directory)));
  candidates.push(...fs.readdirSync(path.join(repo, 'docs')).filter(file => file.endsWith('.md')).map(file => path.join(repo, 'docs', file)));
  candidates.push(path.join(repo, 'README.md'));
  const forbidden = /\bmyco setup\b(?!-)/;
  const matches = candidates.flatMap(file => fs.readFileSync(file, 'utf8').split('\n')
    .flatMap((line, index) => forbidden.test(line) && !/^\s*(\*|\/\/)/.test(line) ? [`${path.relative(repo, file)}:${index + 1}`] : []));
  expect(matches).toEqual([]);
});

it('the setup skill uses address sign-in and docs let GitHub choose a unique app name', () => {
  const skill = fs.readFileSync(path.join(repo, 'packages/myco/skills/myco-setup/SKILL.md'), 'utf8');
  expect(skill).toContain('myco login <address>');
  expect(skill).toContain('An invite link is optional');
  expect(skill).not.toContain('needs an invite link');
  expect(skill).toContain('For an npm install');
  expect(skill).toContain('hash match between the platform package');
  const quickstart = fs.readFileSync(path.join(repo, 'docs/quickstart.md'), 'utf8');
  expect(quickstart).toContain('myco login <address>');
  expect(quickstart).not.toContain('invite link an admin gave you');
  expect(quickstart).not.toContain('PowerShell installer is still the Myco 1.4 one');
  const docs = fs.readFileSync(path.join(repo, 'docs/self-hosting.md'), 'utf8');
  expect(docs).not.toContain('--name "Myco sign-in"');
  expect(docs).toContain('Place it **first**');
  for (const route of ['/events', '/blobs/', '/import/']) expect(docs).toContain(route);
});

it('README install guidance matches the default 2.x installer and address sign-in', () => {
  const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
  expect(readme).toContain('myco login <address>');
  expect(readme).toContain('default installer selects the newest 2.x release, including prereleases while no stable 2.x release exists');
  expect(readme).toContain('Existing 1.4 installations keep their 1.4 updates unless you explicitly choose replacement');
  expect(readme).not.toContain('defaults to stable releases only');
  expect(readme).not.toContain('myco login <invite link>');
});
