/**
 * Meta gate: every daemon router route carries an EXPLICIT Team Host stamp.
 *
 * The host-side overlay backstop (`overlayHostStampRefusal`) and the member-side
 * router (`classifyRoute`) both key on `classifyRouteStamp`, which DEFAULTS any
 * route not in `ROUTE_RULES` to `serve` — proxied to / served over the overlay.
 * That default is correct for the ~80 knowledge-serving routes, but it means a
 * NEW machine-global / maintenance / config route added anywhere silently becomes
 * overlay-exposed unless someone remembers to stamp it. That is exactly the class
 * that produced the provider-secret Critical and the provider/model-connectivity
 * Major.
 *
 * This gate makes the fall-through impossible to introduce silently: it
 * enumerates EVERY route the daemon registers (a static scan of the
 * `.registerRoute(` / `.registerRawRoute(` call sites — the scope-map's own
 * enumeration method, the only two registration paths) and asserts each router
 * route is accounted for in EXACTLY ONE of:
 *   - `ROUTE_RULES`             — an explicit non-serve stamp (localhost-only /
 *                                 degrade / config-lock / config-carve / collect),
 *                                 or an explicit serve rule; OR
 *   - `SERVE_DEFAULT_ROUTES`    — the reviewed manifest of routes that
 *                                 INTENTIONALLY use the serve default.
 * A route in NEITHER fails CI, forcing a deliberate stamp decision. Together the
 * two sets are the machine-enforced mirror of the scope-map's 176/176.
 *
 * Raw routes (`registerRawRoute`) bypass `classifyRouteStamp` entirely (dispatched
 * before `router.match`, gated in `handleOverlayRequest`), so they are not subject
 * to the serve-default hole; the gate still pins their COUNT so a new raw route
 * forces a decision about its overlay behavior.
 *
 * Static source scan (node:fs), no daemon boot — same shape as
 * `tests/meta/no-anchor-as-tenancy.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SERVE_DEFAULT_ROUTES, matchRouteRule } from '@myco/host/routing';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'packages', 'myco', 'src');

// ---------------------------------------------------------------------------
// Raw routes — dispatched before the router, gated in handleOverlayRequest.
// Pinned by COUNT so a NEW raw route trips this gate and forces a decision on
// its overlay behavior. `/api/host/enroll` is registered via the
// HOST_ENROLL_ROUTE constant (counted textually, not parsed as a literal).
// ---------------------------------------------------------------------------
const KNOWN_RAW_ROUTES: ReadonlySet<string> = new Set<string>([
  '/health', // liveness — bearer+version gated over the overlay
  '/api/version', // version probe — bearer+version gated
  '/api/shutdown', // lifecycle — overlayLifecycleRefused (404 over the overlay)
  '/mcp', // bypasses classifyRouteStamp entirely; gated by the dual-homed
          // served-grove filter (servedGroveRefusal, Task 2) at its own
          // chokepoint in mcp/http.ts — the host serves ONLY its one
          // designated served_grove_id over the overlay, never "any Grove
          // this host owns" (see daemon/server.ts's router chokepoint for
          // the mirror check)
  '/api/host/enroll', // bearer-EXEMPT enrollment; overlay-only (constant-registered)
]);

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'target', '.git']);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

/** Blank `//` and block comments (line-count preserving) so prose that mentions
 *  `.registerRoute(` is never counted as a real registration. STRING-AWARE: a
 *  `/*` or `//` sequence INSIDE a string literal (e.g. a wildcard route path like
 *  `'/api/okf/pages/*'`) must NOT be treated as a comment — so this matches string
 *  literals and comments in one pass and blanks only the comments. */
function stripComments(source: string): string {
  // Alternation order matters: a string literal is matched (and kept) before a
  // comment sequence it may contain can start a false match.
  const re = /(['"`])(?:\\.|(?!\1)[^\\])*\1|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
  return source.replace(re, (match) =>
    match[0] === '/' ? match.replace(/[^\n]/g, ' ') : match,
  );
}

/** `.registerRoute('METHOD', '/pattern'` — method + path literals (always on the
 *  opening line of the call). The leading `.` excludes the method DEFINITION in
 *  server.ts / the RouteRegistrar interface (no dot prefix). */
const REGISTER_ROUTE_RE = /\.registerRoute\(\s*(['"])([A-Z]+)\1\s*,\s*(['"])([^'"]+)\3/g;
/** Textual `.registerRoute(` occurrences — used to assert we parsed them ALL (a
 *  non-literal/reformatted registration the regex misses fails the gate loudly). */
const REGISTER_ROUTE_CALL_RE = /\.registerRoute\(/g;
/** `.registerRawRoute(` occurrences (literal or constant path). */
const REGISTER_RAW_CALL_RE = /\.registerRawRoute\(/g;
/** `.registerRawRoute('/literal'` — the literal-path raw routes only. */
const REGISTER_RAW_LITERAL_RE = /\.registerRawRoute\(\s*(['"])([^'"]+)\1/g;

interface RegisteredRoute {
  method: string;
  pattern: string;
  file: string;
}

interface ScanResult {
  routes: RegisteredRoute[];
  routerCallCount: number;
  rawCallCount: number;
  rawLiteralPaths: string[];
}

function scanRegistrations(): ScanResult {
  const routes: RegisteredRoute[] = [];
  let routerCallCount = 0;
  let rawCallCount = 0;
  const rawLiteralPaths: string[] = [];

  for (const abs of listSourceFiles(SRC_ROOT)) {
    const rel = path.relative(REPO_ROOT, abs).split(path.sep).join('/');
    const code = stripComments(fs.readFileSync(abs, 'utf8'));

    routerCallCount += (code.match(REGISTER_ROUTE_CALL_RE) ?? []).length;
    rawCallCount += (code.match(REGISTER_RAW_CALL_RE) ?? []).length;

    for (const m of code.matchAll(REGISTER_ROUTE_RE)) {
      routes.push({ method: m[2], pattern: m[4], file: rel });
    }
    for (const m of code.matchAll(REGISTER_RAW_LITERAL_RE)) {
      rawLiteralPaths.push(m[2]);
    }
  }
  return { routes, routerCallCount, rawCallCount, rawLiteralPaths };
}

/** A concrete pathname sampled from a registered pattern, so `matchRouteRule`
 *  (which matches concrete paths) classifies `:param` / `/*` routes exactly as
 *  the runtime router does. */
function samplePath(pattern: string): string {
  const withoutWild = pattern.endsWith('/*') ? `${pattern.slice(0, -1)}_wild` : pattern;
  return withoutWild
    .split('/')
    .map((seg) => (seg.startsWith(':') ? `_${seg.slice(1)}` : seg))
    .join('/');
}

/** The registration key used in `SERVE_DEFAULT_ROUTES`. */
function routeKey(method: string, pattern: string): string {
  return `${method} ${pattern}`;
}

/** True when a registered route resolves to an explicit `ROUTE_RULES` entry. */
function hasExplicitRule(route: RegisteredRoute): boolean {
  return matchRouteRule(route.method, samplePath(route.pattern)) !== undefined;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

describe('route-stamp completeness gate', () => {
  const scan = scanRegistrations();

  it('scans a live, non-trivial set of registered routes (the scan is wired, not empty)', () => {
    expect(scan.routerCallCount).toBeGreaterThan(100);
    expect(scan.routes.length).toBeGreaterThan(100);
  });

  it('parses EVERY `.registerRoute(` call (a non-literal/reformatted registration must fail loudly, not be skipped)', () => {
    // If a registration is added with a non-literal method/path (or a shape the
    // regex misses), parsed < textual — surface it so the gate is re-pointed
    // rather than silently under-counting and passing a route through unchecked.
    expect(scan.routes.length, `parsed ${scan.routes.length} registerRoute literals but found `
      + `${scan.routerCallCount} .registerRoute( call sites — a registration uses a non-literal `
      + 'method/path the scan cannot classify. Make it a literal, or extend the scanner.')
      .toBe(scan.routerCallCount);
  });

  it('EVERY registered router route has an explicit stamp or is in the serve-default manifest (no silent serve fall-through)', () => {
    const unaccounted = scan.routes
      .filter((r) => !hasExplicitRule(r) && !SERVE_DEFAULT_ROUTES.has(routeKey(r.method, r.pattern)))
      // de-dup (prefix routes can register the same key from one site)
      .filter((r, i, arr) => arr.findIndex((x) => x.method === r.method && x.pattern === r.pattern) === i);

    const detail = unaccounted
      .map((r) => `  '${routeKey(r.method, r.pattern)}', // ${r.file}`)
      .join('\n');

    expect(unaccounted.length, `${unaccounted.length} registered route(s) fall through to the `
      + '`serve` default with no explicit decision — they would be proxied/served over the '
      + 'Team Host overlay. Add each to host/routing.ts: a non-serve stamp in ROUTE_RULES '
      + '(machine/localhost/maintenance/config), or to SERVE_DEFAULT_ROUTES if it is a genuine '
      + `knowledge-serving route:\n${detail}\n`).toBe(0);
  });

  it('SERVE_DEFAULT_ROUTES holds no stale or redundant entries (every entry is a real serve-default route)', () => {
    const registered = new Map(scan.routes.map((r) => [routeKey(r.method, r.pattern), r]));
    const stale: string[] = [];
    for (const key of SERVE_DEFAULT_ROUTES) {
      const route = registered.get(key);
      if (!route) {
        stale.push(`${key} — not a registered route (removed/renamed?)`);
        continue;
      }
      if (hasExplicitRule(route)) {
        stale.push(`${key} — now covered by a ROUTE_RULES stamp; drop from the serve manifest`);
      }
    }
    expect(stale.length, `SERVE_DEFAULT_ROUTES has stale/redundant entries:\n  ${stale.join('\n  ')}\n`)
      .toBe(0);
  });

  it('raw-route count is pinned (a NEW raw route must force an overlay-behavior decision)', () => {
    // Count alone only catches a net change in call-site cardinality — e.g. a
    // literal accidentally registered twice while another is removed leaves the
    // count unchanged. The literal-SET assertion below is what catches an entry
    // silently swapped for another; this check stays as the narrower guard
    // against a duplicate registration masking that swap.
    expect(scan.rawCallCount, `found ${scan.rawCallCount} .registerRawRoute( call sites but expected `
      + `${KNOWN_RAW_ROUTES.size} (${[...KNOWN_RAW_ROUTES].join(', ')}). A new raw route bypasses the `
      + 'stamp table and is gated only in handleOverlayRequest — add it to KNOWN_RAW_ROUTES here and '
      + 'confirm its overlay behavior (bearer/version gate, lifecycle-refuse, or intentional serve).')
      .toBe(KNOWN_RAW_ROUTES.size);
    for (const p of scan.rawLiteralPaths) {
      expect(KNOWN_RAW_ROUTES.has(p), `unexpected raw route '${p}' — confirm its overlay behavior and add it`).toBe(true);
    }
  });

  it('the raw-route literal set matches KNOWN_RAW_ROUTES exactly — no stale entry hides a removed/renamed route', () => {
    // The count + per-literal membership check above only asserts ADDED raw
    // routes are accounted for; a raw route silently REMOVED (or renamed) while
    // something else takes its call-site slot leaves the count unchanged and
    // every remaining literal still passes membership, so KNOWN_RAW_ROUTES would
    // keep a stale entry indefinitely. Assert the full set both ways, mirroring
    // the SERVE_DEFAULT_ROUTES staleness check above.
    //
    // '/api/host/enroll' is registered via the HOST_ENROLL_ROUTE constant, so
    // REGISTER_RAW_LITERAL_RE never captures it (see the scanner note above) —
    // exclude it from the literal-set comparison; the call-site COUNT check
    // above still accounts for it.
    const CONSTANT_REGISTERED_RAW_ROUTES: ReadonlySet<string> = new Set(['/api/host/enroll']);
    const expectedLiterals = new Set([...KNOWN_RAW_ROUTES].filter((p) => !CONSTANT_REGISTERED_RAW_ROUTES.has(p)));
    const actualLiterals = new Set(scan.rawLiteralPaths);

    const missing = [...expectedLiterals].filter((p) => !actualLiterals.has(p));
    const unexpected = [...actualLiterals].filter((p) => !expectedLiterals.has(p));

    expect(missing, `KNOWN_RAW_ROUTES lists ${missing.join(', ')} but no matching .registerRawRoute( literal `
      + 'was found in source — the route was removed/renamed without updating this gate (a stale entry '
      + 'would otherwise hide a raw route silently disappearing).').toEqual([]);
    expect(unexpected, `found raw route literal(s) ${unexpected.join(', ')} not in KNOWN_RAW_ROUTES — confirm `
      + 'their overlay behavior and add them.').toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Self-test: prove the scanner + matchers actually work, so a broken regex or
// wrong path can never pass the gate vacuously.
// ---------------------------------------------------------------------------

describe('route-stamp completeness matcher self-test', () => {
  it('REGISTER_ROUTE_RE extracts method + path and ignores the method DEFINITION (no leading dot)', () => {
    const call = "server.registerRoute('GET', '/api/x', async () => ({ body: {} }));";
    const def = 'registerRoute(method: string, routePath: string, handler: RouteHandler): void {';
    const calls = [...call.matchAll(REGISTER_ROUTE_RE)];
    expect(calls.length).toBe(1);
    expect(calls[0][2]).toBe('GET');
    expect(calls[0][4]).toBe('/api/x');
    expect([...def.matchAll(REGISTER_ROUTE_RE)].length).toBe(0);
  });

  it('samplePath concretizes :param and trailing /* so matchRouteRule classifies them like the router', () => {
    expect(samplePath('/api/providers/secrets/:provider')).toBe('/api/providers/secrets/_provider');
    expect(samplePath('/api/canopy/entries/*')).toBe('/api/canopy/entries/_wild');
    // The concretized secret route resolves to its localhost-only rule (the Critical route).
    expect(matchRouteRule('PUT', samplePath('/api/providers/secrets/:provider'))?.stamp).toBe('localhost-only');
    // A concretized canopy prefix route resolves to the degrade prefix rule.
    expect(matchRouteRule('GET', samplePath('/api/canopy/entries/*'))?.stamp).toBe('degrade');
  });

  it('the provider/model + db/embedding routes this task stamped resolve to non-serve rules', () => {
    expect(matchRouteRule('GET', '/api/providers')?.stamp).toBe('localhost-only');
    expect(matchRouteRule('POST', '/api/providers/test')?.stamp).toBe('localhost-only');
    expect(matchRouteRule('GET', '/api/models')?.stamp).toBe('localhost-only');
    expect(matchRouteRule('POST', '/api/embedding/rebuild')?.stamp).toBe('degrade');
    expect(matchRouteRule('POST', '/api/database/vacuum')?.stamp).toBe('degrade');
    // The READ siblings stay serve (unstamped) — they belong in the serve manifest.
    expect(matchRouteRule('GET', '/api/embedding/status')).toBeUndefined();
    expect(matchRouteRule('GET', '/api/database/details')).toBeUndefined();
  });

  it('team-write routes (Task 8) resolve to the explicit team-write stamp, never the serve default', () => {
    expect(matchRouteRule('GET', '/api/team/config')?.stamp).toBe('team-write');
    expect(matchRouteRule('PUT', '/api/team/config')?.stamp).toBe('team-write');
    expect(matchRouteRule('PUT', samplePath('/api/team/secrets/:provider'))?.stamp).toBe('team-write');
    expect(matchRouteRule('DELETE', samplePath('/api/team/secrets/:provider'))?.stamp).toBe('team-write');
    expect(matchRouteRule('POST', '/api/team/mcp-token/rotate')?.stamp).toBe('team-write');
    // The coarse legacy team-sync prefix rules are unaffected — still localhost-only.
    expect(matchRouteRule('GET', '/api/team/status')?.stamp).toBe('localhost-only');
    expect(matchRouteRule('POST', '/api/team/join')?.stamp).toBe('localhost-only');
  });

  it('stripComments blanks a `.registerRoute(` that only appears in a comment', () => {
    const commented = '// server.registerRoute(\'GET\', \'/api/ghost\', h) in a comment must not count\n';
    expect([...stripComments(commented).matchAll(REGISTER_ROUTE_RE)].length).toBe(0);
  });
});
