import { expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { parseSetupOptions } from '@myco/cli/setup.js';

const repo = path.resolve(import.meta.dir, '../..');
const files = (directory: string): string[] => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(directory, entry.name);
  return entry.isDirectory() ? files(file) : /\.(ts|tsx|md)$/.test(file) ? [file] : [];
});

const flagValues: Record<string, string> = {
  '--join': 'https://setup.invalid', '--runner': 'https://setup.invalid',
  '--project': 'proj_fixture', '--root': '/fixture/repo', '--new': 'Fixture',
  '--runner-name': 'fixture', '--runner-service': 'skip',
  '--create': 'cloudflare', '--account-id': 'a'.repeat(32), '--url': 'https://setup.invalid',
  '--org': 'fixture-org', '--app-name': 'Fixture', '--port': '8787', '--serve': 'terminal',
};

/** Normalize documentation placeholders while retaining actual values and flag combinations. */
function checkReference(command: string): void {
  for (const flag of command.match(/--[a-z][a-z0-9-]*|-h\b/g) ?? []) {
    const context = flag === '--json' || flag === '--check-remote' ? ['--status'] : [];
    parseSetupOptions([flag, ...(flag in flagValues ? [flagValues[flag]] : []), ...context]);
  }
  const tokens = command.match(/<[^>]+>|\[[^\]]+\]|[^\s]+/g) ?? [];
  const args: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const flag = tokens[index];
    if (['again', 'when', 'to', 'with', 'or', 'from', 'for', 'then', '[options]', ':'].includes(flag.replace(/[.!?;,]$/, ''))) break;
    args.push(flag);
    if (flag in flagValues) {
      const value = tokens[index + 1]?.replace(/[.!?;,]$/, '');
      if (value !== undefined && !value.startsWith('-') && !['or', 'to', 'when'].includes(value)) {
        args.push(/^<.*>$|^\[.*\]$|^\$\{[^}]+\}$/.test(value) || ['install|skip', 'cloudflare|local', 'service|terminal'].includes(value) ? flagValues[flag] : value);
        index++;
      }
    }
  }
  parseSetupOptions(args);
}

it('shipped guided-setup references name only accepted, available flags', () => {
  const candidates = ['packages/myco/src', 'packages/myco-shared/src', 'packages/myco-server/ui/src', 'packages/myco/skills', 'plugins/myco/skills']
    .flatMap(directory => files(path.join(repo, directory)));
  candidates.push(...fs.readdirSync(path.join(repo, 'docs')).filter(file => file.endsWith('.md')).map(file => path.join(repo, 'docs', file)));
  candidates.push(path.join(repo, 'README.md'));
  for (const file of candidates) for (const [index, line] of fs.readFileSync(file, 'utf8').split('\n').entries()) {
    for (const reference of line.matchAll(/\bmyco setup\b(?!-)(.*?)(?=\bmyco setup\b|[`"'\n]|$)/g)) {
      expect(() => checkReference(reference[1]), `${path.relative(repo, file)}:${index + 1}: ${reference[0]}`).not.toThrow();
    }
  }
});

it('the copy gate rejects unsupported journeys, values and combinations', () => {
  for (const reference of ['--create compose', '--create local --account-id <id>', '--create cloudflare --serve service', '--create cloudflare --join <address>', '--cutover', '--no-cutover', '--route <source>=<destination>', '--skip <source>', '--invented',
    '--join <address> --runner <address>', '--status --change', '--json', '--runner-service disabled', '--runner https://setup.invalid/path', 'create cloudflare', 'migrate', '--yes invented']) {
    expect(() => checkReference(reference)).toThrow();
  }
  for (const reference of ['--create cloudflare --account-id <id> --url https://setup.invalid --org fixture-org --app-name Fixture --yes', '--create local --port 8787 --serve terminal --yes', '--create cloudflare|local', '--join <address> --no-agents --no-runner', '--runner <address> --runner-name mini --runner-service skip --yes', '--status --json --check-remote', '--help']) {
    expect(() => checkReference(reference)).not.toThrow();
  }
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

it('front doors lead with invitations and admin-linked dashboard access before address sign-in', () => {
  for (const file of ['README.md', 'packages/myco/README.md', 'docs/index.html', 'docs/quickstart.md']) {
    const text = fs.readFileSync(path.join(repo, file), 'utf8').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const addressCommand = text.indexOf('myco setup --join <address>');
    const invite = text.indexOf('Invite a teammate');
    const accountLink = text.indexOf('Connect GitHub');
    expect(addressCommand, file).toBeGreaterThan(0);
    expect(invite, file).toBeGreaterThan(0);
    expect(accountLink, file).toBeGreaterThan(invite);
    expect(accountLink, file).toBeLessThan(addressCommand);
    expect(text, file).toContain('already sign in to the dashboard');
    expect(text, file).toContain('https://myco.sh/install.sh');
    expect(text, file).toContain('https://myco.sh/install.ps1');
  }
});
