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

const ALLOWLIST: readonly { file: string; why: string }[] = [
  {
    file: 'packages/myco/src/team-host/overlay.ts',
    why: 'The host installs tailscaled as a root daemon pointed at the vendor state '
      + 'file and vendor socket, and names the vendor macOS label. Coexistence spec '
      + 'C1/C2: adopt the member overlay\'s userspace private-path pattern (own '
      + 'socket, own statedir, own label, --tun=userspace-networking).',
  },
  {
    file: 'packages/myco/src/team-host/system-service.ts',
    why: 'Defaults its daemon label parameter to the vendor com.tailscale.tailscaled. '
      + 'Goes away with the C1 host move to a Myco-owned label.',
  },
];

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

  it('stripComments blanks a commented vendor path so it cannot false-positive', () => {
    const commented = "  // distinct from the root labels (com.tailscale.tailscaled)\n";
    expect(forbiddenMatches(stripComments(commented))).toEqual([]);
  });
});
