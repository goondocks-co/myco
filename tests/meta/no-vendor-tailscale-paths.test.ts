/**
 * Meta gate X4: no code path pins a vendor Tailscale path or service label.
 *
 * The coexistence invariant (Overlay Coexistence spec): a machine with a
 * vendor Tailscale install — retail client, distro package, MDM push — must
 * run Myco's overlay with neither side observing the other. Myco therefore
 * must never reference the resources a vendor install owns:
 *
 *   - the vendor state directory  `/var/lib/tailscale`  (tailscaled.state)
 *   - the vendor socket directory `/var/run/tailscale`  (tailscaled.sock)
 *   - the vendor service labels   `com.tailscale.*` (macOS launchd),
 *                                 `tailscaled.service` (systemd)
 *
 * A Myco daemon pointed at a vendor path means two supervisors fighting over
 * one state file and one socket, and a Myco teardown that can uninstall the
 * user's own Tailscale. The member overlay already runs userspace with
 * per-host private paths and touches none of these; the host must adopt the
 * same pattern (coexistence spec C1/C2).
 *
 * The allowlist below is a RATCHET — the host-side files that still pin
 * vendor resources today. It can only shrink. When the host overlay moves to
 * private paths, its entry goes stale (the stays-honest check fails) and must
 * be removed, re-tightening the gate. Adding a NEW entry is a deliberate,
 * reviewed act; the correct fix for a new violation is a Myco-owned path or
 * label, never a vendor one.
 *
 * This is a static source scan (read files with node:fs; no daemon boot).
 * Line-based on comment-stripped source, so prose mentioning a vendor path
 * (like this header) is not mistaken for code.
 */

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'packages', 'myco', 'src');

// ---------------------------------------------------------------------------
// Forbidden patterns — vendor-owned Tailscale resources appearing in code.
// ---------------------------------------------------------------------------

const FORBIDDEN_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'vendor-state-dir', pattern: /\/var\/lib\/tailscale/ },
  { name: 'vendor-socket-dir', pattern: /\/var\/run\/tailscale/ },
  { name: 'vendor-macos-label', pattern: /com\.tailscale\./ },
  { name: 'vendor-systemd-unit', pattern: /\btailscaled\.service\b/ },
];

/** Names of every forbidden pattern matching a single line. */
function forbiddenMatches(line: string): string[] {
  return FORBIDDEN_PATTERNS.filter((p) => p.pattern.test(line)).map((p) => p.name);
}

// ---------------------------------------------------------------------------
// Allowlist — RATCHET, shrink-only. The host overlay's known vendor pins.
// ---------------------------------------------------------------------------

// EMPTY, and it must stay that way. Both former entries — the host's root
// tailscaled on vendor paths (`team-host/overlay.ts`) and the vendor macOS
// label default (`team-host/system-service.ts`) — came off when C1/C2 moved
// the host onto the member's unprivileged userspace private-path pattern.
// Emptying this list IS the mechanical completion signal for C1/C2.
const ALLOWLIST: readonly { file: string; why: string }[] = [];

// ---------------------------------------------------------------------------
// Unsocketed-invocation rule (coexistence spec §7.1)
//
// A `tailscale` invocation with no `--socket` reaches whatever daemon is
// ambient — on a machine with vendor Tailscale installed, the VENDOR daemon.
// That is how `host enable` came to read the vendor tailnet's address, skip
// the join entirely, and persist a vendor address as its own overlay address.
//
// The forbidden-path regexes above structurally CANNOT see this class: they
// match vendor paths and labels, and the matcher self-test below deliberately
// asserts a bare `tailscale` binary name is NOT flagged. So the rule is its
// own scan: every tailscale invocation goes through `host/tailscale-cli.ts`,
// which cannot be constructed without a socket.
// ---------------------------------------------------------------------------

/**
 * Matches a SPAWN whose command is the tailscale CLI — either the bare name
 * (`execFileAsync('tailscale', …)`) or a resolved-binary identifier
 * (`runner.run(bins.tailscaleBin, …)`). The identifier form is the one that
 * matters: the real `host enable` defect spawned `bins.tailscaleBin` with no
 * `--socket`, so a matcher keyed only on the string literal would have passed
 * against the broken code — testing something other than the property.
 * `tailscaled` (the daemon, supervised via a ServiceSpec) is deliberately not
 * matched: the `Bin\b` boundary excludes `tailscaledBin`.
 *
 * Matched against a WHITESPACE-COLLAPSED window, not a single line. The real
 * `tailscale up` defect was written across lines —
 * `runner.run('sudo', [\n  bins.tailscaleBin, 'up',` — so a per-line scan saw
 * neither `run(` next to the binary nor the binary next to `run(`, and missed
 * one of the two defects this rule cites.
 */
const TAILSCALE_INVOCATION =
  /\b(?:run|runCommand|execFile|execFileAsync|spawn|spawnSync)\s*\([^)]{0,200}?(?:['"`]tailscale['"`]|[\w$.]*[Tt]ailscaleBin\b)/;

/**
 * Spawning HELPERS that take a binary path as a parameter, so the spawn itself
 * is `run(bin, …)` and invisible to {@link TAILSCALE_INVOCATION}. Matched at the
 * CALL SITE instead, where the tailscale binary is named.
 *
 * KNOWN LIMIT, stated rather than implied: this gate cannot statically prove
 * "no unsocketed invocation" through arbitrary indirection — it catches direct
 * spawns and the helpers named here. A new spawning helper must be added to
 * this list. That is a real gap, and the durable fix is content-addressed
 * provisioning (removing the only helper that needs it); until then the gap is
 * bounded by this list rather than unbounded.
 */
const TAILSCALE_VIA_HELPER = /\bprobeVersion\s*\([^)]*[Tt]ailscaleBin\b/;

const INVOCATION_ALLOWLIST: readonly { file: string; why: string }[] = [
  {
    file: 'packages/myco/src/host/overlay-binaries.ts',
    why: 'probeVersion() spawns `<bin> version` on a freshly-provisioned binary. It is '
      + 'UNSOCKETED by necessity — at provisioning time no Myco tailscaled is running, so '
      + 'there is no socket to point at (a genuine chicken-and-egg). Benign ONLY because '
      + '`version` reads no daemon state; it is the one tailscale subcommand that is '
      + 'socket-independent. Do NOT widen this entry to any subcommand that queries or '
      + 'mutates daemon state — those reach the ambient (possibly vendor) daemon. The '
      + 'durable fix is content-addressed provisioning, which removes the probe entirely.',
  },
  {
    file: 'packages/myco/src/daemon/external-listener.ts',
    why: 'The external-MCP Funnel containment runner. DELIBERATE and NOT a defect: '
      + 'Tailscale Funnel is a Tailscale-cloud feature headscale does not implement '
      + '(it serves no cert endpoint — the same reason HTTPS `serve` 501s against it), '
      + 'so external MCP inherently rides the operator\'s OWN vendor tailnet. Pointing '
      + 'this at a Myco socket would break the feature outright. Reached only when '
      + 'external MCP is actually configured (the `requiresContainment` guard in '
      + 'daemon/external-mcp-containment.ts), never on a clean machine.',
  },
];

const INVOCATION_ALLOWLISTED_FILES = new Set(INVOCATION_ALLOWLIST.map((e) => e.file));

/** The module that owns socketed invocation — exempt by definition. */
const TAILSCALE_CLI_MODULE = 'packages/myco/src/host/tailscale-cli.ts';

const ALLOWLISTED_FILES = new Set(ALLOWLIST.map((entry) => entry.file));

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

/**
 * Strip `//` line comments and block comments so prose that mentions a vendor
 * path is not mistaken for code. Block comments are blanked line-by-line to
 * preserve line numbers for diagnostics.
 */
function stripComments(source: string): string {
  const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, ' '),
  );
  return noBlock
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('//');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

function relPosix(absPath: string): string {
  return path.relative(REPO_ROOT, absPath).split(path.sep).join('/');
}

interface Violation {
  file: string;
  line: number;
  kind: string;
  text: string;
}

/** Collapse a line and its successors into one window so a spawn split across
 *  lines is still seen as one call. */
function invocationWindow(lines: string[], index: number): string {
  return lines.slice(index, index + 4).join(' ').replace(/\s+/g, ' ');
}

function scanSource(): Violation[] {
  const violations: Violation[] = [];
  for (const absPath of listSourceFiles(SRC_ROOT)) {
    const rel = relPosix(absPath);
    const code = stripComments(fs.readFileSync(absPath, 'utf8'));
    code.split('\n').forEach((line, i) => {
      for (const kind of forbiddenMatches(line)) {
        violations.push({ file: rel, line: i + 1, kind, text: line.trim() });
      }
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

describe('no-vendor-tailscale-paths meta gate (X4)', () => {
  it('scans a non-trivial number of source files (scan is wired, not silently empty)', () => {
    const files = listSourceFiles(SRC_ROOT);
    expect(files.length).toBeGreaterThan(100);
  });

  it('finds no vendor Tailscale path or label outside the allowlist', () => {
    const violations = scanSource().filter((v) => !ALLOWLISTED_FILES.has(v.file));
    const detail = violations
      .map((v) => `  [${v.kind}] ${v.file}:${v.line}  ${v.text}`)
      .join('\n');
    expect(violations.length, `vendor Tailscale resource referenced in code:\n${detail}\n\n`
      + 'Myco must never touch a vendor install\'s state dir, socket dir, or service '
      + 'label — coexistence with an installed vendor Tailscale is a product '
      + 'invariant. Use a Myco-owned path under the host/member\'s own directory and '
      + 'a Myco-owned service label (see host/member-overlay.ts for the compliant '
      + 'pattern). Do NOT add the file to ALLOWLIST unless this is a genuinely '
      + 'reviewed, deliberate exception.').toBe(0);
  });

  it('every allowlisted file still exists and STILL references a vendor resource', () => {
    // Keeps the ratchet honest: once the host overlay moves to private paths its
    // entry no longer violates and must be removed — which re-tightens the gate.
    for (const entry of ALLOWLIST) {
      const abs = path.join(REPO_ROOT, entry.file);
      expect(fs.existsSync(abs), `allowlisted file is missing: ${entry.file}`).toBe(true);
      const code = stripComments(fs.readFileSync(abs, 'utf8'));
      const stillViolates = code
        .split('\n')
        .some((line) => forbiddenMatches(line).length > 0);
      expect(stillViolates, `stale allowlist entry — ${entry.file} no longer references `
        + 'a vendor Tailscale resource; remove it from ALLOWLIST so the gate re-tightens').toBe(true);
    }
  });

  it('no source file spawns the tailscale CLI outside host/tailscale-cli.ts', () => {
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const absPath of listSourceFiles(SRC_ROOT)) {
      const rel = relPosix(absPath);
      if (rel === TAILSCALE_CLI_MODULE || INVOCATION_ALLOWLISTED_FILES.has(rel)) continue;
      const code = stripComments(fs.readFileSync(absPath, 'utf8'));
      const lines = code.split('\n');
      lines.forEach((line, i) => {
        const window = invocationWindow(lines, i);
        if (TAILSCALE_INVOCATION.test(window) || TAILSCALE_VIA_HELPER.test(window)) {
          offenders.push({ file: rel, line: i + 1, text: line.trim() });
        }
      });
    }
    const detail = offenders.map((o) => `  ${o.file}:${o.line}  ${o.text}`).join('\n');
    expect(offenders.length, `tailscale CLI spawned outside the socketed chokepoint:\n${detail}\n\n`
      + 'An unsocketed `tailscale` call reaches the AMBIENT daemon — the vendor one on a '
      + 'coexistence box. Route it through `createTailscaleCli({runner, tailscaleBin, socketPath})` '
      + '(packages/myco/src/host/tailscale-cli.ts), which cannot be built without a socket. '
      + 'Do NOT add an INVOCATION_ALLOWLIST entry unless the call MUST target the operator\'s '
      + 'own vendor tailnet (today: only external-MCP Funnel, which headscale cannot serve).').toBe(0);
  });

  it('every invocation-allowlisted file still spawns tailscale (ratchet stays honest)', () => {
    for (const entry of INVOCATION_ALLOWLIST) {
      const abs = path.join(REPO_ROOT, entry.file);
      expect(fs.existsSync(abs), `invocation-allowlisted file is missing: ${entry.file}`).toBe(true);
      const code = stripComments(fs.readFileSync(abs, 'utf8'));
      const codeLines = code.split('\n');
      const stillInvokes = codeLines.some((_l, i) => {
        const window = invocationWindow(codeLines, i);
        return TAILSCALE_INVOCATION.test(window) || TAILSCALE_VIA_HELPER.test(window);
      });
      expect(stillInvokes, `stale invocation-allowlist entry — ${entry.file} no longer spawns the `
        + 'tailscale CLI; remove it from INVOCATION_ALLOWLIST so the gate re-tightens').toBe(true);
    }
  });

  it('the member overlay is NOT allowlisted (it is the compliant reference pattern)', () => {
    expect(ALLOWLISTED_FILES.has('packages/myco/src/host/member-overlay.ts')).toBe(false);
    const violations = scanSource().filter(
      (v) => v.file === 'packages/myco/src/host/member-overlay.ts',
    );
    const detail = violations.map((v) => `  [${v.kind}] ${v.file}:${v.line}  ${v.text}`).join('\n');
    expect(violations.length, `member-overlay.ts references a vendor Tailscale resource — `
      + `it is the userspace private-path reference implementation and must stay clean:\n${detail}`).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Self-test: prove the matchers catch the vendor references and ignore
// Myco-owned paths. Without this, a broken regex would pass vacuously.
// ---------------------------------------------------------------------------

describe('no-vendor-tailscale-paths matcher self-test', () => {
  it('flags the vendor state dir', () => {
    expect(forbiddenMatches("args: ['--state', '/var/lib/tailscale/tailscaled.state'],"))
      .toContain('vendor-state-dir');
  });

  it('flags the vendor socket dir', () => {
    expect(forbiddenMatches("'--socket', '/var/run/tailscale/tailscaled.sock'"))
      .toContain('vendor-socket-dir');
  });

  it('flags the vendor macOS label', () => {
    expect(forbiddenMatches("const LABEL = 'com.tailscale.tailscaled';"))
      .toContain('vendor-macos-label');
    expect(forbiddenMatches("label = 'com.tailscale.tailscaled',"))
      .toContain('vendor-macos-label');
  });

  it('flags the vendor systemd unit', () => {
    expect(forbiddenMatches("execSync('systemctl status tailscaled.service');"))
      .toContain('vendor-systemd-unit');
  });

  it('does NOT flag Myco-owned overlay paths or labels', () => {
    expect(forbiddenMatches("path.join(hostDir, 'tailscaled.state')")).toEqual([]);
    expect(forbiddenMatches("const label = 'com.myco.overlay.tailscaled';")).toEqual([]);
    expect(forbiddenMatches("'--socket', shortSocketPath(hostId)")).toEqual([]);
    expect(forbiddenMatches("'--tun=userspace-networking'")).toEqual([]);
  });

  it('does NOT flag the tailscaled binary name itself', () => {
    expect(forbiddenMatches("spawn(tailscaledBinary, ['--verbose=1'])")).toEqual([]);
    expect(forbiddenMatches("const proc = 'tailscaled';")).toEqual([]);
  });

  it('flags a bare-name tailscale CLI spawn', () => {
    expect(TAILSCALE_INVOCATION.test("await execFileAsync('tailscale', args, {")).toBe(true);
    expect(TAILSCALE_INVOCATION.test('spawn("tailscale", ["status"])')).toBe(true);
  });

  it('flags a MULTI-LINE spawn — the shape of the real `tailscale up` defect', () => {
    // Written across lines in the original, so a per-line scan missed it
    // entirely even though this rule's own header cites it as a motivating
    // defect. Scanned as a collapsed window instead.
    const lines = ["    const up = await runner.run('sudo', [", "      bins.tailscaleBin, 'up',", "      '--login-server', url,", '    ]);'];
    expect(TAILSCALE_INVOCATION.test(lines.join(' ').replace(/\s+/g, ' '))).toBe(true);
    // And each line ALONE is invisible — which is exactly why the window exists.
    expect(lines.every((l) => !TAILSCALE_INVOCATION.test(l))).toBe(true);
  });

  it('flags a RESOLVED-BINARY spawn — the shape of the real host-enable defect', () => {
    // This is the case a literal-only matcher misses. `host enable` shipped
    // exactly these two lines with no --socket, reading the VENDOR tailnet.
    expect(TAILSCALE_INVOCATION.test("const res = await runner.run(tailscaleBin, ['ip', '-4']);")).toBe(true);
    expect(TAILSCALE_INVOCATION.test('await runner.run(bins.tailscaleBin, [')).toBe(true);
    expect(TAILSCALE_INVOCATION.test('runner.run(tailscale.tailscaleBin, [')).toBe(true);
  });

  it('flags a tailscale binary passed into a spawning HELPER (probeVersion)', () => {
    // The direct-spawn matcher cannot see this: probeVersion spawns
    // `run(bin, args)`, so the binary is only named at the call site.
    expect(TAILSCALE_VIA_HELPER.test("await probeVersion(opts.runner, located.tailscaleBin, ['version'], PIN);")).toBe(true);
    expect(TAILSCALE_VIA_HELPER.test('probeVersion(runner, bins.tailscaledBin, [])')).toBe(false);
  });

  it('does NOT flag tailscaled supervision or non-spawn plumbing', () => {
    // `tailscaled` is the DAEMON, supervised via a ServiceSpec, not the CLI.
    expect(TAILSCALE_INVOCATION.test("spawn('tailscaled', ['--tun=userspace-networking'])")).toBe(false);
    expect(TAILSCALE_INVOCATION.test('await runner.run(bins.tailscaledBin, [')).toBe(false);
    // Passing the binary as DATA into the chokepoint is the sanctioned shape.
    expect(TAILSCALE_INVOCATION.test('createTailscaleCli({ runner, tailscaleBin, socketPath })')).toBe(false);
    expect(TAILSCALE_INVOCATION.test('const memberIp = await resolveIp(runner, tailscale.tailscaleBin, socketPath);')).toBe(false);
  });

  it('stripComments blanks a commented vendor path so it cannot false-positive', () => {
    const commented = "  // distinct from the root labels (com.tailscale.tailscaled)\n";
    expect(forbiddenMatches(stripComments(commented))).toEqual([]);
  });
});
