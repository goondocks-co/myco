import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { putStoreSecret, putWorkerSecretValue, putWorkerSecrets, importCloudflareDatabase } from '@myco/server/cloudflare.js';
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
