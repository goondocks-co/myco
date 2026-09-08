/**
 * Myco extension for Pi.
 *
 * Pi already writes an append-only JSONL per session, so this extension writes
 * no transcript of its own: it hands Pi's own file to the Myco binary, which
 * ships it as byte deltas exactly as it does for every other harness. The
 * store stays Pi's and Myco's retention never touches it.
 *
 * The extension makes no network call. It writes nothing and runs `myco hook
 * <verb>`; the binary owns the credential, the spool, the server-held offset
 * and every refusal. With no binary installed the extension is inert.
 *
 * Pi has no MCP, so Myco's tools are registered natively — enumerated from
 * `myco tool list` at session start rather than declared here, so there is one
 * definition of a tool and a drifted copy cannot exist.
 */
// myco:plugin-marker — Myco owns this file; `myco remove` deletes it while it carries this line.
import { execFileSync } from "node:child_process";
import { accessSync, appendFileSync, closeSync, constants as fsConstants, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";

// <myco:shared-helpers>
// ---------------------------------------------------------------------------
// Shared plugin helpers — the whole of a native plugin's contact with Myco.
//
// This block is maintained in
//   src/symbionts/templates/_shared/plugin-helpers.ts.snippet
// and injected into each plugin file at install time by SymbiontInstaller.
// The plugin files on disk also carry an inline copy between the
// `// <myco:shared-helpers>` markers so they stay valid TypeScript for
// Vitest imports; a unit test enforces the inline copy matches the snippet.
//
// A plugin makes NO network call. It writes transcript lines and it runs the
// Myco binary's hook verbs. The binary owns credential resolution, the
// write-ahead spool, the offline latch, blob spill, the server-held offset and
// every refusal code; a second implementation of those inside a harness
// runtime would be a second member, and the wire contract only has one.
//
// Contract: the containing file has already defined imports for
//   `readFileSync`, `appendFileSync`, `mkdirSync`, `statSync`, `accessSync`,
//   `openSync`, `closeSync`, `writeSync`, `unlinkSync`,
//   `constants as fsConstants`, `join`, `dirname`, `resolve`, `homedir`,
//   `execFileSync`
// and nothing else from the outer file.
//
// Export discipline: opencode's legacy-plugin loader throws on any module
// export that isn't a function, killing the whole plugin at load. Only
// FUNCTION exports may be added to this snippet (or to the plugin files).
//
// DO NOT edit this block inside a plugin file directly — edit the snippet
// and run the installer (or rerun the template-sync test to update the
// inlined copy). Changes here apply to every plugin the next time it
// installs/updates.
// ---------------------------------------------------------------------------

/** Version of the transcript line format. A parser meeting an unknown value fails the segment. */
const MYCO_TRANSCRIPT_FORMAT = 1;

/** Ceiling on a hook subprocess, so a stalled binary never blocks the harness. */
const MYCO_HOOK_TIMEOUT_MS = 5000;

/**
 * Where the binary reads this install's credential, substituted at install
 * time exactly as a hook command's `--credential` flag is.
 *
 * Declared, never inferred from the environment: a plugin that guessed would
 * let an unrelated variable redirect capture to another Deployment. `registry`
 * is the installed default; a sandbox image renders `env`, which is the only
 * source that admits a loopback `http://` Deployment.
 */
const MYCO_CREDENTIAL_SOURCE = "{{mycoCredentialSource}}";

const RUNTIME_PIN_INSECURE_MODE_MASK = 0o022;

/**
 * Read a `runtime.home` or `runtime.command` pin only when it passes the same
 * trust check the CLI shim uses: a group/other-writable or foreign-owned pin is
 * refused, so a hostile local user cannot redirect capture to a runtime they
 * control. Returns the trimmed value or null.
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

function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

/**
 * The `runtime.home` pin for a project: a project pin found by walking up from
 * `directory`, then the machine pin. Returns an absolute path or null.
 */
function readRuntimeHomePin(directory: string): string | null {
  let dir = resolve(directory);
  while (true) {
    const pin = readTrustedPin(join(dir, ".myco", "runtime.home"));
    if (pin) return expandTilde(pin);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const machine = readTrustedPin(join(homedir(), ".myco", "runtime.home"));
  return machine ? expandTilde(machine) : null;
}

/**
 * This project's Myco home. A trusted `runtime.home` pin wins so a dogfood
 * project pinned to `~/.myco-dev` writes and reads there; then `MYCO_HOME`;
 * then `~/.myco`. Identity is the home, never a path this file guesses.
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

/**
 * Managed-binary layout; mirrors scripts/managed-paths.mjs, which a plugin
 * cannot import. Agreement is gated by tests/symbionts/pi-binary-resolution.test.ts.
 */
function managedBinaryPath(mycoHome: string): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
    return join(localAppData, "Myco", "bin", "myco.exe");
  }
  return join(mycoHome, "bin", "myco");
}

/** A file that exists and (on POSIX) is executable; mode-0644 binaries fail. */
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

/**
 * The Myco binary, in the contract order: project-scope `runtime.command` pin
 * by upward walk, then the machine pin, then the runnable managed binary, then
 * the bare name. Every step uses one home — the directory-aware
 * `resolveMycoHome(directory)` — so a pinned project's fallbacks come from its
 * own home. The bare name is the last resort: a GUI-launched agent's PATH need
 * not contain it.
 */
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

/**
 * Where this agent's plugin-written transcript lives. Must agree with the
 * agent's manifest `transcriptDiscovery` root, which declares the same
 * directory as `@memberHome/member/transcripts/<agent>`; a gate resolves both
 * and compares them.
 */
function transcriptPathFor(directory: string, agent: string, sessionId: string): string {
  return join(resolveMycoHome(directory), "member", "transcripts", agent, `${sessionId}.jsonl`);
}

/** How long a claim may go untouched before another instance may take the session. */
const CLAIM_STALE_MS = 15 * 60 * 1000;

/** How often a holder rewrites its claim while it is writing. */
const CLAIM_TOUCH_MS = 30 * 1000;

/**
 * Where a session's writer records that it holds the session.
 *
 * Beside the transcripts rather than among them: a lock is not a transcript
 * and must not be discovered, parsed or aged as one.
 */
function claimPathFor(directory: string, agent: string, sessionId: string): string {
  return join(resolveMycoHome(directory), "member", "claims", `${agent}-${sessionId}.lock`);
}

/**
 * Whether this instance is the one that speaks for this session.
 *
 * A project-local plugin and a global one can both load for one session, and
 * both are legitimately Myco's. Two participants would mint two prompt ids,
 * append two lines per turn under one transcript identity and inject two
 * context blocks — the doubling this design removes, arriving by install
 * topology instead. One instance holds the session; the others stay silent.
 *
 * The claim names a writer that is STILL WRITING, which is neither a file that
 * exists nor a pid that answers:
 *
 *   - Claiming by the transcript's existence hands every resumed session to
 *     nobody, since the runtime that reopens `--session`/`--resume` finds a
 *     file it did not create.
 *   - Claiming by a pid alone hands a session to nobody whenever that pid is
 *     recycled onto an unrelated live process, which on Linux takes hours on a
 *     busy machine, and the session then captures nothing for its whole life.
 *
 * So the holder rewrites its claim as it writes, and a claim left untouched
 * past `CLAIM_STALE_MS` is taken over whatever pid it names. A holder verifies
 * it still owns the claim before each append, so a takeover that guessed wrong
 * costs one writer rather than producing two.
 */
const claimedSessions = new Map<string, boolean>();
const claimTouchedAt = new Map<string, number>();

/** The pid a claim names, or null when the claim is absent or unreadable. */
function claimHolder(claimPath: string): { pid: number; at: number } | null {
  try {
    const [pid, at] = readFileSync(claimPath, "utf-8").trim().split(/\s+/);
    const parsed = Number.parseInt(pid, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) return null;
    return { pid: parsed, at: Number.parseInt(at ?? "0", 10) || 0 };
  } catch {
    return null;
  }
}

function writeClaim(claimPath: string): void {
  try {
    const handle = openSync(claimPath, "w");
    writeSync(handle, `${process.pid} ${Date.now()}`);
    closeSync(handle);
  } catch {
    // A claim that cannot be rewritten ages out and the session is taken over.
  }
}

function takeClaim(claimPath: string): boolean {
  try {
    const handle = openSync(claimPath, "wx");
    writeSync(handle, `${process.pid} ${Date.now()}`);
    closeSync(handle);
    return true;
  } catch {
    return false;
  }
}

function holdsSessionClaim(directory: string, agent: string, sessionId: string): boolean {
  const key = `${agent}-${sessionId}`;
  const held = claimedSessions.get(key);
  if (held !== undefined) return held;
  const claimPath = claimPathFor(directory, agent, sessionId);
  let claimed = false;
  try {
    mkdirSync(dirname(claimPath), { recursive: true, mode: 0o700 });
    claimed = takeClaim(claimPath);
    if (!claimed) {
      const holder = claimHolder(claimPath);
      // Stale beyond any gap a writing instance leaves, or naming nothing
      // readable: the session is free whatever pid is recorded.
      if (holder === null || Date.now() - holder.at > CLAIM_STALE_MS) {
        try { unlinkSync(claimPath); } catch { /* another instance took it first */ }
        claimed = takeClaim(claimPath);
      }
    }
  } catch {
    claimed = false;
  }
  claimedSessions.set(key, claimed);
  if (claimed) claimTouchedAt.set(key, Date.now());
  return claimed;
}

/**
 * Whether this instance still holds the session, rewriting its claim as it
 * goes. A holder whose claim now names another process stops writing: the
 * other instance took a session this one appeared to have abandoned, and two
 * writers under one transcript identity is the outcome being avoided.
 */
function keepsSessionClaim(directory: string, agent: string, sessionId: string): boolean {
  if (!holdsSessionClaim(directory, agent, sessionId)) return false;
  const key = `${agent}-${sessionId}`;
  const claimPath = claimPathFor(directory, agent, sessionId);
  const holder = claimHolder(claimPath);
  if (holder !== null && holder.pid !== process.pid) {
    claimedSessions.set(key, false);
    noteOnce(key, `another instance took session ${sessionId}; this one stops writing`);
    return false;
  }
  const touched = claimTouchedAt.get(key) ?? 0;
  if (Date.now() - touched >= CLAIM_TOUCH_MS) {
    writeClaim(claimPath);
    claimTouchedAt.set(key, Date.now());
  }
  return true;
}

/**
 * One line on stderr per session per subject.
 *
 * Capture that stops has to say so somewhere a person can find it. Repeating
 * it per record would bury the harness's own output, so each subject speaks
 * once for the session it concerns.
 */
const noted = new Set<string>();

function noteOnce(key: string, message: string): void {
  if (noted.has(key)) return;
  noted.add(key);
  try {
    process.stderr.write(`[myco] ${message}\n`);
  } catch {
    // A harness that closed stderr is not a reason to fail capture.
  }
}

/**
 * Append one record to the transcript.
 *
 * The `session` record must be written first and stay small: project
 * attribution reads the working directory from a bounded head of the file
 * (64 KiB, then its first 40 lines) and takes the first line where the
 * declared dot-path hits. A large or late first record makes every transcript
 * for this agent unattributable, and nothing announces it.
 */
function appendTranscriptLine(
  directory: string,
  agent: string,
  sessionId: string,
  record: Record<string, unknown>,
): void {
  if (!keepsSessionClaim(directory, agent, sessionId)) return;
  const filePath = transcriptPathFor(directory, agent, sessionId);
  try {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    appendFileSync(filePath, `${JSON.stringify({ v: MYCO_TRANSCRIPT_FORMAT, ...record })}\n`, "utf-8");
  } catch (error) {
    // Capture for this session is lost. It must never take the harness down
    // with it, and it must not be lost quietly.
    noteOnce(`write-${agent}-${sessionId}`, `cannot write ${filePath}: ${(error as Error)?.message ?? "unknown"} — this session is not captured`);
  }
}

/**
 * Run one Myco hook verb, handing it `payload` on stdin.
 *
 * The resolved home travels to the binary as `MYCO_HOME`. A spawned binary
 * resolves its own home from the environment and never walks the project's
 * `runtime.home` pin, so a pinned project would otherwise write its transcript
 * to the pinned home while the hook's spool, registry and retention used the
 * default one. One side resolves the home and tells the other. This mirrors
 * the same injection the installer makes for an MCP server entry, and for the
 * same reason.
 *
 * Returns the hook's parsed response, or null when Myco is not installed, the
 * binary fails, or the output is not the expected shape. Never throws and
 * never rejects: a capture path that breaks the host is worse than one that
 * captures nothing, and a plugin-only install legitimately has no binary.
 */
function runMycoHook(
  directory: string,
  agent: string,
  sessionId: string,
  verb: string,
  payload: Record<string, unknown>,
): { additionalContext?: string; promptId?: string } | null {
  // The instance that does not speak for this session runs nothing: a second
  // participant would spawn a second hook per turn, mint an id nothing uses
  // and place a second context block in front of the model.
  if (!holdsSessionClaim(directory, agent, sessionId)) return null;
  try {
    const stdout = execFileSync(
      resolveMycoBinary(directory),
      ["hook", verb, "--symbiont", agent, "--credential", MYCO_CREDENTIAL_SOURCE],
      {
        cwd: directory,
        env: { ...process.env, MYCO_HOME: resolveMycoHome(directory) },
        input: JSON.stringify(payload),
        timeout: MYCO_HOOK_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    const trimmed = typeof stdout === "string" ? stdout.trim() : "";
    if (!trimmed) return {};
    if (!trimmed.startsWith("{")) return { additionalContext: trimmed };
    return JSON.parse(trimmed) as { additionalContext?: string; promptId?: string };
  } catch (error) {
    noteOnce(`hook-${agent}-${sessionId}`, `could not run \`myco hook\`: ${(error as Error)?.message ?? "unknown"} — this session is not captured`);
    return null;
  }
}
// </myco:shared-helpers>

const AGENT = "pi";

/** Ceiling on a tool dispatch, longer than a hook because a tool does real work. */
const MYCO_TOOL_TIMEOUT_MS = 10000;

interface ToolCliEnvelope {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

interface ListedTool {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, { description?: string }>; required?: string[] };
}

/**
 * Pi's session id is the basename of its transcript minus the timestamp
 * prefix and extension, matching the id the manifest's discovery pattern
 * captures so both name one session.
 */
function deriveSessionId(transcriptPath: string): string {
  const base = basename(transcriptPath).replace(/\.jsonl$/, "");
  const underscore = base.indexOf("_");
  return underscore === -1 ? base : base.slice(underscore + 1);
}

/**
 * Every Myco tool the installed binary serves.
 *
 * Enumerated rather than declared: the binary answers from the same catalogue
 * the Deployment validates against, so a schema this file could drift from
 * does not exist. An absent binary yields no tools and the extension degrades
 * to capture alone.
 */
function listMycoTools(directory: string): ListedTool[] {
  try {
    const stdout = execFileSync(resolveMycoBinary(directory), ["tool", "list", "--json", "--credential", MYCO_CREDENTIAL_SOURCE], {
      cwd: directory,
      timeout: MYCO_TOOL_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(typeof stdout === "string" ? stdout : "");
    const tools = Array.isArray(parsed) ? parsed : parsed?.result;
    return Array.isArray(tools) ? (tools as ListedTool[]) : [];
  } catch {
    return [];
  }
}

/** Dispatch one Myco tool through the binary, degrading to an error result. */
function callMycoTool(directory: string, toolName: string, input: unknown): unknown {
  try {
    const stdout = execFileSync(
      resolveMycoBinary(directory),
      ["tool", "call", toolName, "--json", "--input", JSON.stringify(input ?? {}), "--credential", MYCO_CREDENTIAL_SOURCE],
      {
        cwd: directory,
        timeout: MYCO_TOOL_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const envelope = JSON.parse(typeof stdout === "string" ? stdout : "") as ToolCliEnvelope;
    if (!envelope.ok) return { error: envelope.error?.message ?? "tool call failed" };
    return envelope.result;
  } catch {
    return { error: "Myco is not available on this machine." };
  }
}

/**
 * A listed tool's schema as Pi wants it. Every property is accepted as an
 * optional string or object and the binary validates: re-deriving types here
 * would be the second copy this design exists to avoid.
 */
function schemaFor(tool: ListedTool) {
  const properties = tool.inputSchema?.properties ?? {};
  const shape: Record<string, ReturnType<typeof Type.Optional>> = {};
  for (const [key, prop] of Object.entries(properties)) {
    shape[key] = Type.Optional(Type.Any({ description: prop?.description }));
  }
  return Type.Object(shape);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default function (pi: any) {
  const directory = typeof pi?.cwd === "string" && pi.cwd ? pi.cwd : process.cwd();
  let registered = false;

  const registerTools = (): void => {
    if (registered) return;
    const listed = listMycoTools(directory);
    // A binary that could not answer leaves the tools unregistered and the
    // next session start tries again; latching on the attempt would disable
    // Myco's tools for the life of the process over one transient failure.
    if (listed.length === 0) return;
    registered = true;
    for (const tool of listed) {
      if (!tool?.name) continue;
      pi.registerTool({
        name: tool.name,
        description: tool.description ?? "",
        parameters: schemaFor(tool),
        execute: async (args: unknown) => callMycoTool(directory, tool.name, args),
      });
    }
  };

  pi.on("session_start", async (ctx: { sessionFile?: string }) => {
    registerTools();
    const transcriptPath = ctx?.sessionFile;
    if (!transcriptPath) return;
    const sessionId = deriveSessionId(transcriptPath);
    const answer = runMycoHook(directory, AGENT, sessionId, "session-start", {
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: directory,
    });
    if (answer?.additionalContext) {
      pi.sendMessage(
        { customType: "myco-context", content: answer.additionalContext, display: false },
        { deliverAs: "nextTurn" },
      );
    }
  });

  /**
   * Prompt submit: mint the id through the hook and hand the served block back
   * as a custom message. Pi writes the prompt into its own transcript, so
   * nothing is written here.
   */
  pi.on("before_agent_start", async (ctx: { sessionFile?: string; message?: { content?: string } }) => {
    const transcriptPath = ctx?.sessionFile;
    const text = ctx?.message?.content;
    if (!transcriptPath || typeof text !== "string" || !text.trim()) return undefined;
    const answer = runMycoHook(directory, AGENT, deriveSessionId(transcriptPath), "user-prompt-submit", {
      session_id: deriveSessionId(transcriptPath),
      transcript_path: transcriptPath,
      prompt: text,
      cwd: directory,
    });
    if (!answer?.additionalContext) return undefined;
    return { message: { customType: "myco-prompt-context", content: answer.additionalContext, display: false } };
  });

  /** Turn end: ship whatever Pi has appended to its transcript since the last pass. */
  pi.on("agent_end", async (ctx: { sessionFile?: string }) => {
    const transcriptPath = ctx?.sessionFile;
    if (!transcriptPath) return;
    runMycoHook(directory, AGENT, deriveSessionId(transcriptPath), "stop", {
      session_id: deriveSessionId(transcriptPath),
      transcript_path: transcriptPath,
      cwd: directory,
    });
  });

  pi.on("session_shutdown", async (ctx: { sessionFile?: string }) => {
    const transcriptPath = ctx?.sessionFile;
    if (!transcriptPath) return;
    runMycoHook(directory, AGENT, deriveSessionId(transcriptPath), "session-end", {
      session_id: deriveSessionId(transcriptPath),
      transcript_path: transcriptPath,
      cwd: directory,
    });
  });

  pi.on("session_before_compact", async (ctx: { sessionFile?: string }) => {
    const transcriptPath = ctx?.sessionFile;
    if (!transcriptPath) return;
    const answer = runMycoHook(directory, AGENT, deriveSessionId(transcriptPath), "post-compact", {
      session_id: deriveSessionId(transcriptPath),
      transcript_path: transcriptPath,
      cwd: directory,
    });
    if (answer?.additionalContext) {
      pi.sendMessage(
        { customType: "myco-context", content: answer.additionalContext, display: false },
        { deliverAs: "nextTurn" },
      );
    }
  });
}
