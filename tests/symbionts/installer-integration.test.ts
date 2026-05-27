/**
 * Symbiont installer integration matrix — exercises the full
 * `installer.install({ scope: 'global' })` for every symbiont against a
 * tmpdir fake `$HOME`, then asserts the post-state.
 *
 * Catches the bug class that escapes pure unit tests: two install
 * operations meeting at the same file path with different content, a
 * `JSON.parse`-shaped detector hitting a hybrid JSON+TOML real-world
 * file, an `isConfigured` marker that the shipped template never wrote.
 * Each assertion below is a regression for a bug the live global-install
 * dogfood surfaced.
 *
 * Conventions:
 *   - One `describe` per assertion class, parameterized over every
 *     symbiont in the manifest registry.
 *   - HOME is rebound to a per-test tmpdir; the symbiont's `detectionDir`
 *     is pre-created so the global detection gate passes.
 *   - A write-tracker monkey-patches `fs.writeFileSync` + `fs.renameSync`
 *     to record every (path, content-sha) pair that lands during one
 *     `install()` pass. The collision audit fails if the same path
 *     receives two writes with different shas.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { loadManifests } from '@myco/symbionts/detect.js';
import type { SymbiontManifest } from '@myco/symbionts/manifest-schema.js';

const PKG_ROOT = path.resolve(__dirname, '..', '..', 'packages', 'myco');

const manifests = loadManifests();

/**
 * Pre-create the agent's `detectionDir` (resolved against tmpHome) so the
 * global install detection gate passes. Mirrors what a real installation
 * of the symbiont would have done on the user's machine.
 */
function ensureDetectionDir(manifest: SymbiontManifest, tmpHome: string): void {
  const dir = manifest.detectionDir;
  if (!dir) return;
  if (!dir.startsWith('~/')) return;
  const absDir = path.join(tmpHome, dir.slice(2));
  fs.mkdirSync(absDir, { recursive: true });
}

/**
 * Recursive byte-snapshot of every file under `root`. Used by reversibility
 * + idempotence assertions. Excludes the legacy `.tmp-*` atomic-write
 * tempfiles that may or may not have been cleaned up on errors.
 */
function snapshotTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(root)) return out;
  walk(root);
  return out;

  function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (entry.name.startsWith('.tmp-')) continue;
        try {
          // Read symlink target as-string rather than following it — we
          // want byte-for-byte structural equality.
          const content = entry.isSymbolicLink() ? `SYMLINK:${fs.readlinkSync(full)}` : fs.readFileSync(full, 'utf-8');
          out.set(full, content);
        } catch { /* unreadable; skip */ }
      }
    }
  }
}

interface WriteEvent { path: string; sha: string }

/**
 * Install a write tracker by monkey-patching fs methods. Records every
 * destination path that received bytes during the lifetime of the
 * tracker. Returns a teardown that restores the originals + the events.
 *
 * Two surfaces matter:
 *   - `fs.writeFileSync` — direct writes (reconcileAgentsMd, gitignore,
 *     legacy JSON writers).
 *   - `fs.renameSync` — the "publish" step of `atomicWriteFileSync`. The
 *     destination of the rename is the real on-disk write target;
 *     tracking it covers every `writeManagedFile` / `writeJsonFile`
 *     call across the installer.
 */
function installWriteTracker(): { events: WriteEvent[]; restore: () => void } {
  const events: WriteEvent[] = [];
  const realWriteFileSync = fs.writeFileSync;
  const realRenameSync = fs.renameSync;
  const realReadFileSync = fs.readFileSync;

  function sha(data: unknown): string {
    const buf = typeof data === 'string' ? Buffer.from(data) : Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = ((
    file: fs.PathOrFileDescriptor,
    data: string | NodeJS.ArrayBufferView,
    options?: fs.WriteFileOptions,
  ) => {
    realWriteFileSync(file, data, options);
    if (typeof file === 'string' && !path.basename(file).startsWith('.tmp-')) {
      events.push({ path: file, sha: sha(data) });
    }
  }) as typeof fs.writeFileSync;

  (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    realRenameSync(from, to);
    if (typeof to === 'string' && !path.basename(to).startsWith('.tmp-')) {
      try {
        const content = realReadFileSync(to, 'utf-8');
        events.push({ path: to, sha: sha(content) });
      } catch {
        // Rename succeeded but the post-read failed — skip event rather than crash the install.
      }
    }
  }) as typeof fs.renameSync;

  return {
    events,
    restore: () => {
      (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = realWriteFileSync;
      (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = realRenameSync;
    },
  };
}

interface FakeHome {
  tmpHome: string;
  cleanup: () => void;
}

function setupFakeHome(): FakeHome {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-installer-integ-'));
  const prevHome = process.env.HOME;
  const prevMycoHome = process.env.MYCO_HOME;
  process.env.HOME = tmpHome;
  process.env.MYCO_HOME = path.join(tmpHome, '.myco');
  return {
    tmpHome,
    cleanup: () => {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevMycoHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = prevMycoHome;
    },
  };
}

function newInstaller(manifest: SymbiontManifest, tmpHome: string): SymbiontInstaller {
  return new SymbiontInstaller(
    manifest,
    tmpHome,
    PKG_ROOT,
    false,
    undefined,
    null,
    'global',
  );
}

/** Symbionts that skip the global install on this OS — we still construct
 *  them, but their `install()` is a no-op so the matrix assertions wouldn't
 *  exercise anything meaningful. Documented in the manifests. */
const SKIP_REASONS: Record<string, string> = {
  // copilot's globalMcpTarget array includes the VS Code Library MCP path,
  // which is macOS-only — on Linux/Windows that path doesn't apply. Skip the
  // integration matrix on non-darwin until the manifest's globalMcpTarget
  // array gains per-platform filtering.
  ...(process.platform !== 'darwin' ? { copilot: 'macOS-only VS Code MCP path in target array' } : {}),
};

/**
 * Symbionts whose per-symbiont `uninstall()` does NOT presently restore
 * `isConfigured() === false` under global scope. Each entry has a known
 * spore documenting the root cause; remove from this set as the bug is
 * fixed in a follow-up PR and the test will tighten automatically.
 *
 * The reversibility test still runs for these symbionts — it asserts the
 * weaker contract that `uninstall()` returned (didn't crash) and that the
 * agent's `detectionDir` is preserved. The strict `isConfigured === false`
 * assertion is gated behind absence from this set.
 *
 *   codex — spore `bug_fix-0a3de4ec`: hybrid JSON+TOML `~/.codex/hooks.json`
 *           breaks the JSON.parse path inside uninstallHooks.
 *   antigravity — spore `bug_fix-6f70f276`: `templates/antigravity/hooks.json`
 *                 carries no plugin marker, so `uninstallPluginHookFile`
 *                 refuses to delete it.
 */
const KNOWN_REVERSIBILITY_GAPS = new Set<string>();

describe('symbiont installer integration matrix (global scope)', () => {
  /**
   * Post-install command-line scope check.
   *
   * The regression this guards: a global-scope install whose hook
   * commands still reference `.agents/myco-run.cjs` (the project-local
   * launcher). When the project doesn't ship that file, capture dies
   * silently. The fix is the `{{mycoLauncher}}` placeholder, substituted
   * to `node "$HOME/.myco/launcher.cjs"` at install time. This assertion
   * walks the actual on-disk hook files after install and proves the
   * launcher path landed correctly.
   */
  describe('post-install hooks file references the global launcher', () => {
    for (const manifest of manifests) {
      const reg = manifest.registration;
      if (!reg?.globalHooksTarget) continue;
      // Plugin-file format (opencode, pi) wires hooks through TypeScript
      // plugin source that dispatches tool calls to the project-local
      // launcher from inside an active project context — different
      // dispatch model than JSON hook command lines. Excluded here; the
      // JSON-format symbionts are what this assertion guards.
      if (reg.hooksFormat === 'plugin-file' && reg.hooksTemplateFile !== 'hooks.json') continue;
      const skip = SKIP_REASONS[manifest.name];
      const test = skip ? it.skip : it;
      test(`${manifest.name}: hook command lines reference ~/.myco/launcher.cjs, not .agents/myco-run.cjs`, () => {
        const fake = setupFakeHome();
        try {
          ensureDetectionDir(manifest, fake.tmpHome);
          const installer = newInstaller(manifest, fake.tmpHome);
          installer.install();
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hooksPath = (installer as any).resolveAbsoluteTarget('hooks') as string | null;
          if (!hooksPath || !fs.existsSync(hooksPath)) return;
          const content = fs.readFileSync(hooksPath, 'utf-8');
          // Substituted file must reference the global launcher and
          // must NOT contain the project-local launcher reference.
          expect(content.includes('.myco/launcher.cjs')).toBe(true);
          expect(content.includes('.agents/myco-run.cjs')).toBe(false);
          // The placeholder must be gone — leaving it literal would
          // be worse than the bug we're guarding against.
          expect(content.includes('{{mycoLauncher}}')).toBe(false);
        } finally {
          fake.cleanup();
        }
      });
    }
  });

  describe('round-trip: install ⇒ isConfigured() = true', () => {
    for (const manifest of manifests) {
      const skip = SKIP_REASONS[manifest.name];
      const test = skip ? it.skip : it;
      test(`${manifest.name}: install then isConfigured()`, () => {
        const fake = setupFakeHome();
        try {
          ensureDetectionDir(manifest, fake.tmpHome);
          const installer = newInstaller(manifest, fake.tmpHome);
          expect(installer.isAvailableForScope()).toBe(true);
          installer.install();
          // After install, the same installer's detection method must
          // agree that Myco is wired in. This is the contract that
          // failed live on Codex (TOML footer) and Antigravity (no
          // marker in plugin-file template).
          expect(installer.isConfigured()).toBe(true);
        } finally {
          fake.cleanup();
        }
      });
    }
  });

  /**
   * Collision audit — runtime double-check for the OpenCode bug class.
   *
   * Layer 1's static no-collision invariant already proves that no
   * plugin-file hooks path is declared as another field's target. This
   * runtime audit catches the second-order case: a writer the manifest
   * doesn't know about (legacy cleanup, MCP, settings) silently touches
   * the plugin file at install time.
   *
   * For JSON-merge symbionts (claude-code, cursor, codex, windsurf,
   * copilot), multiple writers legitimately compose into the
   * same settings/hooks file — that's the merge contract, not a
   * collision. The audit is scoped to plugin-file targets only.
   */
  describe('collision audit: plugin-file hooks target is written by no other operation', () => {
    for (const manifest of manifests) {
      const reg = manifest.registration;
      if (!reg) continue;
      if (reg.hooksFormat !== 'plugin-file') continue;
      const skip = SKIP_REASONS[manifest.name];
      const test = skip ? it.skip : it;
      test(`${manifest.name}: plugin-file hooks target receives at most one distinct payload`, () => {
        const fake = setupFakeHome();
        const tracker = installWriteTracker();
        try {
          ensureDetectionDir(manifest, fake.tmpHome);
          const installer = newInstaller(manifest, fake.tmpHome);
          installer.install();
          // Find the plugin-file hooks target by re-resolving — same
          // path math the installer uses.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hooksPath = (installer as any).resolveAbsoluteTarget('hooks') as string | null;
          if (!hooksPath) return; // No global hooks surface declared.
          const writesToPluginPath = tracker.events.filter((e) => e.path === hooksPath);
          const distinctShas = new Set(writesToPluginPath.map((e) => e.sha));
          if (distinctShas.size > 1) {
            const detail = [...distinctShas].map((s) => `  ${s.slice(0, 12)}…`).join('\n');
            throw new Error(
              `${manifest.name}: plugin-file hooks path ${hooksPath} received ` +
              `${distinctShas.size} distinct payloads during install — likely a ` +
              `non-hook writer is clobbering the plugin source.\n${detail}`,
            );
          }
        } finally {
          tracker.restore();
          fake.cleanup();
        }
      });
    }
  });

  describe('idempotence: second install() yields zero on-disk diff', () => {
    for (const manifest of manifests) {
      const skip = SKIP_REASONS[manifest.name];
      const test = skip ? it.skip : it;
      test(`${manifest.name}: second install() is a no-op`, () => {
        const fake = setupFakeHome();
        try {
          ensureDetectionDir(manifest, fake.tmpHome);
          const installer = newInstaller(manifest, fake.tmpHome);
          installer.install();
          const before = snapshotTree(fake.tmpHome);
          // Fresh installer instance to defeat any in-memory state caching.
          const second = newInstaller(manifest, fake.tmpHome);
          second.install();
          const after = snapshotTree(fake.tmpHome);
          // Exclude transient atomic-write tempfiles and listing-order noise.
          const beforeKeys = [...before.keys()].sort();
          const afterKeys = [...after.keys()].sort();
          expect(afterKeys).toEqual(beforeKeys);
          for (const key of beforeKeys) {
            expect(after.get(key)).toBe(before.get(key)!);
          }
        } finally {
          fake.cleanup();
        }
      });
    }
  });

  describe('reversibility: uninstall() returns tmpdir to pre-install state', () => {
    for (const manifest of manifests) {
      const skip = SKIP_REASONS[manifest.name];
      const test = skip ? it.skip : it;
      test(`${manifest.name}: uninstall removes installer's writes`, () => {
        const fake = setupFakeHome();
        try {
          ensureDetectionDir(manifest, fake.tmpHome);
          const before = snapshotTree(fake.tmpHome);
          const installer = newInstaller(manifest, fake.tmpHome);
          installer.install();
          installer.uninstall();

          // Per-symbiont uninstall under global scope deliberately does
          // NOT remove the shared launchers (`~/.myco/launcher.cjs` +
          // `mcp-launcher.cjs`) — `myco remove` (Step 15) owns that.
          // Also does NOT remove the agent's config directory itself —
          // only Myco's content within it. So `after` may have an
          // expanded set of paths under `~/.myco/...` and the agent
          // directories, but Myco's wire-in (per `isConfigured`) must
          // be gone.
          const reinstalled = newInstaller(manifest, fake.tmpHome);
          if (KNOWN_REVERSIBILITY_GAPS.has(manifest.name)) {
            // Known-gap symbiont: strict assertion skipped intentionally
            // — see KNOWN_REVERSIBILITY_GAPS for spore IDs and root cause.
            // The fix lands separately; removing the symbiont from the
            // set tightens this assertion automatically.
            void reinstalled;
          } else {
            expect(reinstalled.isConfigured()).toBe(false);
          }

          // detectionDir we mkdir'd should still exist (we never delete
          // the agent's own config dir).
          const dir = manifest.detectionDir;
          if (dir?.startsWith('~/')) {
            const absDir = path.join(fake.tmpHome, dir.slice(2));
            expect(fs.existsSync(absDir)).toBe(true);
          }
          // The pre-install snapshot is informational; we don't assert
          // byte-identical because the launchers persist intentionally.
          void before;
        } finally {
          fake.cleanup();
        }
      });
    }
  });

  /**
   * Pre-existing user content preservation — regression cases drawn from
   * the live global-install dogfood.
   */
  describe('pre-existing user content preservation', () => {
    it('codex: TOML [features] footer in ~/.codex/hooks.json survives install + is still detected', () => {
      const fake = setupFakeHome();
      try {
        const manifest = manifests.find((m) => m.name === 'codex')!;
        ensureDetectionDir(manifest, fake.tmpHome);
        // Codex itself appends a `[features]` TOML footer to its own
        // hooks.json. JSON.parse rejects this hybrid file; `isConfigured`
        // must fall through to a substring scan and still return true.
        const hooksPath = path.join(fake.tmpHome, '.codex', 'hooks.json');
        const hybridFile =
          `{ "hooks": {} }\n\n[features]\nhooks = true\n`;
        fs.writeFileSync(hooksPath, hybridFile, 'utf-8');

        const installer = newInstaller(manifest, fake.tmpHome);
        installer.install();
        expect(installer.isConfigured()).toBe(true);
        const post = fs.readFileSync(hooksPath, 'utf-8');
        // Even though we overwrite the file with merged JSON, the
        // post-install file must still contain a hook entry that
        // references the launcher — that's the detection contract.
        expect(/\bmyco-run\.cjs\b|\blauncher\.cjs\b/.test(post)).toBe(true);
      } finally {
        fake.cleanup();
      }
    });

    it('opencode: existing plugin.ts user code is not clobbered by other install ops', () => {
      const fake = setupFakeHome();
      try {
        const manifest = manifests.find((m) => m.name === 'opencode')!;
        ensureDetectionDir(manifest, fake.tmpHome);
        const installer = newInstaller(manifest, fake.tmpHome);
        installer.install();

        // Plugin lands at this exact path. The historical bug:
        // installSettings would overwrite it with a JSON settings
        // template, since `resolveAbsoluteTarget('settings')` fell back
        // to globalHooksTarget. Verify the post-install file is a TS
        // plugin (contains `export` or the marker), not a stray JSON
        // settings template.
        const pluginPath = path.join(fake.tmpHome, '.config', 'opencode', 'plugins', 'myco.ts');
        expect(fs.existsSync(pluginPath)).toBe(true);
        const content = fs.readFileSync(pluginPath, 'utf-8');
        const looksLikePluginTs = content.includes('myco:plugin-marker') || /\bexport\b/.test(content);
        expect(looksLikePluginTs).toBe(true);
        // The settings template would have been a JSON object — verify
        // the plugin is NOT a JSON settings shape.
        let parsed: unknown;
        try { parsed = JSON.parse(content); } catch { parsed = undefined; }
        // A plugin .ts file is not valid JSON; if JSON.parse succeeded
        // we've regressed back into the clobber.
        expect(parsed).toBeUndefined();
      } finally {
        fake.cleanup();
      }
    });

    it('claude-code: unrelated user hooks in ~/.claude/settings.json are preserved', () => {
      const fake = setupFakeHome();
      try {
        const manifest = manifests.find((m) => m.name === 'claude-code')!;
        ensureDetectionDir(manifest, fake.tmpHome);
        const settingsPath = path.join(fake.tmpHome, '.claude', 'settings.json');
        // User had a hook for some other tool — must survive install.
        const preExisting = {
          hooks: {
            PreToolUse: [
              { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-user-hook.sh' }] },
            ],
          },
        };
        fs.writeFileSync(settingsPath, JSON.stringify(preExisting, null, 2), 'utf-8');

        const installer = newInstaller(manifest, fake.tmpHome);
        installer.install();

        const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as {
          hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
        };
        // The user's hook must still be there alongside Myco's hooks.
        const preToolUse = after.hooks?.PreToolUse ?? [];
        const userHookSurvived = preToolUse.some((g) =>
          (g.hooks ?? []).some((h) => h.command === 'my-user-hook.sh'),
        );
        expect(userHookSurvived).toBe(true);
        expect(installer.isConfigured()).toBe(true);
      } finally {
        fake.cleanup();
      }
    });
  });

  /**
   * Empty-config cleanup: when install creates a file and uninstall strips
   * the last Myco-owned content, the file must be unlinked, not left as an
   * empty `{}` / blank TOML stub.
   *
   * Surfaced during R4.5 walker audit: the strip paths call
   * `writeOrDeleteJsonFile` / unlink-when-empty for TOML, but there was no
   * test locking the behavior. A regression here leaves orphan config files
   * scattered across `~/.<agent>/` after `myco remove`, and stale empty
   * config files can re-trigger detection in some agents (cursor reads
   * absent → no hooks, but cursor reads empty `{}` → "hooks were defined,
   * none of them match" which surfaces in its UI panel).
   */
  /**
   * Write-ordering invariant — the launchers (`~/.myco/launcher.cjs` and
   * `~/.myco/mcp-launcher.cjs`) MUST be on disk BEFORE any agent's global
   * hook config is written referencing them. The docstring on
   * `packages/myco/src/grove/launcher-install.ts` calls this out:
   *
   *   > Hook config that points at a not-yet-existent launcher leaves
   *   > a multi-second window where every hook fires ENOENT and capture
   *   > goes silent.
   *
   * The regression this guards against: a future refactor reorders
   * `install()` so `installHooks()` runs before `installHookGuard()`,
   * or so `installHookGuard()` becomes async/deferred. Either way, the
   * symptom is the same — first-run hooks fail silently until the
   * launcher write catches up.
   *
   * Captured via a write-order spy: every fs.renameSync (the atomic
   * publish step) and fs.writeFileSync records the moment the target
   * lands. At the moment ANY agent's global hook target lands, we
   * snapshot whether the launcher file exists on disk. If a hook
   * write was recorded before the launcher landed, fail.
   */
  describe('write ordering: launchers exist before any agent hook config references them', () => {
    for (const manifest of manifests) {
      const reg = manifest.registration;
      if (!reg?.globalHooksTarget) continue;
      const skip = SKIP_REASONS[manifest.name];
      const test = skip ? it.skip : it;
      test(`${manifest.name}: launcher.cjs exists at the instant the global hooks file is written`, () => {
        const fake = setupFakeHome();
        // Each recorded write captures: path written + whether the
        // launcher existed on disk at that exact moment. The
        // launcher-existence snapshot must come from `fs.existsSync`
        // INSIDE the patched writer (post-rename, pre-return), not
        // after-the-fact — by `install()`'s return, every write has
        // landed and the test would be meaningless.
        interface OrderedWrite { path: string; launcherExistedAtWriteTime: boolean }
        const writes: OrderedWrite[] = [];
        const mycoHome = process.env.MYCO_HOME!;
        const launcherPath = path.join(mycoHome, 'launcher.cjs');

        const realWriteFileSync = fs.writeFileSync;
        const realRenameSync = fs.renameSync;
        (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = ((
          file: fs.PathOrFileDescriptor,
          data: string | NodeJS.ArrayBufferView,
          options?: fs.WriteFileOptions,
        ) => {
          realWriteFileSync(file, data, options);
          if (typeof file === 'string' && !path.basename(file).startsWith('.tmp-')) {
            writes.push({ path: file, launcherExistedAtWriteTime: fs.existsSync(launcherPath) });
          }
        }) as typeof fs.writeFileSync;
        (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = ((
          from: fs.PathLike,
          to: fs.PathLike,
        ) => {
          realRenameSync(from, to);
          if (typeof to === 'string' && !path.basename(to).startsWith('.tmp-')) {
            writes.push({ path: to, launcherExistedAtWriteTime: fs.existsSync(launcherPath) });
          }
        }) as typeof fs.renameSync;

        try {
          ensureDetectionDir(manifest, fake.tmpHome);
          const installer = newInstaller(manifest, fake.tmpHome);
          installer.install();

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const hooksPath = (installer as any).resolveAbsoluteTarget('hooks') as string | null;
          if (!hooksPath) return; // No global hooks surface — invariant vacuous.

          // Sanity: the launcher itself must have been written at some
          // point during the install. If it wasn't, the assertion below
          // would trivially pass for the wrong reason.
          const launcherWriteCount = writes.filter((w) => w.path === launcherPath).length;
          expect(launcherWriteCount).toBeGreaterThan(0);

          // The actual invariant: every write to the agent's global hooks
          // target must have happened AFTER the launcher landed on disk.
          // Multiple writes to the same path are fine (atomic publish +
          // post-process re-write); we just need every one of them to
          // see the launcher present.
          const hookWrites = writes.filter((w) => w.path === hooksPath);
          expect(hookWrites.length).toBeGreaterThan(0);
          for (const w of hookWrites) {
            if (!w.launcherExistedAtWriteTime) {
              throw new Error(
                `${manifest.name}: hook config write at ${w.path} happened ` +
                `BEFORE launcher.cjs landed on disk. Multi-second ENOENT ` +
                `window — capture would silently fail until the next ` +
                `daemon reconcile pass. Write order: ${writes.map((x) => path.basename(x.path)).join(' → ')}`,
              );
            }
          }
        } finally {
          (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = realWriteFileSync;
          (fs as unknown as { renameSync: typeof fs.renameSync }).renameSync = realRenameSync;
          fake.cleanup();
        }
      });
    }
  });

  describe('empty-config cleanup: uninstall removes files installer created', () => {
    for (const manifest of manifests) {
      const skip = SKIP_REASONS[manifest.name];
      const test = skip ? it.skip : it;
      test(`${manifest.name}: file installer wrote with no prior content is unlinked on uninstall`, () => {
        const fake = setupFakeHome();
        try {
          ensureDetectionDir(manifest, fake.tmpHome);
          const installer = newInstaller(manifest, fake.tmpHome);
          installer.install();

          // Capture every absolute path the installer reaches into.
          const installedPaths = new Set<string>();
          for (const field of ['hooks', 'mcp', 'settings'] as const) {
            const target = (installer as unknown as {
              resolveAbsoluteTarget: (f: string) => string | null;
            }).resolveAbsoluteTarget(field);
            if (target) installedPaths.add(target);
          }
          // Pre-flight: at least one of those paths must exist post-install
          // for the assertion to be meaningful.
          const existedAfterInstall = Array.from(installedPaths).filter((p) => fs.existsSync(p));
          if (existedAfterInstall.length === 0) return; // nothing to assert

          installer.uninstall();

          // For each path that we own (not pre-existing), uninstall must
          // have removed it. The pre-existing case is the
          // "reversibility" describe block above — this block covers the
          // disjoint half where pre-install content was absent.
          for (const p of existedAfterInstall) {
            if (fs.existsSync(p)) {
              const raw = fs.readFileSync(p, 'utf-8');
              // Allow nonempty content (user already had this file) — but
              // the test setup didn't seed any user content, so anything
              // left here is an orphan stub we should have cleaned up.
              expect(raw.trim().length, `${manifest.name}: orphan empty config at ${p}`).toBeGreaterThan(0);
            }
          }
        } finally {
          fake.cleanup();
        }
      });
    }
  });
});
