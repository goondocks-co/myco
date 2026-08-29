/**
 * Meta gate: the query core is credential-blind, and the facades go through it.
 *
 * One core with two facades — an owner session for humans, a member token for machines —
 * is what keeps a dashboard and a sandboxed agent from disagreeing about what the vault
 * says. Two properties hold that up, and each fails on its own:
 *
 *   1. The core can be called WITHOUT a credential: no module under `read/**` imports an
 *      authenticator, a cookie module, a request-handling module, or the full `Env`.
 *   2. The facades USE it: no module issues SQL outside `read/**` and `ingest/**`. A gate
 *      that only proves (1) leaves `api/**` free to query D1 directly while staying green.
 *
 * Static source scan, no worker boot.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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

/** The modules the core is made of. A named floor, not a count: a count sails through a silent collapse. */
const CORE_MODULES = ['activity.ts', 'blobs.ts', 'children.ts', 'cortex.ts', 'meta.ts', 'plans.ts', 'runs.ts', 'scope.ts', 'credentials.ts', 'sessions.ts', 'transcript.ts'] as const;

const FORBIDDEN_IMPORT = [/\/auth\//, /cookie/i, /\/pipeline\.js/, /\/routes\.js/, /\/context\.js/, /\/api\//];

describe('read layer', () => {
  it('is made of exactly the named core modules, and says so when that changes', () => {
    const present = tsFiles(READ_DIR).map((f) => f.slice(READ_DIR.length + 1)).sort();
    // Witness log: the assertion below pins the set, and this line makes a change legible
    // in the run output instead of only in a diff.
    console.log(`[read-layer gate] core modules: ${present.join(', ')}`);
    expect(present).toEqual([...CORE_MODULES].sort());
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

  it('never names the run columns that carry configuration: overrides, context, cost detail, checkpoints', () => {
    // The run table holds the resolved provider configuration in four columns a
    // dashboard has no use for raw. A column selected under an alias still has to
    // be named, so the names appearing anywhere in a read module is the gate; the
    // one reader that parses `checkpoints` into phases names it in exactly one
    // module, which is pinned here.
    const offenders: string[] = [];
    for (const file of tsFiles(READ_DIR)) {
      const source = readFileSync(file, 'utf8');
      const rel = file.slice(READ_DIR.length + 1);
      for (const column of ['execution_overrides', 'run_context', 'cost_data', 'checkpoints']) {
        if (source.includes(column) && !(column === 'checkpoints' && rel === 'runs.ts')) offenders.push(`${rel}: ${column}`);
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

  it('is what every facade reads through: SQL is issued only from the named modules', () => {
    // Scoping this to one directory would leave the next facade free. Plan 5's `/mcp` and
    // recall sit beside `api/**`, not under it, so the scan enumerates all of `src/` and
    // allows only the modules that own storage:
    //   read/**       the query core
    //   ingest/**     the write path
    //   db/**         schema and migration
    //   auth/tokens.ts, auth/refresh.ts, auth/enrollment.ts, auth/step-up.ts
    //                     the credential store
    //   core/secrets.ts   the Deployment secret store — it OWNS deployment_secrets,
    //                     and holds the only decrypt in the codebase
    //   core/settings.ts  the one validated settings write path — it OWNS
    //                     deployment_settings and project_capabilities
    //   core/runs.ts      the agent run control plane — it OWNS agent_runs and
    //                     agent_state, and holds the two operations whose
    //                     atomicity lives in a WHERE clause rather than a caller
    //   core/resume.ts     the resume model — it reads and retires agent_runs on
    //                     the resumability axis, and holds the supersede query
    //                     whose clock is the ORIGINAL dispatch rather than the
    //                     current attempt
    //   core/provenance.ts release state — it OWNS knowledge_release_state on
    //                     the read side, and holds the one bulk lookup that
    //                     keeps annotation off an N+1
    //   core/digests.ts   digest extracts — it OWNS digest_extracts and
    //                     digest_extract_revisions, and holds the archive that
    //                     makes replacing a digest non-destructive
    //   core/skills.ts    the skill lifecycle — it OWNS skill_records,
    //                     skill_candidates, skill_lineage and skill_usage, and
    //                     holds the cascade that stops a deleted skill from
    //                     being regenerated by its own candidate
    //   core/spores.ts    the spore store — it OWNS spores and resolution_events,
    //                     and holds the one write that moves a status and records
    //                     why it moved as a single commit
    //   pipeline.ts   one quota re-read on the ingest admission path
    const ALLOWED = [/^read\//, /^ingest\//, /^db\//, /^auth\/tokens\.ts$/, /^auth\/refresh\.ts$/, /^auth\/enrollment\.ts$/, /^auth\/step-up\.ts$/, /^auth\/identity-link\.ts$/, /^auth\/grants\.ts$/, /^auth\/members-admin\.ts$/, /^core\/secrets\.ts$/, /^core\/settings\.ts$/, /^core\/runs\.ts$/, /^core\/digests\.ts$/, /^core\/provenance\.ts$/, /^core\/resume\.ts$/, /^core\/skills\.ts$/, /^core\/spores\.ts$/, /^pipeline\.ts$/];
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const rel = file.slice(SRC.length);
      if (ALLOWED.some((p) => p.test(rel))) continue;
      if (/\.prepare\s*\(/.test(readFileSync(file, 'utf8'))) offenders.push(rel);
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
