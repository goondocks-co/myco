import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const WORKER_URL_REGEX = /(https:\/\/[^\s]+\.workers\.dev)/;
const D1_ID_JSON_REGEX = /"database_id"\s*:\s*"([0-9a-f-]{36})"/i;
const D1_ID_TEXT_REGEX = /id:\s*([0-9a-f-]{36})/i;
const KV_ID_REGEX = /"id":\s*"([0-9a-f]+)"/i;

export interface WranglerOptions {
  cwd?: string;
  input?: string;
  timeoutMs: number;
}

export interface TextPatch {
  filePath: string;
  transforms: Array<(text: string) => string>;
}

export interface StageDeploymentDirOptions {
  sourceDir: string;
  deployDir: string;
  reset?: boolean;
  extraCopies?: Array<{ sourceDir: string; destinationSubdir: string }>;
  textPatches?: TextPatch[];
  installDepsTimeoutMs?: number | null;
}

export function buildCommandEnv(): NodeJS.ProcessEnv {
  const nodeBinDir = path.dirname(process.execPath);
  const pathValue = process.env.PATH
    ? `${nodeBinDir}${path.delimiter}${process.env.PATH}`
    : nodeBinDir;
  return { ...process.env, PATH: pathValue };
}

export function runWrangler(args: string[], options: WranglerOptions): string {
  try {
    return execFileSync('wrangler', args, {
      cwd: options.cwd,
      env: buildCommandEnv(),
      input: options.input,
      encoding: 'utf-8',
      timeout: options.timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    const execError = error as Error & { stderr?: Buffer | string; stdout?: Buffer | string };
    const stderr = execError.stderr?.toString() ?? '';
    const stdout = execError.stdout?.toString() ?? '';
    const detail = [stderr, stdout].filter(Boolean).join('\n').trim();
    throw new Error(detail || execError.message);
  }
}

export function installDeploymentDeps(deployDir: string, timeoutMs: number): void {
  const packageJsonPath = path.join(deployDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return;

  execFileSync('npm', ['install', '--silent', '--no-audit', '--no-fund'], {
    cwd: deployDir,
    env: buildCommandEnv(),
    encoding: 'utf-8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function parseWorkerUrl(output: string): string {
  const workerUrl = output.match(WORKER_URL_REGEX)?.[1];
  if (!workerUrl) {
    throw new Error(`Could not parse worker URL from deploy output:\n${output}`);
  }
  return workerUrl;
}

export function parseD1Id(output: string): string {
  const jsonMatch = output.match(D1_ID_JSON_REGEX);
  if (jsonMatch) return jsonMatch[1];

  const textMatch = output.match(D1_ID_TEXT_REGEX);
  if (textMatch) return textMatch[1];

  throw new Error(`Could not parse D1 database ID from wrangler output:\n${output}`);
}

export function parseKvNamespaceId(output: string): string {
  const kvId = output.match(KV_ID_REGEX)?.[1];
  if (!kvId) {
    throw new Error(`Could not parse KV namespace ID from wrangler output:\n${output}`);
  }
  return kvId;
}

export function extractJsonArray(output: string): unknown[] {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`No JSON array found in output:\n${output}`);
  }
  return JSON.parse(output.slice(start, end + 1)) as unknown[];
}

/** The env var wrangler reads to pick a Cloudflare account in non-interactive mode. */
export const CLOUDFLARE_ACCOUNT_ID_ENV = 'CLOUDFLARE_ACCOUNT_ID';

/** Cloudflare account IDs are 32-character hex strings. */
const ACCOUNT_ID_REGEX = /^[0-9a-f]{32}$/i;

const MAX_ACCOUNT_PROMPT_ATTEMPTS = 3;

export interface WranglerAccount {
  name: string;
  id: string;
}

export function isValidCloudflareAccountId(id: string): boolean {
  return ACCOUNT_ID_REGEX.test(id.trim());
}

/**
 * Point every subsequent wrangler invocation at one account by setting
 * CLOUDFLARE_ACCOUNT_ID. `buildCommandEnv()` forwards process.env to each
 * wrangler child, so this single mutation propagates without threading an
 * account argument through every call site.
 */
export function applyCloudflareAccountId(id: string): void {
  process.env[CLOUDFLARE_ACCOUNT_ID_ENV] = id.trim();
}

/**
 * Extract a global `--account-id <id>` (or `--account-id=<id>`) flag from an
 * argv slice, returning the value and the remaining args. Pure: validation and
 * env application are the caller's responsibility.
 */
export function extractAccountIdFlag(args: string[]): { accountId?: string; rest: string[] } {
  const rest: string[] = [];
  let accountId: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--account-id') {
      accountId = args[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg.startsWith('--account-id=')) {
      accountId = arg.slice('--account-id='.length);
      continue;
    }
    rest.push(arg);
  }
  return { accountId, rest };
}

/**
 * Parse the account table that `wrangler whoami` renders for an authenticated
 * user. Rows are delimited by the box-drawing bar; a real account row's last
 * cell is a 32-hex account ID, which skips the header and (bar-less) border
 * rows. Border bars produce a leading and trailing empty cell that we drop,
 * keeping the interior cells — so an account with a blank Name still parses
 * (we don't filter empty cells, which would collapse such a row and undercount).
 *
 * Returns [] for any non-table output (older wrangler, a single-line "logged
 * in" stub). The guard this feeds therefore assumes a modern wrangler whose
 * whoami prints this table even for a single account; on that wrangler an
 * authenticated user always yields >=1 row. A future wrangler that changed the
 * format would degrade this to wrangler's own account handling — caught by the
 * live smoke that any wrangler-version bump warrants.
 */
export function parseWranglerAccounts(whoamiOutput: string): WranglerAccount[] {
  const accounts: WranglerAccount[] = [];
  for (const line of whoamiOutput.split('\n')) {
    if (!line.includes('│')) continue;
    const cells = line.split('│').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2) continue;
    const id = cells[cells.length - 1];
    if (!ACCOUNT_ID_REGEX.test(id)) continue;
    accounts.push({ name: cells[0], id });
  }
  return accounts;
}

async function defaultPrompt(question: string): Promise<string> {
  const readline = await import('node:readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

async function selectAccount(
  accounts: WranglerAccount[],
  prompt: (question: string) => Promise<string>,
  log: (message: string) => void,
): Promise<WranglerAccount> {
  for (let attempt = 1; attempt <= MAX_ACCOUNT_PROMPT_ATTEMPTS; attempt += 1) {
    const answer = (await prompt(`Account [1-${accounts.length}]: `)).trim();
    const choice = Number.parseInt(answer, 10);
    if (Number.isInteger(choice) && choice >= 1 && choice <= accounts.length) {
      return accounts[choice - 1];
    }
    log(`Invalid selection "${answer}" — enter a number between 1 and ${accounts.length}.`);
  }
  throw new Error('No valid Cloudflare account selected.');
}

export interface ResolveAccountOptions {
  /** Captured `wrangler whoami` stdout. */
  whoamiOutput: string;
  /** Whether stdin is interactive; when false a multi-account state is a hard error. */
  isTTY: boolean;
  /** Prompt function (injectable for tests); defaults to a readline prompt. */
  prompt?: (question: string) => Promise<string>;
  /** Progress sink (injectable for tests); defaults to console.log. */
  log?: (message: string) => void;
}

/**
 * Ensure exactly one Cloudflare account is selected before provisioning, so a
 * multi-account wrangler login doesn't fail mid-flow (after some resources are
 * already created in an arbitrary account). Precedence:
 *   1. CLOUDFLARE_ACCOUNT_ID already set (the --account-id flag or a manual
 *      export) — respected, no prompt.
 *   2. 0 or 1 parsed accounts — no-op; wrangler selects the sole account itself.
 *   3. >=2 accounts on a TTY — interactive picker, then set the env.
 *   4. >=2 accounts without a TTY — throw, listing accounts and the flag to use.
 */
export async function resolveCloudflareAccount(options: ResolveAccountOptions): Promise<void> {
  if (process.env[CLOUDFLARE_ACCOUNT_ID_ENV]?.trim()) return;

  const accounts = parseWranglerAccounts(options.whoamiOutput);
  if (accounts.length <= 1) return;

  if (!options.isTTY) {
    const list = accounts.map((account) => `  ${account.name}: ${account.id}`).join('\n');
    throw new Error(
      'More than one Cloudflare account is available and none was selected.\n' +
        `Pass --account-id <id> (or set ${CLOUDFLARE_ACCOUNT_ID_ENV}). Available accounts:\n${list}`,
    );
  }

  const log = options.log ?? console.log;
  const prompt = options.prompt ?? defaultPrompt;
  log('\nMultiple Cloudflare accounts available. Select one:\n');
  accounts.forEach((account, index) => log(`  ${index + 1}) ${account.name}  (${account.id})`));
  log('');
  const selected = await selectAccount(accounts, prompt, log);
  applyCloudflareAccountId(selected.id);
  log(`\nUsing Cloudflare account: ${selected.name} (${selected.id})`);
  log(`Tip: pass --account-id ${selected.id} next time to skip this prompt.\n`);
}

export function stageDeploymentDir(options: StageDeploymentDirOptions): string {
  if (options.reset) {
    fs.rmSync(options.deployDir, { recursive: true, force: true });
  }
  fs.mkdirSync(options.deployDir, { recursive: true });
  fs.cpSync(options.sourceDir, options.deployDir, { recursive: true });

  for (const copy of options.extraCopies ?? []) {
    fs.cpSync(copy.sourceDir, path.join(options.deployDir, copy.destinationSubdir), { recursive: true });
  }

  for (const patch of options.textPatches ?? []) {
    const absolutePath = path.join(options.deployDir, patch.filePath);
    let nextText = fs.readFileSync(absolutePath, 'utf-8');
    for (const transform of patch.transforms) {
      nextText = transform(nextText);
    }
    fs.writeFileSync(absolutePath, nextText, 'utf-8');
  }

  if (options.installDepsTimeoutMs) {
    installDeploymentDeps(options.deployDir, options.installDepsTimeoutMs);
  }

  return options.deployDir;
}
