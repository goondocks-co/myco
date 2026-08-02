// Managed by Myco. Regenerated on `myco update`. Edit src/symbionts/templates/pi/plugin.ts in the Myco repo instead.
// myco:plugin-marker:pi
//
// Myco Codebase Intelligence Extension for Pi.
//
// This extension runs inside pi's extension runtime (jiti) and communicates with
// the local Myco daemon over HTTP — no subprocess spawns, no hook CLI, no stdin piping.
//
//   Capture: POST /sessions/register, /sessions/unregister, /events, /events/stop
//   Context: POST /context, /context/resume, /context/prompt
//   Inject:  session_start → persistent custom message;
//            before_agent_start → per-prompt custom message (/context/prompt)
//
// See https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
//
// Degraded-mode safety: this extension is installed globally and therefore
// loads for every pi session on the machine — including in non-git folders or
// when the Myco daemon is down. Every path that would contact the Myco daemon
// gracefully no-ops when the daemon endpoint is absent or unreachable, so the
// extension becomes invisible rather than throwing. Do NOT add runtime imports
// from Myco packages — only use pi's own exports and Node.js built-ins.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, appendFileSync, mkdirSync, statSync, accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Keep in sync with `TOOL_OUTPUT_PREVIEW_CHARS` in src/constants.ts (currently 200).
 * The extension file is standalone and cannot import from Myco — this value is copied
 * so every symbiont records tool_output previews at the same length.
 */
const TOOL_OUTPUT_PREVIEW_CHARS = 200;

/** Timeout for daemon HTTP calls — must be short so we never block pi. */
const MYCO_FETCH_TIMEOUT_MS = 3000;

/** Max size of resume context injection to keep resumed sessions lean. */
const RESUME_CONTEXT_MAX_CHARS = 4000;

const MYCO_AUTH_HEADER = "x-myco-auth";

const REQUEST_CONTEXT_HEADERS = {
  projectRoot: "x-myco-project-root",
  projectId: "x-myco-project-id",
  sessionId: "x-myco-session-id",
} as const;

// ---------------------------------------------------------------------------
// Daemon HTTP transport
// ---------------------------------------------------------------------------

let cachedDaemonPort: { statePath: string; port: number | null } | undefined = undefined;

const RUNTIME_PIN_INSECURE_MODE_MASK = 0o022;

/**
 * Read a `runtime.home` pin only when it passes the same G7 trust check the
 * CLI shim uses (`checkRuntimeCommandTrust` in bin/runtime-redirect.cjs): a
 * group/other-writable or foreign-owned pin is refused so a hostile local user
 * can't redirect capture to a daemon they control. Returns the trimmed value
 * (an absolute home path) or null.
 */
function readTrustedPin(filePath: string): string | null {
  try {
    if (process.platform !== "win32") {
      const stat = statSync(filePath);
      const myUid = typeof process.getuid === "function" ? process.getuid() : null;
      if (myUid !== null && stat.uid !== myUid) return null;
      if ((stat.mode & 0o777) & RUNTIME_PIN_INSECURE_MODE_MASK) return null;
    }
    const raw = readFileSync(filePath, "utf-8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the `runtime.home` pin for a project: walk up from `directory` for a
 * project pin (`<dir>/.myco/runtime.home`), then the machine pin
 * (`~/.myco/runtime.home`). Mirrors the layered resolution in
 * bin/runtime-redirect.cjs. Returns the absolute home path or null.
 */
function readRuntimeHomePin(directory: string): string | null {
  let dir = resolve(directory);
  while (true) {
    const pin = readTrustedPin(join(dir, ".myco", "runtime.home"));
    if (pin) return expandTilde(pin);
    const parent = join(dir, "..");
    if (resolve(parent) === dir) break;
    dir = resolve(parent);
  }
  const machine = readTrustedPin(join(homedir(), ".myco", "runtime.home"));
  return machine ? expandTilde(machine) : null;
}

function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

/**
 * Resolve this project's Myco home — the daemon it routes to. A trusted
 * `runtime.home` pin wins so a dogfood project pinned to `~/.myco-dev` reads
 * `~/.myco-dev/service/daemon.json` instead of the prod `~/.myco`. Falls back
 * to `MYCO_HOME`, then the machine `~/.myco`.
 */
function resolveMycoHome(directory?: string): string {
  if (directory) {
    const pinned = readRuntimeHomePin(directory);
    if (pinned) return pinned;
  }
  const configured = process.env.MYCO_HOME?.trim();
  if (!configured) return join(homedir(), ".myco");
  return expandTilde(configured);
}

function projectUsesGrove(directory: string): boolean {
  try {
    const raw = readFileSync(join(directory, ".myco", "project.toml"), "utf-8");
    return /\[grove\][^\[]*\bid\s*=/.test(raw);
  } catch {
    return false;
  }
}

function readTomlString(raw: string, section: string, key: string): string | null {
  let currentSection: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header) {
      currentSection = header[1];
      continue;
    }
    if (currentSection !== section) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*["']([^"']*)["']/.exec(trimmed);
    if (match?.[1] === key) return match[2];
  }
  return null;
}

function buildRequestContextHeaders(directory: string): Record<string, string> {
  try {
    const raw = readFileSync(join(directory, ".myco", "project.toml"), "utf-8");
    const projectId = readTomlString(raw, "project", "id");
    if (!projectId) return {};
    return {
      [REQUEST_CONTEXT_HEADERS.projectRoot]: resolve(directory),
      [REQUEST_CONTEXT_HEADERS.projectId]: projectId,
      ...(process.env.MYCO_SESSION_ID ? { [REQUEST_CONTEXT_HEADERS.sessionId]: process.env.MYCO_SESSION_ID } : {}),
    };
  } catch {
    return {};
  }
}

function withRequestContextHeaders(directory: string, init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  const ctxHeaders = buildRequestContextHeaders(directory);
  let hasContextSwitchingHeader = false;
  for (const [key, value] of Object.entries(ctxHeaders)) {
    if (!headers.has(key)) headers.set(key, value);
    if (key === REQUEST_CONTEXT_HEADERS.projectId) hasContextSwitchingHeader = true;
  }
  // The daemon's request-context auth gate rejects context-switching
  // headers (x-myco-project-id, etc.) without the daemon-issued bearer
  // token. Read it from daemon.json (same file we read the port from).
  if (hasContextSwitchingHeader && !headers.has(MYCO_AUTH_HEADER)) {
    const token = readDaemonAuthTokenFromDisk(resolveDaemonStatePath(directory));
    if (token) headers.set(MYCO_AUTH_HEADER, token);
  }
  return { ...init, headers };
}

function resolveDaemonStatePath(directory: string): string {
  if (!projectUsesGrove(directory)) {
    return join(directory, ".myco", "daemon.json");
  }
  // One daemon per home: the HOME is the discriminator, the daemon always
  // lives under `service/`. A dogfood project pinned to a dev home via the
  // `runtime.home` pin reads that home's daemon — without this it would talk
  // to the prod daemon, which refuses cross-Grove access.
  return join(resolveMycoHome(directory), "service", "daemon.json");
}

function readDaemonPortFromDisk(statePath: string): number | null {
  try {
    const raw = readFileSync(statePath, "utf-8");
    const info = JSON.parse(raw) as { port?: number };
    return typeof info.port === "number" ? info.port : null;
  } catch {
    return null;
  }
}

function readDaemonAuthTokenFromDisk(statePath: string): string | null {
  try {
    const raw = readFileSync(statePath, "utf-8");
    const info = JSON.parse(raw) as { auth_token?: string };
    return typeof info.auth_token === "string" && info.auth_token.length > 0
      ? info.auth_token
      : null;
  } catch {
    return null;
  }
}

function getDaemonPort(directory: string): number | null {
  const statePath = resolveDaemonStatePath(directory);
  if (!cachedDaemonPort || cachedDaemonPort.statePath !== statePath) {
    cachedDaemonPort = { statePath, port: readDaemonPortFromDisk(statePath) };
  }
  return cachedDaemonPort.port;
}

function refreshDaemonPort(directory: string): number | null {
  const statePath = resolveDaemonStatePath(directory);
  cachedDaemonPort = { statePath, port: readDaemonPortFromDisk(statePath) };
  return cachedDaemonPort.port;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MYCO_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromDaemon(
  directory: string,
  urlPath: string,
  init?: RequestInit,
): Promise<Response | null> {
  const port = getDaemonPort(directory);
  if (!port) return null;
  const requestInit = withRequestContextHeaders(directory, init);

  const first = await fetchWithTimeout(`http://localhost:${port}${urlPath}`, requestInit);
  if (first) return first;

  // Retry once with a refreshed port — the daemon may have restarted.
  const freshPort = refreshDaemonPort(directory);
  if (!freshPort || freshPort === port) return null;
  return fetchWithTimeout(`http://localhost:${freshPort}${urlPath}`, requestInit);
}

async function postJson(
  directory: string,
  urlPath: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; data?: unknown }> {
  const res = await fetchFromDaemon(directory, urlPath, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res) return { ok: false };
  try {
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: true };
  }
}

// ---------------------------------------------------------------------------
// CLI tool dispatch — dispatches `tool call <name> --json --input <json>` by
// running the self-contained Myco binary directly (no `node`, no
// `launcher.cjs`); `cwd: directory` carries per-project tenancy.
//
// The binary is resolved via the same `runtime.command` pin layering the daemon
// and the CJS shims use — a project-scope pin found by a filesystem upward walk,
// then the machine pin, then bare `myco` on PATH. Invoking the binary directly
// (rather than `node ~/.myco/launcher.cjs`) is the form that works on a native,
// node-absent install and matches every other symbiont's hook/MCP transport.
//
// Pi has no native MCP transport, so Myco tools are dispatched through the
// CLI. Capture/
// lifecycle/context HTTP (postEventWithBuffer, postJson) is a separate concern
// and stays unchanged: those endpoints are universal symbiont infrastructure
// feeding the daemon's EventBuffer.
//
// Degraded mode: when Myco isn't installed locally the binary is absent
// (ENOENT) or the tool runtime is unavailable (non-zero exit); collapsing
// every failure mode to `{ ok: false }` lets the LLM see "tool unavailable"
// instead of an extension crash.
// ---------------------------------------------------------------------------

const MYCO_TOOL_TIMEOUT_MS = 10000;

interface ToolCliEnvelope {
  ok: boolean;
  tool?: string;
  result?: unknown;
  error?: { code: string; message: string };
}

// Managed-binary layout; mirrors scripts/managed-paths.mjs, which this
// extension cannot import (no-Myco-imports rule above). Agreement is gated by
// tests/symbionts/pi-binary-resolution.test.ts.
function managedBinaryPath(mycoHome: string): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(localAppData, "Myco", "bin", "myco.exe");
  }
  return join(mycoHome, "bin", "myco");
}

// A file that exists and (on POSIX) is executable; mode-0644 binaries fail.
function isRunnableBinary(candidate: string): boolean {
  try {
    const stat = statSync(candidate);
    if (!stat.isFile()) return false;
    if (process.platform !== "win32") accessSync(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Resolve the Myco binary to dispatch CLI tool calls, in the contract order
// (src/runtime/binary-resolution.ts, which the extension cannot import):
// project-scope `<dir>/.myco/runtime.command` pin by upward walk, then the
// machine pin, then the runnable managed binary, then the bare name. Every
// step uses ONE home — the directory-aware `resolveMycoHome(directory)`, so a
// `runtime.home`-pinned project's fallbacks come from its own home. All pin
// reads pass the G7 trust check. The bare name is the last resort: a
// GUI-launched agent's PATH need not contain it.
function resolveMycoBinary(directory: string): string {
  let dir = resolve(directory);
  while (true) {
    const pin = readTrustedPin(join(dir, ".myco", "runtime.command"));
    if (pin) return pin;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const home = resolveMycoHome(directory);
  const machinePin = readTrustedPin(join(home, "runtime.command"));
  if (machinePin) return machinePin;
  const managed = managedBinaryPath(home);
  if (isRunnableBinary(managed)) return managed;
  return process.platform === "win32" ? "myco.exe" : "myco";
}

async function execMycoTool(
  directory: string,
  toolName: string,
  input: unknown,
): Promise<{ ok: boolean; data?: unknown }> {
  const binary = resolveMycoBinary(directory);
  const inputJson = JSON.stringify(input ?? {});

  try {
    const { stdout } = await execFileP(
      binary,
      ["tool", "call", toolName, "--json", "--input", inputJson],
      {
        cwd: directory,
        timeout: MYCO_TOOL_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const envelope = JSON.parse(stdout) as ToolCliEnvelope;
    if (!envelope.ok) return { ok: false };
    return { ok: true, data: envelope.result };
  } catch {
    // ENOENT (binary absent — Myco not installed / not on PATH), non-zero exit
    // (tool error or runtime unavailable), JSON parse failure, timeout —
    // all collapse to the existing degraded-mode signal.
    return { ok: false };
  }
}

// <myco:shared-helpers>
// ---------------------------------------------------------------------------
// Shared plugin helpers — single source of truth for buffer/POST + batch kinds.
//
// This block is maintained in
//   src/symbionts/templates/_shared/plugin-helpers.ts.snippet
// and injected into each plugin file at install time by SymbiontInstaller.
// The plugin files on disk also carry an inline copy between the
// `// <myco:shared-helpers>` markers so they stay valid TypeScript for
// Vitest imports; a unit test enforces the inline copy matches the snippet.
//
// Contract: the snippet assumes the containing file has already defined
//   - `postJson(directory: string, path: string, body): Promise<{ok, data?}>`
//   - `resolveMycoHome(directory?: string): string` — the project's Myco home
//     (`~/.myco`, or a dev home when a trusted `runtime.home` pin redirects it)
//   - imports for `readFileSync`, `appendFileSync`, `mkdirSync`, `join`
//   - no other imports from the outer file
// and exposes
//   - `BATCH_KIND` constants + `BatchKind` type
//   - `readProjectAndGroveIds(directory)` — regex-extracts identity from project.toml
//   - `resolveBufferDir(directory)` — Grove-scoped buffer dir, null on miss
//   - `bufferEvent(dir, sessionId, event)` — best-effort JSONL append
//   - `isIgnoredResponse(data)` — true when daemon returned an "ignored" drop
//   - `shouldBufferPluginFallback(result, eventType)` — the buffer decision
//
// Export discipline: opencode's legacy-plugin loader throws on any module
// export that isn't a function, killing the whole plugin at load. Only
// FUNCTION exports may be added to this snippet (or to the plugin files).
//   - `postEventWithBuffer(dir, sessionId, event)` — live POST with buffer fallback
//
// DO NOT edit this block inside a plugin file directly — edit the snippet
// and run the installer (or rerun the template-sync test to update the
// inlined copy). Changes here apply to every plugin the next time it
// installs/updates.
// ---------------------------------------------------------------------------

/**
 * Discriminated vocabulary for `prompt_batches.kind`. Mirrors
 * `BATCH_KIND` in src/db/queries/batches.ts — plugins can't import daemon
 * code, so the constants are inlined here and kept in sync via the shared
 * snippet + its sync test.
 */
const BATCH_KIND = {
  INITIAL: "initial",
  STEERING: "steering",
  INTERRUPT: "interrupt",
} as const;
type BatchKind = typeof BATCH_KIND[keyof typeof BATCH_KIND];

/**
 * Read project + Grove identity from `<directory>/.myco/project.toml`.
 *
 * Returns `null` when the file is missing or the required fields can't be
 * found. Plugins run with a zero-runtime-dep constraint (the file may load
 * in a teammate's clone that has no Myco installed), so this uses regex
 * extraction rather than a TOML parser dependency.
 */
function readProjectAndGroveIds(directory: string): { projectId: string; groveId: string } | null {
  try {
    const raw = readFileSync(join(directory, ".myco", "project.toml"), "utf-8");
    // Section-anchored: `(?:(?!\n\[)[\s\S])*?` matches any char that is
    // NOT followed by a newline + `[` (next TOML section header). Without
    // this anchor the non-greedy `[\s\S]*?` would happily cross into
    // [grove] and return the wrong section's id if [project] lacks one.
    // /code-review finding C6.
    const projectMatch = raw.match(/\[project\](?:(?!\n\[)[\s\S])*?\bid\s*=\s*"([^"]+)"/);
    const groveMatch = raw.match(/\[grove\](?:(?!\n\[)[\s\S])*?\bid\s*=\s*"([^"]+)"/);
    if (!projectMatch || !groveMatch) return null;
    return { projectId: projectMatch[1]!, groveId: groveMatch[1]! };
  } catch {
    return null;
  }
}

/**
 * Resolve where to write a buffer file when the daemon is unreachable.
 *
 * Post-global-install (plan 38cff0752c919ffd §2), buffers live at
 * `~/.myco/groves/<groveId>/projects/<projectId>/buffer/`. The daemon's
 * reconciler scans only Grove-scoped buffer dirs at startup, so writes
 * to any other location would be orphaned.
 *
 * Returns the Grove-scoped path when project.toml carries the Grove +
 * project identity. Returns `null` when project.toml is missing —
 * brand-new projects the daemon has never seen have no resolvable
 * identity, and matching the daemon-side tenet in `buffer-location.ts`
 * we DROP the event rather than write to a non-canonical location. The
 * daemon will provision project.toml on its first received event, so
 * subsequent buffer fallbacks resolve correctly.
 */
function resolveBufferDir(directory: string): string | null {
  const ids = readProjectAndGroveIds(directory);
  if (!ids) return null;
  return join(resolveMycoHome(directory), "groves", ids.groveId, "projects", ids.projectId, "buffer");
}

/**
 * Append an event to the Grove-scoped buffer dir for replay by the
 * daemon's startup reconciler. On-disk shape intentionally matches
 * `src/capture/buffer.ts`'s EventBuffer — the plugin can't import it because
 * of the zero-runtime-dep constraint, so the protocol is the contract.
 */
function bufferEvent(
  directory: string,
  sessionId: string,
  event: Record<string, unknown>,
): void {
  try {
    const bufferDir = resolveBufferDir(directory);
    if (!bufferDir) return;  // Brand-new project, daemon never seen — drop the event rather than write to a non-canonical path.
    mkdirSync(bufferDir, { recursive: true });
    const filePath = join(bufferDir, `${sessionId}.jsonl`);
    // Strip session_id from the entry — it's encoded in the filename
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { session_id: _sid, ...payload } = event;
    const line = JSON.stringify({
      ...payload,
      timestamp: payload.timestamp ?? new Date().toISOString(),
    });
    appendFileSync(filePath, line + "\n");
  } catch {
    // Best-effort — never crash the host agent.
  }
}

/** True when the daemon returned 200 but signalled it dropped the event. */
function isIgnoredResponse(data: unknown): boolean {
  if (data === null || typeof data !== "object") return false;
  const ignored = (data as { ignored?: unknown }).ignored;
  return typeof ignored === "string" && ignored.length > 0;
}

/**
 * The plugin-side buffer-fallback decision over the daemon's `/events`
 * response contract. Mirrors `shouldBufferFallback` in
 * packages/myco/src/hooks/send-event.ts row for row:
 *
 *   - `!ok` (transport failure, timeout, non-2xx)        → BUFFER.
 *   - `ok` + `ignored` (any shape)                       → never buffer. A
 *     daemon's ignore is deliberate (capture rule, dedup, tombstone, gate
 *     rejection) — ignored ≠ lost, and buffering it re-creates the noise
 *     the gated-resurrection path exists to refuse.
 *   - `ok` + `persisted: true`                           → nothing.
 *   - `ok` + `persisted: false` + `buffered: true`       → nothing — the
 *     daemon-side append is the durable copy; re-buffering here is the
 *     double-buffer trap.
 *   - `ok` + `persisted: false` + `buffered` not true    → BUFFER. The one
 *     honest-fallback case: no persist AND no daemon-side copy.
 *   - `ok` with NO `persisted` field, `stop`             → BUFFER. The stop
 *     pipeline is queued by design and never reports a persist outcome
 *     (plugins buffer-before-POST on stop, so this row is mirror parity).
 *   - `ok` with NO `persisted` field, anything else      → nothing. A plain
 *     ok means the daemon processed the event.
 */
export function shouldBufferPluginFallback(
  result: { ok: boolean; data?: unknown },
  eventType: string | undefined,
): boolean {
  if (!result.ok) return true;
  const data = result.data;
  if (isIgnoredResponse(data)) return false;
  const persisted = data !== null && typeof data === "object"
    ? (data as { persisted?: unknown }).persisted
    : undefined;
  if (typeof persisted === "boolean") {
    if (persisted) return false;
    return (data as { buffered?: unknown }).buffered !== true;
  }
  return eventType === "stop";
}

/**
 * POST a capture event to the daemon, buffering to disk when the response
 * leaves no durable copy daemon-side (`shouldBufferPluginFallback`).
 *
 * A deliberate `ignored` is never buffered — a daemon that says "ignored"
 * did so deliberately (capture rule, dedup, tombstone), and buffering the
 * event re-creates the noise the gated-resurrection path exists to refuse.
 */
async function postEventWithBuffer(
  directory: string,
  sessionId: string,
  event: Record<string, unknown>,
): Promise<unknown> {
  const result = await postJson(directory, "/events", event);
  const eventType = typeof event.type === "string" ? event.type : undefined;
  if (shouldBufferPluginFallback(result, eventType)) {
    bufferEvent(directory, sessionId, event);
    return undefined;
  }
  return result.data;
}
// </myco:shared-helpers>

// ---------------------------------------------------------------------------
// Daemon API wrappers
// ---------------------------------------------------------------------------

/**
 * Cheap best-effort branch detection so pi session registrations carry the
 * same branch hint hook-based symbionts already supply. Failures (no Git,
 * stale repo, timeout) return undefined — the daemon handles authoritative
 * provenance capture asynchronously regardless.
 */
function detectGitBranch(directory: string): string | undefined {
  try {
    const out = execFileSync("git", ["-C", directory, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
      timeout: 1000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return out && out !== "HEAD" ? out : undefined;
  } catch {
    return undefined;
  }
}

async function mycoRegisterSession(
  directory: string,
  sessionId: string,
): Promise<void> {
  await postJson(directory, "/sessions/register", {
    session_id: sessionId,
    agent: "pi",
    branch: detectGitBranch(directory),
    started_at: new Date().toISOString(),
  });
}

async function mycoUnregisterSession(directory: string, sessionId: string): Promise<void> {
  await postJson(directory, "/sessions/unregister", { session_id: sessionId });
}

async function mycoPostUserPrompt(
  directory: string,
  sessionId: string,
  prompt: string,
  images: Array<{ data: string; mediaType: string }>,
  options: { kind?: BatchKind; parentPromptBatchId?: number | null } = {},
): Promise<{ batchId?: string }> {
  const kind: BatchKind = options.kind ?? BATCH_KIND.INITIAL;
  const parentPromptBatchId = options.parentPromptBatchId ?? null;
  const result = await postEventWithBuffer(directory, sessionId, {
    type: "user_prompt",
    session_id: sessionId,
    agent: "pi",
    prompt,
    kind,
    parent_prompt_batch_id: parentPromptBatchId,
    ...(images.length > 0 ? { images } : {}),
  });
  const batchId = (result as { batchId?: string } | undefined)?.batchId;
  return { batchId };
}

async function mycoPostToolUse(
  directory: string,
  sessionId: string,
  toolName: string,
  toolInput: unknown,
  toolOutput: string,
): Promise<void> {
  await postEventWithBuffer(directory, sessionId, {
    type: "tool_use",
    session_id: sessionId,
    agent: "pi",
    tool_name: toolName,
    tool_input: toolInput,
    output_preview: toolOutput,
  });
}

/**
 * Post a stop event, synchronously buffering to disk before the async POST.
 *
 * Two failure modes are mitigated here:
 *   1. Daemon unreachable — the buffered entry is replayed at the daemon's
 *      next startup reconcile (same as user_prompt / tool_use fallbacks).
 *   2. Pi process exits before the POST settles — `session_shutdown` fires
 *      on Ctrl+D/Ctrl+C/SIGHUP/SIGTERM, and Bun can tear the event loop
 *      down before awaited fetches complete. The buffered copy survives
 *      regardless.
 *
 * Duplicate work is harmless: the reconciler's setResponseSummary is
 * idempotent (writes only when the column is still NULL), so even if both
 * the live POST and the buffered replay succeed, the summary lands once.
 */
async function mycoPostStop(
  directory: string,
  sessionId: string,
  lastAssistantMessage: string | undefined,
): Promise<void> {
  const payload = {
    type: "stop" as const,
    session_id: sessionId,
    agent: "pi",
    last_assistant_message: lastAssistantMessage,
  };
  bufferEvent(directory, sessionId, payload);
  await postJson(directory, "/events/stop", payload);
}

async function fetchMycoSessionContext(
  directory: string,
  sessionId: string,
): Promise<string | null> {
  const result = await postJson(directory, "/context", { session_id: sessionId });
  if (!result.ok) return null;
  const data = result.data as { text?: string } | undefined;
  const text = data?.text?.trim() ?? "";
  return text.length > 0 ? text : null;
}

async function fetchMycoResumeContext(
  directory: string,
  sessionId: string,
  parentSessionId: string,
): Promise<string | null> {
  const result = await postJson(directory, "/context/resume", {
    session_id: sessionId,
    parent_session_id: parentSessionId,
  });
  if (!result.ok) return null;
  const data = result.data as { text?: string } | undefined;
  const text = data?.text?.trim() ?? "";
  if (!text || text.length > RESUME_CONTEXT_MAX_CHARS) return null;
  return text;
}

async function mycoPostCompact(
  directory: string,
  sessionId: string,
): Promise<void> {
  await postEventWithBuffer(directory, sessionId, {
    type: "pre_compact",
    session_id: sessionId,
    agent: "pi",
  });
}

async function mycoCortex(
  directory: string,
  input: { op?: string; tier?: number; id?: string; project_id?: string; path?: string },
): Promise<{ ok: boolean; data?: unknown }> {
  return execMycoTool(directory, "myco_cortex", input);
}

async function mycoSearch(
  directory: string,
  input: {
    query: string;
    type?: string;
    limit?: number;
    observation_type?: string;
    status?: string;
    since?: number;
    until?: number;
    language?: string;
  },
): Promise<{ ok: boolean; data?: unknown }> {
  return execMycoTool(directory, "myco_search", input);
}

async function mycoPlans(
  directory: string,
  input: {
    op?: string;
    id?: string;
    session?: string;
    session_id?: string;
    content?: string;
    source_path?: string;
    plan_key?: string;
    title?: string;
    status?: string;
    tags?: string[];
    limit?: number;
    force_remote?: boolean;
  },
): Promise<{ ok: boolean; data?: unknown }> {
  return execMycoTool(directory, "myco_plans", input);
}

async function mycoSessions(
  directory: string,
  input: {
    op?: string;
    id?: string;
    plan?: string;
    branch?: string;
    user?: string;
    since?: string;
    status?: string;
    limit?: number;
  },
): Promise<{ ok: boolean; data?: unknown }> {
  return execMycoTool(directory, "myco_sessions", input);
}

async function mycoSpores(
  directory: string,
  input: {
    op?: string;
    id?: string;
    content?: string;
    type?: string;
    observation_type?: string;
    status?: string;
    agent_id?: string;
    search?: string;
    limit?: number;
    offset?: number;
    old_spore_id?: string;
    new_spore_id?: string;
    source_spore_ids?: string[];
    consolidated_content?: string;
    tags?: string[];
    reason?: string;
  },
): Promise<{ ok: boolean; data?: unknown }> {
  return execMycoTool(directory, "myco_spores", input);
}

async function mycoSkills(
  directory: string,
  input: { op?: string; id?: string; status?: string; limit?: number },
): Promise<{ ok: boolean; data?: unknown }> {
  return execMycoTool(directory, "myco_skills", input);
}

async function mycoAgent(
  directory: string,
  input: { op?: string; id?: string; task?: string; agent_id?: string; limit?: number },
): Promise<{ ok: boolean; data?: unknown }> {
  return execMycoTool(directory, "myco_agent", input);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeToolOutput(output: unknown): string {
  if (typeof output !== "string") return "";
  return output.length > TOOL_OUTPUT_PREVIEW_CHARS
    ? output.slice(0, TOOL_OUTPUT_PREVIEW_CHARS) + "..."
    : output;
}

/**
 * Derive a stable session ID from pi's session file path.
 * Pi sessions are stored as JSONL files with UUID-based names
 * at ~/.pi/agent/sessions/<path-hash>/<timestamp>_<uuid>.jsonl.
 * We extract the filename (without extension) as the session ID.
 */
function deriveSessionId(sessionFile: string | null): string | null {
  if (!sessionFile) return null;
  const base = sessionFile.split("/").pop() ?? sessionFile;
  return base.replace(/\.jsonl$/, "");
}

/**
 * Extract text content from pi message content (string or content block array).
 */
function extractTextFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: { type?: string; text?: string }) => c.type === "text" && c.text)
    .map((c: { text: string }) => c.text)
    .join("\n");
}

/**
 * Extract images from a pi message content array.
 */
function extractImagesFromContent(content: unknown): Array<{ data: string; mediaType: string }> {
  if (!Array.isArray(content)) return [];
  return content
    .filter((c: { type?: string; data?: string; mimeType?: string }) =>
      c.type === "image" && c.data && c.mimeType)
    .map((c: { data: string; mimeType: string }) => ({
      data: c.data,
      mediaType: c.mimeType,
    }));
}

function formatToolOutput(data: unknown): string {
  if (typeof data === "string") return data;
  return JSON.stringify(data, null, 2);
}

function extractErrorMessage(data: unknown, fallback: string): string {
  if (typeof data === "string" && data.trim()) return data;
  if (data && typeof data === "object") {
    const error = (data as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
    if (error && typeof error === "object" && "message" in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) return message;
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let currentSessionId: string | null = null;
  let currentCwd: string = process.cwd();
  let lastAssistantMessage: string = "";
  // `currentParentBatchId` doubles as the in-flight signal: a non-null value
  // means the initial prompt of a turn has been captured and subsequent
  // `input` events are steering. `agent_end` resets it to null.
  let currentParentBatchId: number | null = null;

  // ── Session lifecycle ──────────────────────────────────────────────────

  pi.on("session_start", async (event, ctx) => {
    currentCwd = ctx.cwd;

    // Check if daemon is available — silent no-op if not
    if (!getDaemonPort(currentCwd)) return;

    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionId = deriveSessionId(sessionFile);
    if (!sessionId) return;

    currentSessionId = sessionId;
    lastAssistantMessage = "";

    const isResume = event.reason === "resume";
    const isFork = event.reason === "fork";

    // Register with the daemon
    await mycoRegisterSession(currentCwd, sessionId);

    // Fetch and inject context as a persistent custom message — the one
    // session-context injection for this session id (the daemon's
    // per-session dedup gate suppresses any repeat /context call).
    // Persisting it in session history means it survives compaction.
    // Resumed and forked sessions are NEW session ids to the daemon —
    // /context/resume records no cortex injection and a fork inherits
    // only the parent's (possibly stale, possibly compacted-away)
    // context message — so every entry path fetches the full session
    // context here; the resume recap rides in front of it.
    const contextParts: string[] = [];

    if (isResume && event.previousSessionFile) {
      const previousSessionId = deriveSessionId(event.previousSessionFile);
      if (previousSessionId) {
        const recap = await fetchMycoResumeContext(currentCwd, sessionId, previousSessionId);
        if (recap) contextParts.push(recap);
      }
    }
    const sessionContext = await fetchMycoSessionContext(currentCwd, sessionId);
    if (sessionContext) contextParts.push(sessionContext);
    const contextText = contextParts.length > 0 ? contextParts.join("\n\n") : null;

    if (contextText) {
      pi.sendMessage({
        customType: "myco-context",
        content: contextText,
        display: false,
      }, {
        deliverAs: "nextTurn",
      });
    }
  });

  pi.on("session_shutdown", async () => {
    if (!currentSessionId) return;

    await mycoPostStop(currentCwd, currentSessionId, lastAssistantMessage || undefined);
    await mycoUnregisterSession(currentCwd, currentSessionId);
    currentSessionId = null;
    lastAssistantMessage = "";
  });

  // ── User prompt capture + context injection ───────────────────────────
  //
  // Pi's extension event vocabulary (verified against @mariozechner/pi-coding-agent
  // types.d.ts):
  //   - `before_agent_start` fires once per turn after the user submits their
  //     prompt, carries the resolved `prompt` + `images` and the assembled
  //     `systemPrompt`. This is the canonical initial-prompt hook.
  //   - `input` fires for EVERY user submission — initial and mid-turn
  //     steering alike — carrying `text` + `images` + `source`. We subscribe
  //     to it only for steering (source: "interactive"/"rpc") while a turn is
  //     already in flight; the initial prompt is already captured via
  //     before_agent_start with its expanded form.
  //   - `queue_update` is session-internal and NOT exposed to extensions; the
  //     internal-only `queue_update` must not be subscribed to here.

  pi.on("before_agent_start", async (event, _ctx) => {
    if (!currentSessionId) return;

    const prompt = event.prompt ?? "";
    const images = extractImagesFromContent(event.images);
    if (prompt) {
      const result = await mycoPostUserPrompt(
        currentCwd,
        currentSessionId,
        prompt,
        images,
        { kind: BATCH_KIND.INITIAL },
      );
      if (result?.batchId != null) {
        currentParentBatchId = result.batchId;
      }
    }

    // Per-prompt spore/cortex context. Sequential after capture on purpose:
    // the daemon attaches the injection record to the batch the /events
    // POST above just created. Delivered as a custom message (not a
    // systemPrompt mutation, which pi resets every turn) so the injected
    // spores stay in the session history — the daemon excludes
    // already-injected spores for the rest of the session.
    if (prompt) {
      const result = await postJson(currentCwd, "/context/prompt", {
        prompt,
        session_id: currentSessionId,
      });
      const data = result.ok ? (result.data as { text?: string } | undefined) : undefined;
      const text = data?.text?.trim() ?? "";
      if (text) {
        return {
          message: {
            customType: "myco-prompt-context",
            content: text,
            display: false,
          },
        };
      }
    }
    return undefined;
  });

  pi.on("input", async (event) => {
    if (!currentSessionId) return;
    // Skip when no turn is running — the initial prompt will be captured
    // via before_agent_start, which also carries the post-expansion text.
    // `currentParentBatchId !== null` means before_agent_start already ran
    // and the initial prompt is captured; any further `input` event during
    // this window is mid-turn steering.
    if (currentParentBatchId === null) return;
    // Ignore extension-synthesized inputs (ours or other extensions'). Only
    // capture user-originated steering coming from the interactive TUI or
    // the RPC surface.
    if (event.source === "extension") return;
    const text = event.text ?? "";
    if (!text) return;
    const images = extractImagesFromContent(event.images);
    await mycoPostUserPrompt(
      currentCwd,
      currentSessionId,
      text,
      images,
      { kind: BATCH_KIND.STEERING, parentPromptBatchId: currentParentBatchId },
    );
  });

  // ── Tool use capture ───────────────────────────────────────────────────

  pi.on("tool_result", async (event) => {
    if (!currentSessionId) return;

    const toolName = event.toolName ?? "unknown";
    const toolInput = event.input ?? {};
    const rawOutput = Array.isArray(event.content)
      ? event.content
          .filter((c: { type?: string; text?: string }) => c.type === "text")
          .map((c: { text: string }) => c.text)
          .join("\n")
      : "";
    const toolOutput = summarizeToolOutput(rawOutput);

    // Fire-and-forget — don't block tool result processing
    mycoPostToolUse(currentCwd, currentSessionId, toolName, toolInput, toolOutput);
    return undefined;
  });

  // ── Track last assistant message ───────────────────────────────────────

  pi.on("message_end", async (event) => {
    if (!currentSessionId) return;
    if (event.message?.role === "assistant") {
      const text = extractTextFromContent(event.message.content);
      if (text) {
        lastAssistantMessage = text;
      }
    }
  });

  // ── Agent end → post stop for agentic loop completion ──────────────────
  //
  // Pi fires agent_end after each user prompt's agentic loop completes.
  // We post a stop event so the daemon can process the turn. session_shutdown
  // handles the final cleanup on exit.

  pi.on("agent_end", async () => {
    if (!currentSessionId) return;
    // Clear the in-flight marker so subsequent `input` events are treated
    // as a fresh initial prompt, not continued steering. This replaces the
    // earlier `turnInFlight = false` toggle — the batch id already encodes
    // the turn state.
    currentParentBatchId = null;
    await mycoPostStop(currentCwd, currentSessionId, lastAssistantMessage || undefined);
  });

  // ── Compaction hook — notify daemon of context compaction ──────────────

  pi.on("session_before_compact", async () => {
    if (!currentSessionId) return;
    await mycoPostCompact(currentCwd, currentSessionId);
    return undefined;
  });

  // ── /exit command — parity with other symbionts ───────────────────────
  //
  // Pi has no built-in `/exit`; users have to press Ctrl+D to trigger the
  // shutdown flow. Most other CLI agents accept `/exit` directly, and a
  // typed `/exit` otherwise falls through to before_agent_start as a
  // literal prompt (polluting the session). Registering it as an extension
  // command intercepts before the input pipeline reaches the agent and
  // drives Pi's own graceful shutdown.
  pi.registerCommand("exit", {
    description: "Exit Pi (parity with other agents; equivalent to Ctrl+D).",
    handler: async (_args, ctx) => {
      ctx.shutdown();
    },
  });

  // ── MCP tool proxies — expose the MCP-equivalent Myco surface in Pi ───
  //
  // Pi has no native MCP transport, so we mirror Myco's MCP tool names via
  // pi.registerTool() and proxy to the same daemon HTTP routes. This keeps
  // the injected Cortex guidance aligned with the tool names other symbionts
  // receive through the MCP server.

  pi.registerTool({
    name: "myco_search",
    label: "Myco Search",
    description:
      "Search the vault for prior sessions, spores, plans, skills, and Canopy file summaries.",
    promptSnippet: "Search Myco for prior decisions, bugs, rationale, sessions, plans, skills, or Canopy file summaries",
    promptGuidelines: [
      "Use myco_search when you need specific information about a topic, pattern, or past decision.",
      "Follow the retrieve hint on a result to fetch the full entity from its owning tool.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query — topic, pattern, or question" }),
      type: Type.Optional(Type.String({ description: "Optional type filter: session, plan, spore, skill, canopy, or all" })),
      limit: Type.Optional(Type.Number({ description: "Optional max results" })),
      observation_type: Type.Optional(Type.String({ description: "Optional spore observation type filter" })),
      status: Type.Optional(Type.String({ description: "Optional semantic status filter" })),
      since: Type.Optional(Type.Number({ description: "Optional created_at lower bound in epoch seconds" })),
      until: Type.Optional(Type.Number({ description: "Optional created_at upper bound in epoch seconds" })),
      language: Type.Optional(Type.String({ description: "Canopy-only optional language filter, e.g. typescript" })),
    }),
    async execute(_toolCallId, params) {
      const result = await mycoSearch(currentCwd, params);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: "Search unavailable — Myco daemon may not be running." }], details: {} };
      }
      return { content: [{ type: "text" as const, text: formatToolOutput(result.data ?? []) }], details: result.data ?? {} };
    },
  });

  pi.registerTool({
    name: "myco_cortex",
    label: "Myco Cortex",
    description: "Retrieve Cortex project intelligence: digest, instructions, Canopy map, or a Canopy entry.",
    promptSnippet: "Retrieve Cortex digest or Canopy data for project orientation",
    promptGuidelines: [
      "Use myco_cortex op digest for broad project orientation.",
      "Use myco_cortex op canopy_map as the default opener for project layout.",
      "Use myco_cortex op canopy_entry with retrieve hints returned by myco_search.",
    ],
    parameters: Type.Object({
      op: Type.Optional(Type.String({ description: "digest (default), instructions, canopy_map, or canopy_entry" })),
      tier: Type.Optional(Type.Number({ description: "Optional digest tier: 1500, 5000, or 10000" })),
      id: Type.Optional(Type.String({ description: "Canopy entry id for op=canopy_entry" })),
      project_id: Type.Optional(Type.String({ description: "Optional Canopy project id" })),
      path: Type.Optional(Type.String({ description: "Canopy path for op=canopy_entry" })),
    }),
    async execute(_toolCallId, params) {
      const result = await mycoCortex(currentCwd, params);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: extractErrorMessage(result.data, "Cortex data unavailable.") }], details: result.data ?? {} };
      }
      const data = result.data as { content?: unknown } | undefined;
      return { content: [{ type: "text" as const, text: typeof data?.content === "string" && (params.op ?? "digest") === "digest" ? data.content : formatToolOutput(result.data ?? {}) }], details: result.data ?? {} };
    },
  });

  pi.registerTool({
    name: "myco_plans",
    label: "Myco Plans",
    description: "List, retrieve, save, or delete implementation plans.",
    promptSnippet: "List, fetch, save, or delete Myco plans",
    promptGuidelines: [
      "Use myco_plans before creating a new plan or spec, or when existing plans may already cover the work.",
      "Use myco_plans op save when you create or materially revise a plan.",
    ],
    parameters: Type.Object({
      op: Type.Optional(Type.String({ description: "list (default), get, save, or delete" })),
      status: Type.Optional(Type.String({ description: "Optional list filter or saved plan status" })),
      id: Type.Optional(Type.String({ description: "Plan id for op=get/delete" })),
      session: Type.Optional(Type.String({ description: "Optional session id filter" })),
      session_id: Type.Optional(Type.String({ description: "Session id for op=save; defaults to the active Pi session" })),
      content: Type.Optional(Type.String({ description: "Markdown plan content for op=save" })),
      source_path: Type.Optional(Type.String({ description: "Plan file path when also written to disk" })),
      plan_key: Type.Optional(Type.String({ description: "Stable key for non-file-backed plans" })),
      title: Type.Optional(Type.String({ description: "Optional explicit title" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags" })),
      limit: Type.Optional(Type.Number({ description: "Optional max results" })),
      force_remote: Type.Optional(Type.Boolean({ description: "Allow delete to remove a plan owned by another machine" })),
    }),
    async execute(_toolCallId, params) {
      const op = params.op ?? "list";
      if ((op === "delete" || op === "get") && !params.id) {
        return { content: [{ type: "text" as const, text: `id is required for op: ${op}` }], details: {} };
      }
      const sessionId = params.session_id ?? currentSessionId;
      if (op === "save" && !sessionId) {
        return { content: [{ type: "text" as const, text: "No active session" }], details: {} };
      }
      if (op !== "delete" && params.id && params.session) {
        return { content: [{ type: "text" as const, text: "Pass either id or session, not both" }], details: {} };
      }
      const result = await mycoPlans(currentCwd, op === "save" ? { ...params, session_id: sessionId } : params);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: extractErrorMessage(result.data, "Plan operation failed") }], details: result.data ?? {} };
      }
      return { content: [{ type: "text" as const, text: formatToolOutput(result.data ?? (op === "delete" ? { ok: true } : [])) }], details: result.data ?? {} };
    },
  });

  pi.registerTool({
    name: "myco_sessions",
    label: "Myco Sessions",
    description: "List or retrieve coding sessions with summaries and metadata.",
    parameters: Type.Object({
      op: Type.Optional(Type.String({ description: "list (default) or get" })),
      id: Type.Optional(Type.String({ description: "Session id for op=get" })),
      plan: Type.Optional(Type.String({ description: "Optional plan filter" })),
      branch: Type.Optional(Type.String({ description: "Optional branch filter" })),
      user: Type.Optional(Type.String({ description: "Optional user filter" })),
      since: Type.Optional(Type.String({ description: "Optional ISO timestamp lower bound" })),
      status: Type.Optional(Type.String({ description: "Optional status filter" })),
      limit: Type.Optional(Type.Number({ description: "Optional max results" })),
    }),
    async execute(_toolCallId, params) {
      if ((params.op ?? "list") === "get" && !params.id) {
        return { content: [{ type: "text" as const, text: "id is required for op: get" }], details: {} };
      }
      const result = await mycoSessions(currentCwd, params);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: "Session query unavailable." }], details: {} };
      }
      return { content: [{ type: "text" as const, text: formatToolOutput(result.data ?? []) }], details: result.data ?? {} };
    },
  });

  pi.registerTool({
    name: "myco_skills",
    label: "Myco Skills",
    description: "List or inspect skills generated by Myco.",
    parameters: Type.Object({
      op: Type.Optional(Type.String({ description: "list (default) or get" })),
      id: Type.Optional(Type.String({ description: "Optional skill id or name for op=get" })),
      status: Type.Optional(Type.String({ description: "Optional status filter" })),
      limit: Type.Optional(Type.Number({ description: "Optional max results" })),
    }),
    async execute(_toolCallId, params) {
      if ((params.op ?? "list") === "get" && !params.id) {
        return { content: [{ type: "text" as const, text: "id is required for op: get" }], details: {} };
      }
      const result = await mycoSkills(currentCwd, params);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: "Skill lookup unavailable." }], details: {} };
      }
      return { content: [{ type: "text" as const, text: formatToolOutput(result.data ?? []) }], details: result.data ?? {} };
    },
  });

  pi.registerTool({
    name: "myco_spores",
    label: "Myco Spores",
    description: "List, retrieve, save, supersede, or consolidate durable knowledge spores.",
    promptSnippet: "Manage durable Myco spores",
    promptGuidelines: [
      "Use myco_spores op save to capture durable decisions, gotchas, discoveries, or bug fixes.",
      "Use myco_spores op get with retrieve hints returned by myco_search.",
      "Use myco_spores op supersede or consolidate when existing knowledge should be retired or merged.",
    ],
    parameters: Type.Object({
      op: Type.Optional(Type.String({ description: "list (default), get, save, supersede, or consolidate" })),
      id: Type.Optional(Type.String({ description: "Spore id for op=get" })),
      content: Type.Optional(Type.String({ description: "Observation content for op=save" })),
      type: Type.Optional(Type.String({ description: "Observation type for op=save" })),
      observation_type: Type.Optional(Type.String({ description: "Observation type filter or consolidated note type" })),
      status: Type.Optional(Type.String({ description: "Optional list status filter" })),
      agent_id: Type.Optional(Type.String({ description: "Optional agent id filter" })),
      search: Type.Optional(Type.String({ description: "Optional text filter" })),
      limit: Type.Optional(Type.Number({ description: "Optional max results" })),
      offset: Type.Optional(Type.Number({ description: "Optional list offset" })),
      old_spore_id: Type.Optional(Type.String({ description: "ID of the outdated spore" })),
      new_spore_id: Type.Optional(Type.String({ description: "ID of the replacement spore" })),
      source_spore_ids: Type.Optional(Type.Array(Type.String(), { description: "IDs of the spores to merge" })),
      consolidated_content: Type.Optional(Type.String({ description: "Merged comprehensive content" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Optional tags" })),
      reason: Type.Optional(Type.String({ description: "Optional reason" })),
    }),
    async execute(_toolCallId, params) {
      const result = await mycoSpores(currentCwd, params);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: extractErrorMessage(result.data, "Spore operation failed") }], details: result.data ?? {} };
      }
      return { content: [{ type: "text" as const, text: formatToolOutput(result.data ?? { ok: true }) }], details: result.data ?? {} };
    },
  });

  pi.registerTool({
    name: "myco_agent",
    label: "Myco Agent",
    description: "List agent runs or fetch a single run.",
    parameters: Type.Object({
      op: Type.Optional(Type.String({ description: "runs (default) or run" })),
      id: Type.Optional(Type.String({ description: "Run id for op=run" })),
      task: Type.Optional(Type.String({ description: "Optional task filter" })),
      agent_id: Type.Optional(Type.String({ description: "Optional agent id filter" })),
      limit: Type.Optional(Type.Number({ description: "Optional max results" })),
    }),
    async execute(_toolCallId, params) {
      if ((params.op ?? "runs") === "run" && !params.id) {
        return { content: [{ type: "text" as const, text: "id is required for op: run" }], details: {} };
      }
      const result = await mycoAgent(currentCwd, params);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: extractErrorMessage(result.data, "Run query failed") }], details: result.data ?? {} };
      }
      return { content: [{ type: "text" as const, text: formatToolOutput(result.data ?? {}) }], details: result.data ?? {} };
    },
  });
}
