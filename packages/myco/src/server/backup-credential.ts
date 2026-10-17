import { password } from '@inquirer/prompts';
import type { Readable } from 'node:stream';
import { readD1ExportAnswer } from '@goondocks/myco-shared/d1-export';
import { cloudflareOperation } from '@myco/server/cloudflare-operation.js';
import { assertWranglerReady, CloudflareAuthenticationError, ensureCommandDir, putWorkerSecretValue, missingDeploymentRecordMessage, readDeploymentRecord, workerSecretNames } from '@myco/server/cloudflare.js';
import { D1_EXPORT_PROBE_TABLES, probeD1Export, type D1ExportProbeOptions } from '@myco/server/cloudflare-d1-export.js';
import type { CommandRunner } from '@myco/server/runner.js';

export const BACKUP_CREDENTIAL_NAME = 'RECOVERY_EXPORT_TOKEN';
export const BACKUP_CREDENTIAL_COMMAND = 'myco server backup-credential --target cloudflare';
export const BACKUP_CREDENTIAL_HINT = `Automatic backups need a backup access key. Run \`${BACKUP_CREDENTIAL_COMMAND}\` on the machine that manages this server.`;
const TOKEN_INPUT_LIMIT = 4096;
const PROBE_REQUEST_MS = 60_000;

export class BackupCredentialCancelled extends Error {
  constructor() { super('Cancelled; nothing was stored.'); this.name = 'BackupCredentialCancelled'; }
}

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
async function validateExportCredential(accountId: string, databaseId: string, token: string, fetchImpl: typeof fetch, recordDir: string, clock?: Pick<D1ExportProbeOptions, 'now' | 'sleep'>): Promise<void> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/export`;
  await probeD1Export({ recordDir, databaseId, ...clock, request: async (bookmark) => {
    let response: Response;
    let body: unknown;
    try {
      response = await fetchImpl(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(PROBE_REQUEST_MS),
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ output_format: 'polling', dump_options: { no_data: true, tables: D1_EXPORT_PROBE_TABLES },
          ...(bookmark === null ? {} : { current_bookmark: bookmark }) }),
      });
    } catch {
      return { kind: 'unknown', bookmark, cause: 'http', status: null, transient: true, detail: 'Cloudflare did not answer' };
    }
    if (response.status === 401 || response.status === 403) return { kind: 'refused-login', status: response.status };
    try { body = await response.json(); } catch { body = undefined; }
    const answer = readD1ExportAnswer(response.status, body, bookmark);
    if ('bookmark' in answer && answer.bookmark?.includes(token)) return { kind: 'unknown', bookmark, cause: 'protocol', status: null, transient: false, detail: 'Cloudflare returned an invalid bookmark' };
    return answer;
  } });
}

/** Hold operator ownership from the destination read through secret confirmation. */
export const installBackupCredential = cloudflareOperation(async (options: {
  mycoHome?: string;
  runner?: CommandRunner;
  fetchImpl?: typeof fetch;
  readSecret?: () => Promise<string>;
  probeClock?: Pick<D1ExportProbeOptions, 'now' | 'sleep'>;
}): Promise<void> => {
  const record = readDeploymentRecord(options.mycoHome);
  if (record === null) throw new Error(`${missingDeploymentRecordMessage(options.mycoHome)} No backup access key was read or stored.`);
  if (!record.accountId || !record.databaseId) throw new Error('This Cloudflare deployment record is missing its account or database id. No backup access key was read or stored.');
  const target = { accountId: record.accountId, workerName: record.workerName, runner: options.runner, configDir: ensureCommandDir(options.mycoHome) };
  await assertWranglerReady({ runner: options.runner, cwd: target.configDir });
  let token: string;
  try { token = await (options.readSecret ?? readBackupCredential)(); }
  catch (error) {
    if (error instanceof Error && error.name === 'ExitPromptError') throw new BackupCredentialCancelled();
    throw new Error('Backup access key could not be read. Use the hidden prompt or pipe one token on stdin.');
  }
  if (!token || token.length > TOKEN_INPUT_LIMIT || /\s/.test(token)) throw new Error('Backup access key must be one token on a single line. No key was stored.');
  await validateExportCredential(record.accountId, record.databaseId, token, options.fetchImpl ?? fetch, target.configDir, options.probeClock);
  try { await putWorkerSecretValue({ ...target, name: BACKUP_CREDENTIAL_NAME, value: token }); }
  catch (error) {
    if (error instanceof CloudflareAuthenticationError) throw error;
    throw new Error('Cloudflare did not confirm saving the backup access key. Run the command again to check and replace it.');
  }
  let names: string[];
  try { names = await workerSecretNames(target); }
  catch (error) {
    if (error instanceof CloudflareAuthenticationError) throw error;
    throw new Error('The backup access key was sent, but Cloudflare could not confirm it is present. Run the command again.');
  }
  if (!names.includes(BACKUP_CREDENTIAL_NAME)) throw new Error('Cloudflare did not list the saved backup access key. Run the command again.');
});
