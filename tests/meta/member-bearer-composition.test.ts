/**
 * Meta gate: one composer for a member request's headers.
 *
 * A Deployment refuses a member request that declares no protocol with 409
 * `protocol_version_unsupported`, on every route, for the life of the process.
 * A call site that writes its own `authorization: Bearer …` therefore reaches no
 * Deployment at all while passing every test that stubs one — which is exactly
 * what the worker's claim loop did. The defence is structural: `memberHeaders`
 * in `member/constants.ts` is the only place a member request's headers are
 * composed.
 *
 * So every file under `packages/myco/src` that composes a bearer header must be
 * one of three things, decided from the source rather than from a list of names:
 *
 * - the one member composer;
 * - a call on the HOST protocol, which declares `HOST_PROTOCOL_HEADER` in the
 *   same file (the daemon-to-host surface has its own versioned protocol);
 * - a call to a third-party API that knows nothing of Myco's protocols, named
 *   in `FOREIGN` with what it talks to.
 *
 * A new member call that hand-writes its headers matches none of the three and
 * fails here by name. Comments are stripped by the runtime's own transpiler, so
 * a header shape quoted in prose is not a composition.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'packages', 'myco', 'src');

/** The one module that composes a member request's headers. */
const MEMBER_COMPOSER = 'member/constants.ts';

/** The marker a host-protocol call carries: its own versioned protocol header. */
const HOST_PROTOCOL_MARKER = 'HOST_PROTOCOL_HEADER';

/** Calls to APIs outside Myco, with what each talks to. Adding one is a reviewed act. */
const FOREIGN: Readonly<Record<string, string>> = {
  'release-provenance/github.ts': 'the GitHub REST API',
  'upgrade/release-assets.ts': 'the GitHub release assets API',
  'agent/cost/openrouter.ts': 'the OpenRouter pricing API',
  'cli/providers/cloud-embedding-base.ts': 'a cloud embedding provider',
  'daemon/api/models.ts': 'a model provider\'s own API',
};

/**
 * Composing a bearer: `authorization` given a `Bearer` template, as an object
 * property, a bracketed key or a plain assignment, in either case of the name.
 */
const COMPOSES_BEARER = /authorization['"]?\]?\s*[:=]\s*`Bearer\s/i;

const transpiler = new Bun.Transpiler({ loader: 'ts', deadCodeElimination: false });

/** The module's code without its comments, so prose naming a header is not a composition. */
function codeOf(file: string): string {
  return transpiler.transformSync(fs.readFileSync(file, 'utf-8'));
}

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out.sort();
}

const key = (file: string): string => path.relative(SRC_ROOT, file).split(path.sep).join('/');

interface Composer {
  module: string;
  /** Which protocol the file declares alongside the bearer, or null when it declares none. */
  kind: 'member-composer' | 'host-protocol' | 'foreign' | 'undeclared';
}

/** Every header composer the composer module exports, read from its own source. */
function composerNames(): string[] {
  const code = codeOf(path.join(SRC_ROOT, MEMBER_COMPOSER));
  return [...code.matchAll(/export function ([A-Za-z][A-Za-z0-9]*Headers)\s*\(/g)].map((m) => m[1]!);
}

function composers(): Composer[] {
  const out: Composer[] = [];
  for (const file of listTs(SRC_ROOT)) {
    const code = codeOf(file);
    if (!COMPOSES_BEARER.test(code)) continue;
    const module = key(file);
    out.push({
      module,
      kind: module === MEMBER_COMPOSER ? 'member-composer'
        : code.includes(HOST_PROTOCOL_MARKER) ? 'host-protocol'
          : module in FOREIGN ? 'foreign'
            : 'undeclared',
    });
  }
  return out;
}

describe('one composer for a member request\'s headers', () => {
  it('admits no bearer header that declares neither protocol nor a foreign API', () => {
    const found = composers();
    const undeclared = found.filter((c) => c.kind === 'undeclared').map((c) => c.module);
    if (undeclared.length > 0) {
      throw new Error(
        'these modules compose an `authorization: Bearer` header without declaring which protocol it speaks.\n'
        + 'A Deployment refuses a member request carrying no protocol header with 409 on every route, so such a call reaches nothing:\n'
        + `${undeclared.map((m) => `  ${m}`).join('\n')}\n`
        + `Compose member headers through memberHeaders() in ${MEMBER_COMPOSER}, or name the foreign API in FOREIGN.`,
      );
    }
    expect(undeclared).toEqual([]);
  });

  it('finds the member composer, and exactly one of it', () => {
    // An empty or collapsed scan passes the gate above trivially. This holds that
    // the scan still sees the composer it exists to protect, and that the worker
    // and MCP call sites no longer write their own.
    const found = composers();
    expect(found.filter((c) => c.kind === 'member-composer').map((c) => c.module)).toEqual([MEMBER_COMPOSER]);
    for (const module of ['runner/loop.ts', 'runner/mcp-config.ts', 'mcp/deployment-upstream.ts', 'agent/runtime/supervisor.ts', 'member/transport.ts']) {
      expect({ module, composes: found.some((c) => c.module === module) }).toEqual({ module, composes: false });
    }
    expect(found.filter((c) => c.kind === 'host-protocol').length).toBeGreaterThan(0);
  });

  it('every member-side call to a Deployment routes its headers through a composer the composer module exports', () => {
    // The composers are read OUT of the composer module rather than named here:
    // a gate that hard-codes one name is a second copy of it, and passes a call
    // site that stopped using the composers while it still spells that one name.
    const composers = composerNames();
    expect(composers.length).toBeGreaterThan(1);
    for (const module of ['runner/loop.ts', 'runner/mcp-config.ts', 'mcp/deployment-upstream.ts', 'member/transport.ts']) {
      const code = codeOf(path.join(SRC_ROOT, module));
      const used = composers.filter((name) => new RegExp(`\\b${name}\\b`).test(code));
      expect({ module, routed: used.length > 0 }).toEqual({ module, routed: true });
    }
  });

  it('reads code, not comments, and sees both the property and the assignment form', () => {
    expect(COMPOSES_BEARER.test('headers: { authorization: `Bearer ${t}`, a: 1 }')).toBe(true);
    expect(COMPOSES_BEARER.test('headers.authorization = `Bearer ${t}`;')).toBe(true);
    expect(COMPOSES_BEARER.test("headers['Authorization'] = `Bearer ${t}`;")).toBe(true);
    expect(COMPOSES_BEARER.test('const parsed = parseBearer(headers.authorization);')).toBe(false);
    expect(transpiler.transformSync('// authorization: `Bearer x`\nexport const a = 1;')).not.toMatch(COMPOSES_BEARER);
  });

  it('names every foreign API it exempts, so an exemption cannot be an empty entry', () => {
    for (const [module, talksTo] of Object.entries(FOREIGN)) {
      expect({ module, exists: fs.existsSync(path.join(SRC_ROOT, module)), named: talksTo.length > 0 })
        .toEqual({ module, exists: true, named: true });
    }
  });
});
