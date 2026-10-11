import { expect, test } from 'bun:test';
import fs from 'node:fs';
import semver from 'semver';

interface LockedPackage {
  version?: string;
  dependencies?: Record<string, string>;
}

const lock: { packages: Record<string, LockedPackage> } = JSON.parse(
  fs.readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'),
);

test('the harness and Agents SDK share one compatible OpenAI client', () => {
  const clients = Object.entries(lock.packages).filter(([name]) => name.endsWith('/node_modules/openai') || name === 'node_modules/openai');
  expect(clients.map(([name]) => name)).toEqual(['node_modules/openai']);

  const version = lock.packages['node_modules/openai']!.version!;
  const consumers = Object.entries(lock.packages).filter(([name, pkg]) =>
    (name === '' || name.startsWith('node_modules/@openai/')) && pkg.dependencies?.openai,
  );
  expect(consumers.some(([name]) => name === 'node_modules/@openai/agents-openai')).toBe(true);
  for (const [name, pkg] of consumers) {
    expect(semver.satisfies(version, pkg.dependencies!.openai!), `${name || 'root'} requires ${pkg.dependencies!.openai}`).toBe(true);
  }
});
