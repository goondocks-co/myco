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
  elapsed: () => number = now,
  plugin?: "opencode" | "cline",
) {
  const source = fs.readFileSync(plugin ? path.join(TEMPLATES, plugin, 'plugin.ts') : path.join(TEMPLATES, '_shared', 'plugin-helpers.ts.snippet'), 'utf-8');
  const snippet = plugin ? source.replace(/^import .*;\n/gm, '').replace(/^const \{.*\} = nodeFs;\n/gm, '').replace(/^export default .*;\n/gm, '').replace(/^export /gm, '') : source;
  const realStart = performance.now();
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(snippet.split('{{mycoCredentialSource}}').join('registry'));
  return new Function(
    'readFileSync', 'appendFileSync', 'mkdirSync', 'statSync', 'lstatSync', 'accessSync', 'openSync', 'closeSync',
    'writeSync', 'unlinkSync', 'fstatSync', 'readSync', 'renameSync', 'rmdirSync', 'readdirSync', 'fsConstants', 'join', 'dirname', 'resolve', 'homedir', 'spawnSync', 'process', 'Date', 'performance',
    `${js}; return { transcriptPathFor, appendTranscriptLine, holdsSessionClaim, releaseSessionClaim, runMycoHook, withClaimGate, initializeTranscriptSession, CLAIM_STALE_MS, CLAIM_RECHECK_MS ${plugin ? `, ${plugin === "cline" ? "MycoClinePlugin" : "MycoPlugin"}` : ""} };`,
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
    { now: () => elapsed() + performance.now() - realStart },
  ) as {
    transcriptPathFor: (d: string, a: string, s: string) => string;
    appendTranscriptLine: (d: string, a: string, s: string, r: Record<string, unknown>) => "committed" | "refused" | "failed";
    holdsSessionClaim: (d: string, a: string, s: string) => boolean;
    releaseSessionClaim: (d: string, a: string, s: string) => void;
    runMycoHook: (d: string, a: string, s: string, v: string, p: Record<string, unknown>) => unknown;
    withClaimGate: <T>(path: string, denied: T, operation: () => T) => T;
    initializeTranscriptSession: (d: string, a: string, s: string) => { status: "committed" | "refused" | "failed" };
    MycoPlugin: (input: { directory: string; client: unknown }) => Promise<Record<string, (input: unknown, output?: unknown) => Promise<unknown>>>;
    MycoClinePlugin: { setup: (api: unknown, ctx: unknown) => void; hooks: Record<string, (input: unknown, ctx: unknown) => Promise<unknown>> };
    CLAIM_STALE_MS: number;
    CLAIM_RECHECK_MS: number;
  };
}
