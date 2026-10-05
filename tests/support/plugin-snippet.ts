import fs from 'node:fs';
import path from 'node:path';

const TEMPLATES = path.resolve(import.meta.dirname, '../../packages/myco/src/symbionts/templates');
const ROUTING_KEY = '0123456789abcdef/project';

/** Evaluate the shipped helpers against an isolated home and clock. */
export function snippetModule(
  env: NodeJS.ProcessEnv,
  spawns: { env?: NodeJS.ProcessEnv; args: string[] }[] = [],
  noted: string[] = [],
  execImpl?: (bin: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => { status: number | null; stdout: string; stderr: string },
  routingKey: string | null | (() => string | null) = ROUTING_KEY,
  now: () => number = Date.now,
  fileSystem: typeof fs = fs,
) {
  const snippet = fs.readFileSync(path.join(TEMPLATES, '_shared', 'plugin-helpers.ts.snippet'), 'utf-8');
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(snippet.split('{{mycoCredentialSource}}').join('registry'));
  return new Function(
    'readFileSync', 'appendFileSync', 'mkdirSync', 'statSync', 'lstatSync', 'accessSync', 'openSync', 'closeSync',
    'writeSync', 'unlinkSync', 'fstatSync', 'readSync', 'renameSync', 'rmdirSync', 'readdirSync', 'fsConstants', 'join', 'dirname', 'resolve', 'homedir', 'spawnSync', 'process', 'Date',
    `${js}; return { transcriptPathFor, appendTranscriptLine, holdsSessionClaim, releaseSessionClaim, runMycoHook, withClaimGate, CLAIM_STALE_MS, CLAIM_RECHECK_MS };`,
  )(
    fileSystem.readFileSync, fileSystem.appendFileSync, fileSystem.mkdirSync, fileSystem.statSync, fileSystem.lstatSync, fileSystem.accessSync, fileSystem.openSync, fileSystem.closeSync,
    fileSystem.writeSync, fileSystem.unlinkSync, fileSystem.fstatSync, fileSystem.readSync, fileSystem.renameSync, fileSystem.rmdirSync, fileSystem.readdirSync, fileSystem.constants, path.join, path.dirname, path.resolve, () => env.HOME,
    (_bin: string, args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      if (args[0] === 'member' && args[1] === 'routing-key') {
        const key = typeof routingKey === 'function' ? routingKey() : routingKey;
        return key === null ? { status: 1, stdout: '', stderr: 'no route' } : { status: 0, stdout: `${key}\n`, stderr: '' };
      }
      if (execImpl) return execImpl(_bin, args, opts);
      spawns.push({ env: opts?.env, args });
      return { status: 0, stdout: '{}', stderr: '' };
    },
    { ...process, env, platform: process.platform, stderr: { write: (line: string) => { noted.push(String(line)); return true; } } },
    class extends Date { static now() { return now(); } },
  ) as {
    transcriptPathFor: (d: string, a: string, s: string) => string;
    appendTranscriptLine: (d: string, a: string, s: string, r: Record<string, unknown>) => void;
    holdsSessionClaim: (d: string, a: string, s: string) => boolean;
    releaseSessionClaim: (d: string, a: string, s: string) => void;
    runMycoHook: (d: string, a: string, s: string, v: string, p: Record<string, unknown>) => unknown;
    withClaimGate: <T>(path: string, denied: T, operation: () => T) => T;
    CLAIM_STALE_MS: number;
    CLAIM_RECHECK_MS: number;
  };
}
