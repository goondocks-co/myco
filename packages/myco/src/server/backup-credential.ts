import { password } from '@inquirer/prompts';
import type { Readable } from 'node:stream';
import { readD1ExportAnswer } from '@goondocks/myco-shared/d1-export';
import { cloudflareOperation } from '@myco/server/cloudflare-operation.js';
import { assertWranglerPresent, ensureCommandDir, putWorkerSecretValue, readDeploymentRecord, workerSecretNames } from '@myco/server/cloudflare.js';
import { D1_EXPORT_POLL_MS } from '@myco/server/cloudflare-d1-export.js';
import type { CommandRunner } from '@myco/server/runner.js';

export const BACKUP_CREDENTIAL_NAME = 'RECOVERY_EXPORT_TOKEN';
export const BACKUP_CREDENTIAL_COMMAND = 'myco server backup-credential --target cloudflare';
export const BACKUP_CREDENTIAL_HINT = `Automatic backups need a backup access key. Run \`${BACKUP_CREDENTIAL_COMMAND}\` on the machine that manages this server.`;
const TOKEN_INPUT_LIMIT = 4096;
const PROBE_REQUEST_MS = 60_000;
const PROBE_POLLS = 30;

/** Read a single secret through a hidden terminal prompt or piped stdin. */
export async function readBackupCredential(
  input: Readable & { isTTY?: boolean } = process.stdin,
  hiddenPrompt: (options: { message: string; toggleMask: boolean }) => Promise<string> = password,
): Promise<string> {
  if (input.isTTY) return hiddenPrompt({ message: 'Cloudflare backup access key (input hidden):', toggleMask: false });
  let value = '';
  for await (const chunk of input) {
    value += String(chunk);
    if (value.length > TOKEN_INPUT_LIMIT) throw new Error('Backup access key must be one token on a single line.');
  }
  return value.replace(/\r?\n$/, '');
}

/** Validate export access on the recorded database with only its schema metadata table's definition. */
async function validateExportCredential(accountId: string, databaseId: string, token: string, fetchImpl: typeof fetch): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/export`;
  const request = async (bookmark: string | null) => {
    let response: Response;
    let body: unknown;
    try {
      response = await fetchImpl(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(PROBE_REQUEST_MS),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ output_format: 'polling', dump_options: { no_data: true, tables: ['schema_meta'] },
          ...(bookmark === null ? {} : { current_bookmark: bookmark }) }),
      });
      body = await response.json();
    } catch {
      throw new Error('Could not check this backup access key with Cloudflare. No key was stored; check connectivity and try again.');
    }
    const answer = readD1ExportAnswer(response.status, body, bookmark);
    if (answer.kind !== 'running' && answer.kind !== 'complete') {
      throw new Error('Cloudflare could not export this server’s database with that backup access key. No key was stored. Use Account → D1 → Edit for the account that manages this server.');
    }
    return answer;
  };
  let answer = await request(null);
  if (answer.kind === 'complete') return;
  if (!answer.bookmark) throw new Error('Cloudflare did not identify the backup access check. No key was stored.');
  for (let poll = 0; poll < PROBE_POLLS; poll += 1) {
    if (poll > 0) await new Promise((resolve) => setTimeout(resolve, D1_EXPORT_POLL_MS));
    answer = await request(answer.bookmark);
    if (answer.kind === 'complete') return;
  }
  throw new Error('The backup access check has not finished. No key was stored. Wait for Cloudflare’s small schema export to end before trying again.');
}

/** Hold operator ownership from the destination read through secret confirmation. */
export const installBackupCredential = cloudflareOperation(async (options: {
  mycoHome?: string;
  runner?: CommandRunner;
  fetchImpl?: typeof fetch;
  readSecret?: () => Promise<string>;
}): Promise<void> => {
  const record = readDeploymentRecord(options.mycoHome);
  if (record === null) throw new Error('No Cloudflare deployment record on this machine. Run this command on the machine that manages the server.');
  if (!record.accountId || !record.databaseId) throw new Error('This Cloudflare deployment record is missing its account or database id. No backup access key was read or stored.');
  const target = { accountId: record.accountId, workerName: record.workerName, runner: options.runner, configDir: ensureCommandDir(options.mycoHome) };
  await assertWranglerPresent(options.runner, target.configDir);
  let token: string;
  try { token = await (options.readSecret ?? readBackupCredential)(); }
  catch { throw new Error('Backup access key could not be read. Use the hidden prompt or pipe one token on stdin.'); }
  if (!token || token.length > TOKEN_INPUT_LIMIT || /\s/.test(token)) throw new Error('Backup access key must be one token on a single line. No key was stored.');
  await validateExportCredential(record.accountId, record.databaseId, token, options.fetchImpl ?? fetch);
  try { await putWorkerSecretValue({ ...target, name: BACKUP_CREDENTIAL_NAME, value: token }); }
  catch { throw new Error('Cloudflare did not confirm saving the backup access key. Run the command again to check and replace it.'); }
  let names: string[];
  try { names = await workerSecretNames(target); }
  catch { throw new Error('The backup access key was sent, but Cloudflare could not confirm it is present. Run the command again.'); }
  if (!names.includes(BACKUP_CREDENTIAL_NAME)) throw new Error('Cloudflare did not list the saved backup access key. Run the command again.');
});
