/**
 * Layer 3 — capture round-trip smoke. Per symbiont, install in global
 * scope against a tmpdir fake-$HOME, then EXECUTE the hook command
 * line from the installed hooks file (via shell so the `cd
 * "${...PROJECT_DIR:-.}" && ...` prefix works) and confirm the runtime
 * the launcher resolves to receives the right `--symbiont <name>` arg
 * and the synthesized hook payload on stdin.
 *
 * Catches the bug class: "hook fires through the launcher but the
 * payload never reaches the binary." The R1 launcher-placeholder bug
 * and the R3.0 cross-Grove walker bug were both "looks installed,
 * silently doesn't work" failures that the in-process dispatcher tests
 * couldn't see. This suite closes that gap by going through the actual
 * hook command line.
 *
 * The runtime resolution chain (`<project>/.agents/myco-run.cjs`,
 * `<project>/.myco/runtime.command`, `~/.myco/runtime.command`,
 * vendored binary, PATH `myco`) is short-circuited with a single stub
 * binary pinned at `~/.myco/runtime.command` for the test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { loadManifests } from '@myco/symbionts/detect.js';
import type { SymbiontManifest } from '@myco/symbionts/manifest-schema.js';

const PKG_ROOT = path.resolve(__dirname, '..', '..', 'packages', 'myco');

const manifests = loadManifests();

/**
 * Shell wrapper that records argv + stdin to a log file then exits 0.
 * Stand-in for the real Myco binary; lets us assert the hook command
 * line actually reaches a runtime with the expected payload, without
 * standing up a daemon or running the production binary.
 */
const STUB_SCRIPT = `#!/usr/bin/env bash
set -u
log="\${MYCO_STUB_LOG:?MYCO_STUB_LOG must be set}"
{
  echo "ARGS: $*"
  echo "STDIN:"
  cat
  echo
  echo "---"
} >> "\$log"
exit 0
`;

interface FakeHome {
  tmpHome: string;
  projectDir: string;
  stubLog: string;
  cleanup: () => void;
}

function setupFakeHome(): FakeHome {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-capture-roundtrip-'));
  // A separate project dir for the agent's CWD when the hook fires.
  // Crucially does NOT contain `.agents/myco-run.cjs` — we want the
  // launcher's resolution to fall through to the runtime.command pin,
  // not into a project-local override.
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-capture-project-'));
  fs.mkdirSync(path.join(tmpHome, '.myco'), { recursive: true });
  const stubBin = path.join(tmpHome, 'stub-runtime');
  fs.writeFileSync(stubBin, STUB_SCRIPT, { mode: 0o755 });
  fs.chmodSync(stubBin, 0o755);
  const stubLog = path.join(tmpHome, 'stub.log');
  fs.writeFileSync(stubLog, '');
  // Pin the machine-global runtime to our stub so launcher resolves to it.
  fs.writeFileSync(path.join(tmpHome, '.myco', 'runtime.command'), stubBin + '\n');
  const prevHome = process.env.HOME;
  const prevMycoHome = process.env.MYCO_HOME;
  process.env.HOME = tmpHome;
  process.env.MYCO_HOME = path.join(tmpHome, '.myco');
  return {
    tmpHome,
    projectDir,
    stubLog,
    cleanup: () => {
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(projectDir, { recursive: true, force: true });
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevMycoHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = prevMycoHome;
    },
  };
}

function ensureDetectionDir(manifest: SymbiontManifest, tmpHome: string): void {
  const dir = manifest.detectionDir;
  if (!dir || !dir.startsWith('~/')) return;
  fs.mkdirSync(path.join(tmpHome, dir.slice(2)), { recursive: true });
}

interface HookCommand {
  command: string;
  /** Env var name the command's `cd "${X:-.}"` prefix uses, if any. */
  projectDirEnvVar?: string;
}

/**
 * Find the first Myco-owned hook command line in a parsed hooks file.
 * Walks every event regardless of name (event-name conventions diverge
 * across symbionts — `SessionStart`, `sessionStart`, `PreInvocation`,
 * `pre_user_prompt`, …) and accepts both Claude-Code-style nested
 * (`{hooks: [{command}]}`) and Cursor/Windsurf-style flat (`{command}`)
 * group shapes. Returns the first command containing
 * `--symbiont <manifest.name>` so we know it's Myco's.
 */
function firstMycoCommand(manifestName: string, hooksContent: string): HookCommand | null {
  let parsed: unknown;
  try { parsed = JSON.parse(hooksContent); } catch { return null; }
  const root = (parsed && typeof parsed === 'object' && 'hooks' in parsed)
    ? (parsed as { hooks?: unknown }).hooks
    : parsed;
  if (!root || typeof root !== 'object') return null;
  const events = root as Record<string, unknown>;
  for (const groups of Object.values(events)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== 'object') continue;
      // Nested: { hooks: [{ command: '...' }] }
      if ('hooks' in group && Array.isArray((group as { hooks?: unknown }).hooks)) {
        for (const h of (group as { hooks: Array<{ command?: string }> }).hooks) {
          if (typeof h.command === 'string' && h.command.includes(`--symbiont ${manifestName}`)) {
            return inspect(h.command);
          }
        }
      }
      // Flat: { command: '...' }
      const flatCmd = (group as { command?: unknown }).command;
      if (typeof flatCmd === 'string' && flatCmd.includes(`--symbiont ${manifestName}`)) {
        return inspect(flatCmd);
      }
    }
  }
  return null;

  function inspect(command: string): HookCommand {
    const m = command.match(/cd "\$\{(\w+):-\.\}"/);
    return m ? { command, projectDirEnvVar: m[1] } : { command };
  }
}

const SYNTH_SESSION_ID = 'roundtrip-probe-session';
const SYNTH_PAYLOAD = JSON.stringify({
  hook_event_name: 'SessionStart',
  session_id: SYNTH_SESSION_ID,
  cwd: '/tmp/synth-project',
  transcript_path: '/tmp/synth-transcript.jsonl',
  source: 'startup',
});

/** Symbionts skipped: their global hooks file uses a non-JSON format
 *  (plugin-file) and the dispatch path isn't through a hook command
 *  line — opencode talks to the daemon over HTTP, pi via TS plugin.
 *  Both are covered by their own tests. */
const SKIP_PLUGIN_FILE = new Set<string>(['opencode', 'pi']);

describe('symbiont capture round-trip — hook command reaches the runtime with payload', () => {
  let fake: FakeHome | null = null;

  beforeEach(() => {
    fake = setupFakeHome();
  });
  afterEach(() => {
    if (fake) { fake.cleanup(); fake = null; }
  });

  for (const manifest of manifests) {
    if (SKIP_PLUGIN_FILE.has(manifest.name)) continue;
    if (!manifest.registration?.globalHooksTarget) continue;
    // vscode-copilot's global path is macOS-only; the integration
    // suite skips it on Linux/Windows and so do we.
    const skip = manifest.name === 'vscode-copilot' && process.platform !== 'darwin';
    const test = skip ? it.skip : it;

    test(`${manifest.name}: SessionStart hook reaches the runtime with --symbiont ${manifest.name} and stdin payload`, () => {
      if (!fake) throw new Error('fake home not set');
      ensureDetectionDir(manifest, fake.tmpHome);
      const installer = new SymbiontInstaller(
        manifest, fake.tmpHome, PKG_ROOT, false, undefined, null, 'global',
      );
      installer.install();

      // Read the installed hooks file and find a SessionStart hook command.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hooksPath = (installer as any).resolveAbsoluteTarget('hooks') as string | null;
      if (!hooksPath || !fs.existsSync(hooksPath)) {
        throw new Error(`expected hooks file at ${hooksPath ?? '(null)'}`);
      }
      const hooksContent = fs.readFileSync(hooksPath, 'utf-8');
      const cmd = firstMycoCommand(manifest.name, hooksContent);
      if (!cmd) throw new Error(`no Myco hook command found in ${hooksPath}`);

      // Execute through bash so the `cd "${X:-.}" && node ...` prefix
      // resolves and the launcher.cjs is invoked with the right
      // working directory.
      const env: Record<string, string> = {
        ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]),
        HOME: fake.tmpHome,
        MYCO_HOME: path.join(fake.tmpHome, '.myco'),
        MYCO_STUB_LOG: fake.stubLog,
        // Defeat the launcher's "I'm a sub-invocation of an existing Myco
        // session" early-exit guard — we WANT the dispatch to fire.
        MYCO_AGENT_SESSION: '',
      };
      delete env.MYCO_AGENT_SESSION;
      if (cmd.projectDirEnvVar) env[cmd.projectDirEnvVar] = fake.projectDir;

      try {
        execFileSync('bash', ['-c', cmd.command], {
          input: SYNTH_PAYLOAD,
          env,
          cwd: fake.projectDir,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        });
      } catch (err) {
        const stderr = (err as { stderr?: Buffer }).stderr?.toString() ?? '';
        const stdout = (err as { stdout?: Buffer }).stdout?.toString() ?? '';
        throw new Error(`hook command failed for ${manifest.name}: ${(err as Error).message}\nstderr: ${stderr}\nstdout: ${stdout}\ncommand: ${cmd.command}`);
      }

      // The stub appended a record per invocation. The hook may fire
      // additional sub-commands (cd, etc.) — we only assert at least one
      // record with the expected --symbiont flag + the synth session_id.
      const log = fs.readFileSync(fake.stubLog, 'utf-8');
      expect(log).toContain(`--symbiont ${manifest.name}`);
      expect(log).toContain(SYNTH_SESSION_ID);
      // The launcher dispatched the original `hook <event>` args through;
      // assert at least the leading `hook ` token survived.
      expect(/\bARGS: hook \b/.test(log)).toBe(true);
    });
  }
});
