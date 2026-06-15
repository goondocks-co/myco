/**
 * Symbiont installer invariants — pure, fast, no I/O.
 *
 * Each assertion here is a structural property of the manifests and shipped
 * templates that, if violated, produces a real data-capture bug. The four
 * dogfood-surfaced bugs from the global-install rollout (OpenCode plugin.ts
 * clobber, Codex hybrid JSON+TOML detection, Antigravity marker-less plugin
 * file, …) all map to one of the invariants below.
 *
 * This suite intentionally runs the *real* `resolveAbsoluteTarget` logic via
 * the installer constructor — it's the source of truth for the path math,
 * and duplicating the rules in tests would just drift. The resolver is
 * `private` so we exercise it through a thin reflective accessor; the
 * stability boundary is the manifest schema, not the resolver method
 * signature, so this is the right shape of coupling.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SymbiontInstaller, type InstallScope } from '@myco/symbionts/installer.js';
import { loadManifests } from '@myco/symbionts/detect.js';
import type { SymbiontManifest } from '@myco/symbionts/manifest-schema.js';

const PKG_ROOT = path.resolve(__dirname, '..', '..', 'packages', 'myco');
const TEMPLATES_DIR = path.join(PKG_ROOT, 'src', 'symbionts', 'templates');

/**
 * The marker `isConfigured` looks for on plugin-file targets. Source: the
 * `MYCO_PLUGIN_FILE_MARKER` constant in `installer.ts`. Mirrored here as a
 * literal so the invariant catches drift if either side changes without the
 * other.
 */
const PLUGIN_FILE_MARKER = 'myco:plugin-marker';

/**
 * Stable fake project root used purely to drive the resolver under
 * `project` scope. The actual path is irrelevant — we only inspect what
 * the resolver returns, never touch the filesystem.
 */
const FAKE_PROJECT_ROOT = '/tmp/myco-invariant-fake-project';

/** Stable fake HOME so `~/...` paths in manifests resolve deterministically. */
let stableHomeDir: string;
let prevHome: string | undefined;

beforeAll(() => {
  stableHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-installer-invariants-'));
  prevHome = process.env.HOME;
  process.env.HOME = stableHomeDir;
});
afterAll(() => {
  fs.rmSync(stableHomeDir, { recursive: true, force: true });
  if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
});

type TargetField = 'hooks' | 'mcp' | 'skills' | 'settings';
const TARGET_FIELDS: readonly TargetField[] = ['hooks', 'mcp', 'skills', 'settings'];
const SCOPES: readonly InstallScope[] = ['project', 'global'];

interface ResolvedTargets {
  hooks: string | null;
  mcp: string | null;
  skills: string | null;
  settings: string | null;
}

/**
 * Walk a parsed hooks.json template and yield every string value of a
 * `command` field. Handles both Claude Code's nested format
 * (`{hooks: [{command, ...}]}`) and Cursor/Windsurf's flat format
 * (`{command, ...}`).
 */
function collectHookCommands(value: unknown, acc: string[] = []): string[] {
  if (value == null) return acc;
  if (Array.isArray(value)) {
    for (const item of value) collectHookCommands(item, acc);
    return acc;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'command' && typeof v === 'string') acc.push(v);
      else collectHookCommands(v, acc);
    }
  }
  return acc;
}

function resolveAllTargets(manifest: SymbiontManifest, scope: InstallScope): ResolvedTargets {
  const installer = new SymbiontInstaller(
    manifest,
    FAKE_PROJECT_ROOT,
    PKG_ROOT,
    false,
    undefined,
    null,
    scope,
  );
  // `resolveAbsoluteTarget` is private in the public API but is the source
  // of truth for the path math we're asserting against. Reflective access
  // is the standard testing pattern for invariants on private methods.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const resolver = (installer as any).resolveAbsoluteTarget.bind(installer) as (f: TargetField) => string | null;
  return {
    hooks: resolver('hooks'),
    mcp: resolver('mcp'),
    skills: resolver('skills'),
    settings: resolver('settings'),
  };
}

const manifests = loadManifests();

describe('symbiont installer invariants', () => {
  it('every manifest under test is loaded', () => {
    // Sanity gate — if this fails the rest of the suite is meaningless.
    const names = manifests.map((m) => m.name).sort();
    expect(names.length).toBeGreaterThanOrEqual(8);
    expect(names).toContain('claude-code');
    expect(names).toContain('codex');
    expect(names).toContain('opencode');
    expect(names).toContain('antigravity');
  });

  /**
   * No-collision invariant.
   *
   * Catches the OpenCode `plugin.ts` clobber: settings target equalled hooks
   * target, and the settings template overwrote the plugin source on install.
   *
   * Rule: when `hooksFormat === 'plugin-file'`, the hooks target is a
   * Myco-owned raw file (TS plugin, hooks.json bundle) — *no other field
   * may share its path*, because the other writers would clobber it with
   * a JSON merge.
   *
   * For `hooksFormat === 'json'`, hooks/mcp/settings may legitimately share
   * a path (Claude Code packs all three into `~/.claude/settings.json` and
   * the merge layer handles it). Skills is always a distinct directory.
   */
  describe('no-collision', () => {
    for (const manifest of manifests) {
      for (const scope of SCOPES) {
        it(`${manifest.name} (${scope}): plugin-file hooks path is unique among fields`, () => {
          const reg = manifest.registration;
          if (!reg) return; // No registration → nothing to install → no collision possible.
          const targets = resolveAllTargets(manifest, scope);
          if (reg.hooksFormat !== 'plugin-file') return; // Rule only applies to plugin-file.
          if (!targets.hooks) return;
          for (const field of TARGET_FIELDS) {
            if (field === 'hooks') continue;
            if (targets[field] === targets.hooks) {
              throw new Error(
                `${manifest.name} (${scope}): plugin-file hooks target ${targets.hooks} ` +
                `collides with ${field} target. A JSON-merge writer would clobber the plugin source.`,
              );
            }
          }
        });
      }
    }
  });

  /**
   * Format/path consistency invariant.
   *
   * The flip side of the OpenCode bug. Catches a regression that re-introduces
   * a settings-target for plugin-file symbionts (which would point the
   * settings writer at the plugin source again).
   */
  describe('format/path consistency', () => {
    for (const manifest of manifests) {
      it(`${manifest.name}: plugin-file hooksFormat ⇒ no global settings target`, () => {
        const reg = manifest.registration;
        if (!reg) return;
        if (reg.hooksFormat !== 'plugin-file') return;
        const targets = resolveAllTargets(manifest, 'global');
        expect(targets.settings).toBeNull();
      });

      it(`${manifest.name}: json hooksFormat ⇒ global hooks target is JSON-shaped`, () => {
        const reg = manifest.registration;
        if (!reg) return;
        if ((reg.hooksFormat ?? 'json') !== 'json') return;
        const targets = resolveAllTargets(manifest, 'global');
        if (!targets.hooks) return; // Manifest may decline a global hooks surface.
        // Global hooks for json-format symbionts must NOT point at a TOML
        // file — the JSON writer would corrupt it (this is the Codex bug
        // class from the other angle; Codex's hooks target is now a
        // dedicated `.json` file even though its settings/MCP are TOML).
        expect(targets.hooks.endsWith('.toml')).toBe(false);
      });

      it(`${manifest.name}: TOML settings can't share a JSON hooks file`, () => {
        // Regression: codex used to write `[features] hooks = true` as
        // TOML into ~/.codex/hooks.json (JSON), producing a hybrid file
        // that broke uninstall AND silently invalidated codex's trust
        // hash on every bootstrap pass. The manifest fix is an explicit
        // `globalSettingsTarget` pointing at the TOML file; this
        // invariant locks it in for the rest of time.
        const reg = manifest.registration;
        if (!reg) return;
        if ((reg.settingsFormat ?? 'json') !== 'toml') return;
        const targets = resolveAllTargets(manifest, 'global');
        if (!targets.settings) return; // No global settings surface declared.
        // TOML settings writer must not land on a `.json` file.
        expect(targets.settings.endsWith('.json')).toBe(false);
        // And it must not equal the hooks target, since the hooks file
        // is always shape-locked to hooksFormat (JSON for the JSON path,
        // a verbatim plugin file otherwise).
        if (targets.hooks) {
          expect(targets.settings).not.toBe(targets.hooks);
        }
      });
    }
  });

  /**
   * Marker reachability invariant.
   *
   * `isConfigured` for plugin-file symbionts checks for `myco:plugin-marker`
   * in the file content (with a substring fallback for JSON-shaped plugin
   * files). Catches the Antigravity case: shipped template never contained
   * the marker `isConfigured` searched for, so post-install detection lied.
   *
   * The contract: either the shipped template literally contains the
   * marker, OR the template's content unambiguously matches the
   * launcher-command substring fallback. The fallback exists for cases
   * where the template is a JSON file (like Antigravity's `hooks.json`)
   * that can't carry a TS-style comment.
   */
  describe('marker reachability', () => {
    for (const manifest of manifests) {
      const reg = manifest.registration;
      if (!reg) continue;
      if (reg.hooksFormat !== 'plugin-file') continue;
      const templateFile = reg.hooksTemplateFile ?? 'plugin.ts';
      const templatePath = path.join(TEMPLATES_DIR, manifest.name, templateFile);

      it(`${manifest.name}: shipped template ${templateFile} is detectable by isConfigured()`, () => {
        expect(fs.existsSync(templatePath)).toBe(true);
        const content = fs.readFileSync(templatePath, 'utf-8');
        const hasMarker = content.includes(PLUGIN_FILE_MARKER);
        // Templates use the `{{mycoLauncher}}` placeholder; the installer
        // substitutes it to `node ".../launcher.cjs"` (global) or
        // `node .agents/myco-run.cjs` (project) at install time. The
        // post-substitution form is what isConfigured() scans against the
        // installed file. For the template-level drift check we count any
        // of those forms as "detectable" — the placeholder IS the
        // pre-substitution promise to land a detectable string.
        const hasLauncherRef =
          /\bmyco-run\.cjs\b|\bmyco-hook\.cjs\b|\blauncher\.cjs\b|\{\{mycoLauncher\}\}/.test(content);
        if (!hasMarker && !hasLauncherRef) {
          throw new Error(
            `${manifest.name}: shipped template ${templatePath} contains neither ` +
            `'${PLUGIN_FILE_MARKER}' nor a launcher reference. ` +
            `isConfigured() will return false after install — silent capture failure.`,
          );
        }
      });
    }
  });

  /**
   * Template/format match invariant.
   *
   * The hooks template's on-disk shape must parse under the format the
   * manifest declares. A `json`-format symbiont with a malformed template
   * would still pass schema validation but blow up at install. A
   * `plugin-file` symbiont with a JSON-but-not-TS template (or vice versa)
   * passes the schema today; this gate prevents silent drift.
   */
  describe('template/format match', () => {
    for (const manifest of manifests) {
      const reg = manifest.registration;
      if (!reg) continue;
      const templateFile = reg.hooksTemplateFile ?? (reg.hooksFormat === 'plugin-file' ? 'plugin.ts' : 'hooks.json');
      const templatePath = path.join(TEMPLATES_DIR, manifest.name, templateFile);
      if (!fs.existsSync(templatePath)) continue; // JSON-format symbionts may use a non-default template name.

      it(`${manifest.name}: template ${templateFile} parses under declared hooksFormat`, () => {
        const content = fs.readFileSync(templatePath, 'utf-8');
        if (reg.hooksFormat === 'plugin-file') {
          // Plugin-file templates may be TS or JSON (Antigravity). Both
          // cases: must be non-empty and contain a recognizable hook-loop
          // shape (myco-run reference or a `hooks` key).
          expect(content.trim().length).toBeGreaterThan(0);
          if (templateFile.endsWith('.json')) {
            expect(() => JSON.parse(content)).not.toThrow();
          }
        } else {
          // json-format: template must be parseable JSON.
          expect(() => JSON.parse(content)).not.toThrow();
        }
      });
    }
  });

  /**
   * Path well-formedness invariant.
   *
   * Catches typos like a stray `..` or `//` in a manifest target field
   * before they reach the filesystem.
   */
  describe('path well-formedness', () => {
    for (const manifest of manifests) {
      const reg = manifest.registration;
      if (!reg) continue;
      // Schema normalizes globalMcpTarget into `Array<{path, serversKey?}>`
      // (multi-target manifests like Copilot land here); other path
      // fields are still scalar strings. Flatten everything into a
      // uniform (label, scalar) list for the well-formedness check so
      // a future surface added to the MCP array gets the same vetting.
      const fields: Array<[string, string | null | undefined]> = [
        ['globalHooksTarget', reg.globalHooksTarget],
        ['globalSkillsTarget', reg.globalSkillsTarget],
        ...(reg.globalMcpTarget ?? []).map(
          (entry, idx, list) =>
            [
              list.length > 1
                ? `globalMcpTarget[${idx}].path`
                : 'globalMcpTarget.path',
              entry.path,
            ] as [string, string | null | undefined],
        ),
      ];
      for (const [name, value] of fields) {
        if (value === undefined || value === null) continue;
        it(`${manifest.name}: ${name} is absolute or ~/-prefixed, no '..' or '//'`, () => {
          expect(value.startsWith('/') || value.startsWith('~/')).toBe(true);
          expect(value.includes('..')).toBe(false);
          expect(value.includes('//')).toBe(false);
        });
      }
    }
  });

  /**
   * Launcher-path scope correctness.
   *
   * Catches the bug class where a hook template hard-codes the
   * project-local launcher `node .agents/myco-run.cjs`, leaving global-
   * install hook files dependent on a project-local file existing in
   * whichever directory the agent was launched from. The fix is the
   * `{{mycoLauncher}}` placeholder, which the installer substitutes
   * scope-correctly at install time. The invariant is the contract:
   * every hook command in every JSON template must go through the
   * placeholder; no raw `.agents/myco-run.cjs` strings allowed.
   */
  describe('launcher-path scope correctness', () => {
    const HOOKS_TEMPLATE_DIRS = ['claude-code', 'codex', 'cursor', 'copilot', 'windsurf', 'antigravity'];
    for (const dir of HOOKS_TEMPLATE_DIRS) {
      const tplPath = path.join(TEMPLATES_DIR, dir, 'hooks.json');
      if (!fs.existsSync(tplPath)) continue;
      it(`${dir}/hooks.json: every hook command uses {{mycoLauncher}}, not a hard-coded launcher path`, () => {
        const content = fs.readFileSync(tplPath, 'utf-8');
        // No hard-coded project-local launcher path anywhere in the
        // template — that's the regression we're guarding against.
        expect(content.includes('.agents/myco-run.cjs')).toBe(false);
        expect(content.includes('.agents/myco-hook.cjs')).toBe(false);
        // No hard-coded global launcher path either — the substitution
        // is what makes the install scope-correct.
        expect(content.includes('.myco/launcher.cjs')).toBe(false);
        // Every hook command line must contain the placeholder. We walk
        // the parsed JSON to enumerate command strings, then assert each
        // one carries the placeholder.
        const parsed = JSON.parse(content);
        const commands = collectHookCommands(parsed);
        expect(commands.length).toBeGreaterThan(0);
        for (const cmd of commands) {
          expect(cmd).toContain('{{mycoLauncher}}');
        }
      });
    }
  });

  /**
   * detectionDir well-formedness.
   *
   * The global detection gate reads `detectionDir` directly. Same path-shape
   * rules apply — a malformed value would either silently never match (no
   * agent ever installed) or accidentally match the wrong directory.
   */
  describe('detectionDir well-formedness', () => {
    for (const manifest of manifests) {
      if (manifest.detectionDir === undefined) continue;
      if (manifest.detectionDir === null) continue;
      it(`${manifest.name}: detectionDir is ~/-prefixed and well-formed`, () => {
        expect(manifest.detectionDir!.startsWith('~/')).toBe(true);
        expect(manifest.detectionDir!.includes('..')).toBe(false);
        expect(manifest.detectionDir!.includes('//')).toBe(false);
      });
    }
  });

  /**
   * Claude-code hook template: every group declares a `matcher` field.
   *
   * Surfaced by dogfood: Cursor cross-reads `~/.claude/settings.json` to
   * surface Claude hooks in its own Hooks panel, but its parser is stricter
   * than Claude Code itself — a group without `matcher` is rejected and
   * Cursor disables ALL its own hooks ("Invalid hooks.json found. Fix the
   * errors below to enable hooks"). Cursor never fires user-prompt-submit
   * → daemon, so cursor capture goes silent without any signal at install
   * time. Locking the field as a structural property of the template.
   *
   * Scoped to claude-code because (a) it's the file Cursor cross-reads,
   * and (b) Codex's parser accepts no-matcher groups today (verified live).
   * If a future symbiont also gets cross-read, add it to TARGETS below.
   */
  describe('hook templates declare matcher on every group (Cursor cross-parse compat)', () => {
    const TARGETS = ['claude-code'];
    for (const symbiontName of TARGETS) {
      it(`${symbiontName}: every hook group has a matcher field`, () => {
        const templatePath = path.join(TEMPLATES_DIR, symbiontName, 'hooks.json');
        const raw = fs.readFileSync(templatePath, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, Array<Record<string, unknown>>>;
        for (const [event, groups] of Object.entries(parsed)) {
          for (let i = 0; i < groups.length; i++) {
            const group = groups[i];
            // The matcher field can be empty-string (matches all) — what
            // matters is that it's declared. Cursor's parser rejects
            // groups where the key is absent, not groups where it's "".
            expect(group, `${event}[${i}] missing matcher in ${symbiontName} template`).toHaveProperty('matcher');
          }
        }
      });
    }
  });

  /**
   * Project-dir resolution lives in the binary's launch preamble, NOT in
   * shell-cd prefixes. R4.4 surfaced that Cursor's hook spawn drops stdin
   * entirely when the command contains a shell operator (`cd "$X" && …`), so
   * the JSON payload never reaches our handlers and capture goes silent.
   *
   * Fix: the binary reads the per-agent project-dir env var (or AGY's
   * `workspacePaths[0]` from stdin) and anchors cwd in-process before
   * delegating. Templates carry plain command lines.
   *
   * Anti-regression: NO hook template may carry the `cd "${...}" && ` prefix.
   * claude-code dropped its prefix in the launcher-unification flip (D5) — the
   * in-process cwd anchor makes the shell `cd` redundant.
   */
  describe('shell-cd prefix is absent (cursor stdin-drop anti-regression)', () => {
    const SHELL_CD_PATTERN = /cd\s+"\$\{[A-Z_]+:-\.\}"\s*&&/;
    const TEMPLATE_DIRS = ['claude-code', 'codex', 'cursor', 'copilot', 'windsurf', 'antigravity'];
    for (const dir of TEMPLATE_DIRS) {
      const tplPath = path.join(TEMPLATES_DIR, dir, 'hooks.json');
      if (!fs.existsSync(tplPath)) continue;
      it(`${dir}/hooks.json: must not introduce a shell-cd prefix`, () => {
        const parsed = JSON.parse(fs.readFileSync(tplPath, 'utf-8'));
        const commands = collectHookCommands(parsed);
        expect(commands.length).toBeGreaterThan(0);
        for (const cmd of commands) {
          expect(cmd, `${dir} command grew a shell-cd prefix (Cursor stdin-drop risk): ${cmd}`).not.toMatch(SHELL_CD_PATTERN);
        }
      });
    }
  });

  /**
   * Copilot intentionally does NOT subscribe to PermissionRequest — that's
   * an interactive allow/deny hook; Myco is observational. A regression
   * adding the event without the explicit rationale review would risk
   * silently suppressing tool calls. See copilot.yaml hook surface doc.
   */
  describe('copilot hooks omit PermissionRequest (observational-only)', () => {
    it('hooks template does not subscribe to PermissionRequest', () => {
      const tplPath = path.join(TEMPLATES_DIR, 'copilot', 'hooks.json');
      const parsed = JSON.parse(fs.readFileSync(tplPath, 'utf-8')) as Record<string, unknown>;
      expect(Object.keys(parsed)).not.toContain('PermissionRequest');
    });
  });

});
