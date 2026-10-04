import { expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';

it('audits every shard through the runner without writing a parity manifest outside its root', () => {
  const result = spawnSync('node', ['scripts/run-test-command.mjs', 'node', 'scripts/check-test-shards.mjs'], {
    env: { ...process.env, MYCO_TEST_STRICT_TEMP: '1' },
    encoding: 'utf8', timeout: 90_000,
  });
  expect({ status: result.status, stderr: result.stderr, error: result.error }).toEqual({ status: 0, stderr: '', error: undefined });
  for (const label of ['Full suite', 'CI test shards', 'CI parity shards', 'Required jobs']) {
    expect(result.stdout).toMatch(new RegExp(`${label}: [1-9]\\d* entries covered exactly once`));
  }
}, 100_000);
