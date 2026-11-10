/**
 * Meta gate: the query core is credential-blind.
 *
 * One core with two facades — an owner session for humans, a member token for machines —
 * is what keeps a dashboard and a sandboxed agent from disagreeing about what the vault
 * says. The core can be called WITHOUT a credential: no module under `read/**` imports an
 * authenticator, a cookie module, a request-handling module, or the full `Env`, and none
 * reaches an opened secret. That facades read through the core, and that no SQL runs outside
 * `db/**`, is the db-layer gate's.
 *
 * Static source scan, no worker boot.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../../packages/myco-server/src/', import.meta.url));
const READ_DIR = join(SRC, 'read');

const allFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const f = join(dir, e);
    return statSync(f).isDirectory() ? allFiles(f) : [f];
  });
const tsFiles = (dir: string): string[] => allFiles(dir).filter((f) => f.endsWith('.ts'));

/** Import specifiers in every form the language offers: quoted `from`, side-effect, and dynamic. */
function importSpecifiers(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of source.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) out.push(m[1]);
  for (const m of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1]);
  return out;
}

/**
 * An authenticator, a cookie module, or a module that handles a request: the route table, its context, the ingest
 * pipeline and its handlers and write path, any API facade. The wire's kind catalogue under `ingest/` is pure data.
 */
const FORBIDDEN_IMPORT = [/\/auth\//, /cookie/i, /\/pipeline\.js/, /\/routes\.js/, /\/context\.js/, /\/api\//, /\/ingest\/(?!kinds\.js$)/];

/** The secret store exposes only boolean presence and agent-login availability to reads. */
const SECRET_STORE = join(SRC, 'core', 'secrets.ts');
const SECRET_PRESENCE = new Set(['secretReadable', 'harnessCredentialAvailable', 'harnessCredentialAvailability']);
/** What opens a stored secret: a read reaching any of these could hand a decrypted login to a dashboard. */
const OPENS_SECRET = /\b(?:openHarnessCredential|openProviderCredential|deploymentSecretStore)\s*\(|crypto\.subtle\.decrypt\b/;

/** A module's value imports inside the server source: each target file and the names it takes. Type-only imports are erased and reach nothing. */
function valueImports(file: string): Array<{ target: string; names: string[] | null }> {
  const source = readFileSync(file, 'utf8');
  const out: Array<{ target: string; names: string[] | null }> = [];
  for (const m of source.matchAll(/^\s*(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+['"](\.[^'"]+)['"]/gm)) {
    if (m[2] !== undefined) continue;
    const target = resolve(dirname(file), m[4]!).replace(/\.js$/, '.ts');
    const braces = /\{([\s\S]*)\}/.exec(m[3]!);
    const names = braces === null ? null : braces[1]!.split(',').map((n) => n.trim()).filter((n) => n !== '' && !n.startsWith('type ')).map((n) => n.split(/\s+as\s+/)[0]!.trim());
    out.push({ target, names });
  }
  for (const m of source.matchAll(/^\s*import\s+['"](\.[^'"]+)['"]/gm)) out.push({ target: resolve(dirname(file), m[1]!).replace(/\.js$/, '.ts'), names: null });
  return out;
}

describe('read layer', () => {
  it('never receives an opened secret: the store exposes only boolean checks, at any depth', () => {
    const offenders: string[] = [];
    for (const start of tsFiles(READ_DIR)) {
      const via = new Map<string, string | null>([[start, null]]);
      const queue = [start];
      while (queue.length > 0) {
        const file = queue.shift()!;
        const chain = () => { const steps: string[] = []; for (let at: string | null = file; at !== null; at = via.get(at) ?? null) steps.unshift(relative(SRC, at)); return steps.join(' -> '); };
        if (OPENS_SECRET.test(readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, ''))) offenders.push(`${chain()} opens a secret`);
        for (const { target, names } of valueImports(file)) {
          if (target === SECRET_STORE) {
            const taken = names ?? ['*'];
            if (taken.some((name) => !SECRET_PRESENCE.has(name))) offenders.push(`${chain()} takes ${taken.join(', ')} from core/secrets.ts`);
            continue;
          }
          if (!target.startsWith(SRC) || via.has(target)) continue;
          via.set(target, file);
          queue.push(target);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('imports no authenticator, cookie module, or request-handling module', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(READ_DIR)) {
      for (const spec of importSpecifiers(readFileSync(file, 'utf8'))) {
        if (FORBIDDEN_IMPORT.some((p) => p.test(spec))) offenders.push(`${file.slice(READ_DIR.length + 1)} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never names the run columns that carry configuration: overrides, context, cost detail', () => {
    // The run table holds the resolved provider configuration in columns a dashboard has no use for raw; a column
    // selected under an alias still has to be named. The keys of `run_context` a run is described by are read one at a
    // time in db/, and what the run list and detail publish is asserted in run-configuration-unpublished.test.ts.
    const offenders: string[] = [];
    for (const file of tsFiles(READ_DIR)) {
      const source = readFileSync(file, 'utf8');
      for (const column of ['execution_overrides', 'run_context', 'cost_data']) {
        if (new RegExp(`\\b${column}\\b`).test(source)) offenders.push(`${file.slice(READ_DIR.length + 1)}: ${column}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names no Request type and takes no full Env', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(READ_DIR)) {
      const source = readFileSync(file, 'utf8');
      if (/\bRequest\b/.test(source)) offenders.push(`${file.slice(READ_DIR.length + 1)}: Request`);
      if (/\bEnv\b/.test(source)) offenders.push(`${file.slice(READ_DIR.length + 1)}: Env`);
    }
    expect(offenders).toEqual([]);
  });

  it('takes no credential-shaped argument, whatever its declared type', () => {
    // Typed scans miss a credential arriving as a bare `string` or through an inline
    // structural binding type. These names are what a credential is called here.
    const CREDENTIAL_NAME = /\b(bearer|token_hash|tokenHash|cookie|sessionSecret|SESSION_SECRET|authorization)\b/i;
    const offenders: string[] = [];
    for (const file of tsFiles(READ_DIR)) {
      const source = readFileSync(file, 'utf8');
      // `tokenId` is an attribution key, not a credential; the read layer legitimately holds it.
      const stripped = source.replace(/\btokenId\b/g, '').replace(/\btoken_id\b/g, '');
      const m = CREDENTIAL_NAME.exec(stripped);
      if (m) offenders.push(`${file.slice(READ_DIR.length + 1)}: ${m[0]}`);
    }
    expect(offenders).toEqual([]);
  });

  it('reaches member_tokens only to describe them, never to authenticate', () => {
    const offenders: string[] = [];
    for (const file of tsFiles(READ_DIR)) {
      const source = readFileSync(file, 'utf8');
      if (/token_hash/.test(source)) offenders.push(file.slice(READ_DIR.length + 1));
    }
    expect(offenders).toEqual([]);
  });
});
