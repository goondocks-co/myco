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
