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

/** The modules the core is made of. A named floor, not a count: a count sails through a silent collapse. */
const CORE_MODULES = ['accounting.ts', 'activity.ts', 'canopy.ts', 'capture.ts', 'blobs.ts', 'children.ts', 'cortex.ts', 'harness-health.ts', 'meta.ts', 'plans.ts', 'prompts.ts', 'processed.ts', 'run-reads.ts', 'run-outcome.ts', 'runs.ts', 'scope.ts', 'search.ts', 'search-types.ts', 'credentials.ts', 'embedding.ts', 'kpis.ts', 'machines.ts', 'material-readiness.ts', 'sessions.ts', 'task-descriptions.ts', 'task-start.ts', 'transcript.ts', 'turns.ts', 'uncaptured.ts', 'work.ts'] as const;

const FORBIDDEN_IMPORT = [/\/auth\//, /cookie/i, /\/pipeline\.js/, /\/routes\.js/, /\/context\.js/, /\/api\//, /\/ingest\//];
/** The one ingest module a read may name: the wire's kind catalogue, pure data — never the write path beside it. */
const ADMITTED_IMPORT = [/\/ingest\/kinds\.js$/];

/** The secret store, and the one thing a read may take from it: whether a slot holds a value, read without opening it. */
const SECRET_STORE = join(SRC, 'core', 'secrets.ts');
const SECRET_PRESENCE = new Set(['secretStored']);
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
  it('is made of exactly the named core modules, and says so when that changes', () => {
    const present = tsFiles(READ_DIR).map((f) => f.slice(READ_DIR.length + 1)).sort();
    // Witness log: the assertion below pins the set, and this line makes a change legible
    // in the run output instead of only in a diff.
    console.log(`[read-layer gate] core modules: ${present.join(', ')}`);
    expect(present).toEqual([...CORE_MODULES].sort());
  });

  it('never reaches an opened secret: the store is read only through its presence check, at any depth', () => {
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
        if (FORBIDDEN_IMPORT.some((p) => p.test(spec)) && !ADMITTED_IMPORT.some((p) => p.test(spec))) offenders.push(`${file.slice(READ_DIR.length + 1)} -> ${spec}`);
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
    //
    // `run_context` is admitted in that same module and nowhere else, and only
    // under `json_extract` for the named keys below: the whole column carries
    // whatever a dispatch put in it, and a reader that selected it would hand a
    // dashboard the lot. A key added here is a key someone chose to publish.
    const offenders: string[] = [];
    for (const file of tsFiles(READ_DIR)) {
      const source = readFileSync(file, 'utf8');
      const rel = file.slice(READ_DIR.length + 1);
      for (const column of ['execution_overrides', 'run_context', 'cost_data', 'checkpoints']) {
        if (!source.includes(column)) continue;
        if (rel === 'runs.ts' && (column === 'checkpoints' || column === 'run_context')) continue;
        offenders.push(`${rel}: ${column}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('publishes exactly the named context keys, each one read out of the column rather than with it', () => {
    // The reader lives with the schema, which indexes one of its keys, and takes one named key at a time.
    const reader = readFileSync(join(READ_DIR, '..', 'db', 'run-context.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(reader.match(/run_context/g) ?? []).toHaveLength((reader.match(/json_(?:valid|extract)\(run_context/g) ?? []).length);
    expect(reader).toMatch(/json_extract\(run_context, '\$\.\$\{key\}'\)/);
    // Every mention of the column in the modules that read it sits inside that reader, so nothing selects it whole;
    // these are the keys they take.
    const keys: string[] = [];
    for (const module of ['runs.ts', 'run-reads.ts']) {
      const source = readFileSync(join(READ_DIR, module), 'utf8');
      expect({ module, column: source.match(/run_context/g) ?? [] }).toEqual({ module, column: [] });
      expect({ module, reader: /from '\.\.\/db\/run-context\.js'/.test(source) }).toEqual({ module, reader: true });
      keys.push(...[...source.matchAll(/contextValue\('([a-z_]+)'\)/g)].map((m) => m[1]!));
    }
    expect([...new Set(keys)].sort()).toEqual(['reason', 'replaced', 'replaces', 'session_id']);
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
    //   auth/tokens.ts, auth/refresh.ts, auth/enrollment.ts
    //                     the credential store
    //   core/secrets.ts   the Deployment secret store — it OWNS deployment_secrets,
    //                     and holds the only decrypt in the codebase
    //   core/settings.ts  the one validated settings write path — it OWNS
    //                     deployment_settings and project_capabilities
    //   core/machine-settings.ts  a machine's settings — it OWNS machine_settings,
    //                     and reads machine_claims to decide who reaches them
    //   core/runs.ts      the agent run control plane — it OWNS agent_runs and
    //                     agent_state, and holds the two operations whose
    //                     atomicity lives in a WHERE clause rather than a caller
    //   core/run-write-store.ts holds run authority assertions around atomic MCP mutations
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
    //   core/injection.ts what the prompt hook is served — it OWNS
    //                     spore_injections, and holds the INSERT OR IGNORE whose
    //                     one-prompt-content-per-session rule lives in the
    //                     primary key rather than in a caller
    //   core/recall.ts    what a prompt is served at submit time — it OWNS
    //                     session_injections, and holds the INSERT OR IGNORE
    //                     whose once-per-session rule lives in the primary key
    //                     rather than in a caller
    //   core/remotes.ts   git remotes as Project names — it OWNS project_remotes,
    //                     and holds the INSERT OR IGNORE whose one-remote-one-Project
    //                     rule lives in the primary key rather than in a caller
    //   core/backup.ts    the backup engine — it OWNS backups, and its dump and
    //                     additive restore are row transport over every table,
    //                     which no facade abstraction can carry
    //   core/tombstones.ts a session's deletion — it OWNS session_tombstones,
    //                     and its sweep spans every table a session projected
    //                     into as one commit, so no facade owns the whole of it
    //   core/blob-references.ts the blob reference catalogue — it OWNS the
    //                     held check over every reference, the one query the
    //                     orphan sweep, retention, deletion and the recovery
    //                     snapshot check share
    //   core/recovery-schema.ts the schema recovery captures before an export — it
    //                     OWNS the catalogue read both targets hold an export to
    //   core/object-release.ts the stored-object lifecycle — it OWNS object_releases,
    //                     the release candidates and recovery_holds, and holds the
    //                     transactions that journal an exact stored object while
    //                     removing the row that registered it
    //   core/recovery-hold.ts the recovery hold around the hosted producer — it
    //                     reads the open hold it settles
    //   core/backup-retention.ts the backup retention policy — it reads the policy
    //                     leaves and the catalogue it decides victims from
    //   core/worker-contacts.ts what a worker last said about itself — it OWNS
    //                     worker_contacts, the one write the claim and the lease
    //                     renewal share and the one fleet read Status answers from
    //   core/model-catalogs.ts the models each worker last listed — it OWNS
    //                     worker_model_catalogs, the one write a worker's report
    //                     makes and the reads Settings and a claim answer from
    //   core/release-provenance.ts release provenance — it OWNS
    //                     project_release_provenance and the reconciler's writes of
    //                     knowledge_release_state, and holds the claim whose one-check-
    //                     at-a-time rule lives in a WHERE clause rather than a caller
    //   core/store-maintenance.ts store maintenance — it OWNS the maintenance
    //                     outcome rows of schema_meta, and holds the conditional
    //                     claim and completion that keep one run of a check at a time
    //   platform/cloudflare/store-maintenance.ts the hosted checks — it sends the
    //                     maintenance statements D1 documents, which only it knows
    //   core/first-owner.ts a Deployment's first administrator — it OWNS the
    //                     first_member_setup receipt of schema_meta, and holds the
    //                     guarded statements a setup run one at a time relies on
    //   core/run-steps.ts a run's attempts and step logs — it OWNS
    //                     agent_run_attempts and agent_run_steps, and records an
    //                     attempt in the batch that claims its run
    //   core/harness-health.ts owns the current machine_harness_reports write;
    //                     its read SQL is in read/harness-health.ts
    //   core/relational-snapshot.ts reads the backup tables at one committed instant
    //   pipeline.ts   one quota re-read on the ingest admission path
    // core/ownership.ts owns the owner singleton, member roles and their audit receipts.
    // core/raw-claims.ts owns raw claim receipts and restore revision reservations.
    // core/raw-backfill.ts owns bounded provenance snapshots and their atomic checkpoint.
    // Authorization resolvers read local identity, liveness and resource evidence.
    const ALLOWED = [/^auth\/(authorization|http-authorization|mcp-authorization)\.ts$/, /^read\//, /^ingest\//, /^db\//, /^auth\/tokens\.ts$/, /^auth\/refresh\.ts$/, /^auth\/enrollment\.ts$/, /^auth\/identity-link\.ts$/, /^auth\/grants\.ts$/, /^auth\/members-admin\.ts$/, /^core\/secrets\.ts$/, /^core\/settings\.ts$/, /^core\/machine-settings\.ts$/, /^core\/repositories\.ts$/, /^core\/canopy\.ts$/, /^core\/runs\.ts$/, /^core\/run-write-store\.ts$/, /^core\/raw-resources\.ts$/, /^core\/raw-claims\.ts$/, /^core\/ownership\.ts$/, /^core\/raw-backfill\.ts$/, /^core\/raw-provenance\.ts$/, /^core\/activity\.ts$/, /^core\/backup\.ts$/, /^core\/relational-snapshot\.ts$/, /^core\/digests\.ts$/, /^core\/injection\.ts$/, /^core\/provenance\.ts$/, /^core\/recall\.ts$/, /^core\/remotes\.ts$/, /^core\/resume\.ts$/, /^core\/skills\.ts$/, /^core\/search-index\.ts$/, /^core\/embedding\/(reconcile|hubness|jobs|switch-store)\.ts$/, /^core\/spores\.ts$/, /^core\/tombstones\.ts$/, /^core\/blob-references\.ts$/, /^core\/recovery-schema\.ts$/, /^core\/object-release\.ts$/, /^core\/recovery-hold\.ts$/, /^core\/backup-retention\.ts$/, /^core\/worker-contacts\.ts$/, /^core\/run-steps\.ts$/, /^core\/model-catalogs\.ts$/, /^core\/harness-health\.ts$/, /^core\/store-maintenance\.ts$/, /^platform\/cloudflare\/store-maintenance\.ts$/, /^core\/release-provenance\.ts$/, /^core\/first-owner\.ts$/, /^pipeline\.ts$/];
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
