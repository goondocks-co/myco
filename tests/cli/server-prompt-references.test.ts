import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '@myco/cli/server.js';
import { createLocalDeployment, DEFAULT_LOCAL_RECORD, resolveLocalPaths } from '@myco/server/local.js';
import { writeDeploymentRecord } from '@myco/server/cloudflare.js';
import { cloudflarePromptReferenceCounts } from '@myco/server/prompt-reference-status.js';
import type { CommandRunner } from '@myco/server/runner.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';

let root: string;
let previous: Record<string, string | undefined>;
let cwd: string;
let sqlite: Database;
let log: ReturnType<typeof spyOn>;
let fetchSpy: ReturnType<typeof spyOn>;
let reads: string[];
let failRead: boolean;
let loginStartedAfterStatus: boolean;
const ACCOUNT = 'a'.repeat(32);
const DB = '11111111-2222-4333-8444-555555555555';
const runner: CommandRunner = { async run(_command, args) {
  const command = args.slice(2).join(' ');
  let stdout: string;
  if (command === '--version') stdout = '4.126.0';
  else if (command === 'whoami') stdout = 'OAuth fixture';
  else if (command.startsWith('deployments list')) stdout = `Version ID: ${DB}`;
  else if (command === 'auth token --json') {
    loginStartedAfterStatus = log.mock.calls.flat().includes('\nCloudflare Deployment');
    stdout = JSON.stringify({ type: 'oauth', token: 'test-only-operator' });
  }
  else if (command.startsWith('d1 execute')) stdout = JSON.stringify([{ success: true, results: [{ value: String(SERVER_SCHEMA_VERSION) }] }]);
  else throw new Error(`Unexpected fake command: ${command}`);
  return { code: 0, stdout, stderr: '' };
} };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-prompt-reference-status-'));
  const env: Record<string, string | undefined> = { HOME: `${root}/home`, CODEX_HOME: `${root}/codex`, CLAUDE_CONFIG_DIR: `${root}/claude`, XDG_CONFIG_HOME: `${root}/config`, MYCO_HOME: `${root}/myco`, TMPDIR: `${root}/tmp`, LOCALAPPDATA: `${root}/local`,
    CLOUDFLARE_API_TOKEN: undefined, CLOUDFLARE_API_KEY: undefined, CLOUDFLARE_EMAIL: undefined,
    CF_API_TOKEN: undefined, CF_API_KEY: undefined, CF_EMAIL: undefined };
  previous = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else { fs.mkdirSync(value, { recursive: true }); process.env[key] = value; }
  }
  cwd = process.cwd();
  process.chdir(root);
  const paths = resolveLocalPaths();
  createLocalDeployment(DEFAULT_LOCAL_RECORD, { library: null, vec0: null }, paths);
  sqlite = new Database(paths.databasePath);
  reads = [];
  failRead = false;
  loginStartedAfterStatus = false;
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith('/health')) return new Response('ok');
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`);
    const { sql, params = [] } = JSON.parse(String(init?.body)) as { sql: string; params?: never[] };
    reads.push(sql);
    if (failRead) return Response.json({ success: false, errors: [{ code: 7500, message: 'query refused' }] }, { status: 400 });
    return Response.json({ success: true, result: [{ success: true, results: sqlite.query(sql).all(...params), meta: { changes: 0 } }] });
  });
  log = spyOn(console, 'log').mockImplementation(() => {});
  writeDeploymentRecord({ accountId: ACCOUNT, workerName: 'myco-server', databaseName: 'myco-server', databaseId: DB, bucketName: 'b', versionId: DB, deployedAt: '2026-10-20T00:00:00Z' });
});
afterEach(() => {
  log.mockRestore();
  fetchSpy.mockRestore();
  sqlite.close();
  process.chdir(cwd);
  for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  fs.rmSync(root, { recursive: true, force: true });
});

for (const target of ['local', 'cloudflare']) describe(`prompt reference status on ${target}`, () => {
  async function status() {
    await run(['status', '--target', target], { runner, fetchImpl: globalThis.fetch });
    return log.mock.calls.flat().map(String).find(line => line.includes('Prompt references'));
  }
  it('prints zero through the target’s real read path', async () => {
    expect(await status()).toBe('  Prompt references (7 days): 0 dangling');
    if (target === 'cloudflare') {
      expect(reads).toHaveLength(4);
      expect(loginStartedAfterStatus).toBe(true);
      const lines = log.mock.calls.flat().map(String);
      expect(lines.findIndex(line => line.includes('Prompt references'))).toBeGreaterThan(lines.findIndex(line => line.includes('URL (recorded)')));
    }
  });
  it('prints the total and every reference kind for missing prompts', async () => {
    const now = Date.now();
    sqlite.run("INSERT INTO projects(project_id,name,created_at) VALUES ('p','P',1)");
    sqlite.run(`INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,agent,size,parsed_offset,first_received_at,last_received_at,token_id,role,parsed_through_at)
      VALUES ('p','tx','s','m','codex',100,100,1,1,'t','primary',?)`, [now]);
    sqlite.run(`INSERT INTO spore_injections(project_id,id,session_id,prompt_id,prompt_hash,spore_ids,ask_protocol,asked_at,created_at,delivered_prompt_id,delivered_at)
      VALUES ('p','r','s','missing','h','[]','v1',?,?,'missing-delivery',?)`, [now - 10, now - 5, now - 8]);
    expect(await status()).toBe('  Prompt references (7 days): 2 dangling (receipt_selected=1, answer_selected=0, receipt_delivered=1, answer_delivered=0)');
  });
  it('names an unavailable read rather than claiming zero', async () => {
    if (target === 'cloudflare') failRead = true;
    else sqlite.run('ALTER TABLE spore_injections RENAME TO unreadable_references');
    const line = await status();
    expect(line).toContain('  Prompt references (7 days): unavailable — ');
    expect(line).toContain(target === 'cloudflare' ? 'query refused' : 'no such table');
  });
});

it('refuses hosted status under a different --account-id before querying', async () => {
  const exit = spyOn(process, 'exit').mockImplementation(() => { throw new Error('fixture exit'); });
  const error = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(run(['status', '--target', 'cloudflare', '--account-id', 'b'.repeat(32)], { runner, fetchImpl: globalThis.fetch })).rejects.toThrow('fixture exit');
    expect(log.mock.calls.flat().map(String).some(line => line.includes('Prompt references'))).toBe(false);
    expect(error.mock.calls.flat()).toContain('status refused: selected account does not match the deployment record');
    expect(reads).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    exit.mockRestore();
    error.mockRestore();
  }
});

it('refuses a prompt-reference read for a different recorded account before querying', async () => {
  await expect(cloudflarePromptReferenceCounts({ accountId: 'b'.repeat(32), runner, fetch: globalThis.fetch })).rejects.toThrow('no matching recorded database');
  expect(fetchSpy).not.toHaveBeenCalled();
});
