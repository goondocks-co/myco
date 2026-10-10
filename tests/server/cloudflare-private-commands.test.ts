import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CloudflareAuthenticationError, putStoreSecret, putWorkerSecretValue, putWorkerSecrets, importCloudflareDatabase } from '@myco/server/cloudflare.js';
import type { CommandRunner } from '@myco/server/runner.js';

it('withholds private command output on both process rejection and provider failure for every secret writer and SQL import', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-private-commands-'));
  try {
    for (const throws of [false, true]) {
      const runner: CommandRunner = { async run(_command, args, options) {
        if (args.includes('--version')) return { code: 0, stdout: '4.126.0', stderr: '' };
        expect(args.join(' ')).not.toContain('synthetic-private');
        expect(options?.env).toMatchObject({ CLOUDFLARE_ACCOUNT_ID: 'fixture', WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG: 'log', WRANGLER_LOG_SANITIZE: 'true' });
        if (throws) throw new Error('synthetic-private-provider-exception');
        return { code: 1, stdout: 'synthetic-private-stdout', stderr: 'synthetic-private-stderr' };
      } };
      const options = { accountId: 'fixture', configDir: root, runner };
      const actions = [
        () => putStoreSecret({ ...options, storeId: 'store', name: 'key', value: 'synthetic-private-key' }),
        () => putWorkerSecretValue({ ...options, workerName: 'fixture', name: 'SESSION_SECRET', value: 'synthetic-private-session' }),
        () => putWorkerSecrets({ ...options, workerName: 'fixture', mycoHome: root }, { GITHUB_CLIENT_ID: 'fixture', GITHUB_CLIENT_SECRET: 'synthetic-private-github' }),
        () => importCloudflareDatabase({ ...options, databaseName: 'fixture', file: '/fixture/snapshot.sql' }),
      ];
      for (const action of actions) {
        let failure: unknown;
        try { await action(); } catch (error) { failure = error; }
        expect(String(failure)).toContain('provider output was withheld');
        expect(String(failure)).not.toContain('synthetic-private');
        expect(failure).not.toHaveProperty('cause');
      }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('keeps 10000 permission guidance without retaining private provider output in the error object', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-private-auth-'));
  try {
    const runner: CommandRunner = { async run() {
      return { code: 1, stdout: 'synthetic-private-stdout', stderr: 'Authentication error [code: 10000] synthetic-private-stderr' };
    } };
    let failure: unknown;
    try {
      await putStoreSecret({ accountId: 'fixture', configDir: root, runner, storeId: 'store', name: 'key', value: 'synthetic-private-key' });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(CloudflareAuthenticationError);
    expect(String(failure)).toContain('Secrets Store');
    expect(String(failure)).toContain('10000');
    expect(JSON.stringify(failure)).not.toContain('synthetic-private');
    expect(failure).not.toHaveProperty('cause');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('retains the endpoint and Wrangler permission hint while redacting credential fragments from every error surface', () => {
  const token = 'q7Zp9Kv2Mx8Rn5Wy3Hd6Ts4Ua1Bc0LfQ';
  const failure = new CloudflareAuthenticationError('npx', ['--no-install', 'wrangler', 'vectorize', 'list'], {
    code: 1, stdout: 'synthetic-private-stdout',
    stderr: `A request to the Cloudflare API (/accounts/fixture/vectorize/${token.slice(0, 6)}?token=${token}) failed.
Authentication error [code: 10000]
Are you missing the \`User->Memberships->Read\` permission?
synthetic-private-stderr ${token}`,
  }, { CF_API_TOKEN: token }, 'fixture');
  expect(String(failure)).toContain('Endpoint: /accounts/fixture/vectorize/[redacted]');
  expect(String(failure)).toContain('User->Memberships->Read');
  expect(String(failure)).toContain('CF_API_TOKEN in the environment');
  const surfaces = [String(failure), JSON.stringify(failure), failure.stack ?? ''].join('\n');
  expect(surfaces).not.toContain('synthetic-private');
  for (let index = 0; index <= token.length - 4; index++) {
    expect(surfaces).not.toContain(token.slice(index, index + 4));
  }
});
