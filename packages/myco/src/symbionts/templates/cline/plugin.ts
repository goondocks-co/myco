/**
 * Myco plugin for Cline.
 *
 * Cline rewrites two whole-file JSON documents per session in place, so no
 * byte offset survives a turn and its own store cannot be shipped as a delta.
 * This plugin writes an append-only transcript instead, at
 * `<MYCO_HOME>/member/transcripts/cline/<sessionId>.jsonl`, and the Myco
 * binary ships it like any other harness's.
 *
 * The plugin makes no network call. It writes lines and it runs `myco hook
 * <verb>`; the binary owns the credential, the spool, the server-held offset
 * and every refusal. With no binary installed the plugin is inert.
 *
 * Cline is served at reduced tier: capture, tools over MCP, and injection at
 * session start and prompt submit.
 */
// myco:plugin-marker — Myco owns this file; `myco remove` deletes it while it carries this line.
import { execFileSync } from "node:child_process";
import { accessSync, appendFileSync, closeSync, constants as fsConstants, lstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

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
//   `readFileSync`, `appendFileSync`, `mkdirSync`, `statSync`, `lstatSync`,
//   `accessSync`,
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
 * trust check the CLI shim uses: a group/other-writable, foreign-owned or
 * symlinked pin is refused, so a hostile local user cannot redirect capture to
 * a runtime they control. The stat is an `lstat` — following a link would
 * report the target's owner and mode. Returns the trimmed value or null.
 */
function readTrustedPin(filePath: string): string | null {
  try {
    if (process.platform !== "win32") {
      const stat = lstatSync(filePath);
      if (stat.isSymbolicLink()) return null;
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
 * `directory` when one is given, then the machine pin. Returns an absolute
 * path or null.
 */
function readRuntimeHomePin(directory?: string): string | null {
  let dir = directory === undefined ? null : resolve(directory);
  while (dir !== null) {
    const pin = readAbsolutePin(join(dir, ".myco", "runtime.home"));
    if (pin) return pin;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return readAbsolutePin(join(homedir(), ".myco", "runtime.home"));
}

/**
 * A trusted pin whose value names an absolute path. A relative value would
 * resolve against whatever directory this process is standing in, so a
 * `runtime.home` committed into a repository would send capture — and the
 * binary this file execs — into a directory that repository controls.
 */
function readAbsolutePin(filePath: string): string | null {
  const raw = readTrustedPin(filePath);
  if (raw === null) return null;
  const expanded = expandTilde(raw);
  return expanded.startsWith("/") || /^[A-Za-z]:[\\/]/.test(expanded) ? expanded : null;
}

/**
 * This project's Myco home, in the binary's precedence (`src/paths/home.ts`):
 * an explicit `MYCO_HOME`, then a trusted project `runtime.home` pin found by
 * walking up from `directory`, then the machine pin, then `~/.myco`. A dogfood
 * project pinned to `~/.myco-dev` therefore writes and reads there without any
 * environment. Identity is the home, never a path this file guesses.
 *
 * The plugin resolves the home to FIND the binary, so it cannot ask the binary
 * for it; the two implementations are held to the same answers over one
 * fixture tree by tests/symbionts/plugin-home-agreement.test.ts.
 */
function resolveMycoHome(directory?: string): string {
  const configured = process.env.MYCO_HOME?.trim();
  if (configured) return expandTilde(configured);
  const pinned = readRuntimeHomePin(directory);
  if (pinned) return pinned;
  return join(homedir(), ".myco");
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

/**
 * How long a claim may go untouched before another instance may take the
 * session.
 *
 * The number is not what makes a takeover safe — a session idle longer than
 * this is an ordinary gap, and one will be taken over from a holder that is
 * still alive. What makes it safe is that every acting instance re-reads the
 * claim before it writes or spawns, so the displaced holder stops at its next
 * action and exactly one instance goes on speaking for the session.
 */
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
 *     A pid also cannot separate two plugin instances loaded into one harness
 *     process, which is the commonest pair of all.
 *
 * So the holder rewrites its claim as it writes, and a claim left untouched
 * past `CLAIM_STALE_MS` is taken over whatever pid it names. A holder verifies
 * it still owns the claim before each append, so a takeover that guessed wrong
 * costs one writer rather than producing two.
 */
const claimedSessions = new Map<string, boolean>();
const claimTouchedAt = new Map<string, number>();

/**
 * This module instance's identity.
 *
 * Not the pid: a project-local plugin and a global one load into ONE harness
 * process and share it, so a pid cannot tell the two apart — which is the very
 * pair a claim exists to arbitrate. Minted per load, so each instance is
 * distinguishable wherever it runs.
 */
const MYCO_INSTANCE_ID = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** The instance a claim names and when it last said so, or null when the claim is absent or unreadable. */
function claimHolder(claimPath: string): { instance: string; at: number } | null {
  try {
    const [instance, at] = readFileSync(claimPath, "utf-8").trim().split(/\s+/);
    if (!instance) return null;
    return { instance, at: Number.parseInt(at ?? "0", 10) || 0 };
  } catch {
    return null;
  }
}

function writeClaim(claimPath: string): void {
  try {
    const handle = openSync(claimPath, "w");
    writeSync(handle, `${MYCO_INSTANCE_ID} ${Date.now()}`);
    closeSync(handle);
  } catch {
    // A claim that cannot be rewritten ages out and the session is taken over.
  }
}

function takeClaim(claimPath: string): boolean {
  try {
    const handle = openSync(claimPath, "wx");
    writeSync(handle, `${MYCO_INSTANCE_ID} ${Date.now()}`);
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
 * goes. A holder whose claim now names another process stops: the other
 * instance took a session this one appeared to have abandoned, and two writers
 * under one transcript identity is the outcome being avoided.
 *
 * The claim is READ on every call and rewritten only on a cadence. Reading is
 * a few bytes; deferring it to the same cadence would let a displaced instance
 * go on writing and injecting for the rest of the interval, which is the
 * window this exists to close.
 */
function keepsSessionClaim(directory: string, agent: string, sessionId: string): boolean {
  if (!holdsSessionClaim(directory, agent, sessionId)) return false;
  const key = `${agent}-${sessionId}`;
  const claimPath = claimPathFor(directory, agent, sessionId);
  const holder = claimHolder(claimPath);
  if (holder !== null && holder.instance !== MYCO_INSTANCE_ID) {
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
 * The resolved home travels to the binary as `MYCO_HOME`. The binary walks the
 * same pin from the directory it is given, so both sides reach the same home on
 * their own; naming it here settles the one case where they could not — a
 * harness that moves the spawned process's working directory, which would leave
 * this file's transcript under the pinned home and the hook's spool, registry
 * and retention under whatever the new directory resolves. The side that has
 * already resolved a home says which one, and `MYCO_HOME` is what the binary
 * reads first.
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
  //
  // Re-checked rather than remembered, exactly as the write path is. An
  // instance displaced while idle would otherwise keep injecting from a memo
  // taken before it lost the session — and an agent whose transcript it never
  // writes, like Pi, would reach that state on every session, since a claim
  // taken once and never touched goes stale on its own.
  if (!keepsSessionClaim(directory, agent, sessionId)) return null;
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
    noteOnce(`hook-${agent}-${sessionId}`, `${agent} session ${sessionId}: could not run \`myco hook ${verb}\`: ${(error as Error)?.message ?? "unknown"} — this session is not captured`);
    return null;
  }
}
// </myco:shared-helpers>

const AGENT = "cline";

/** Marks a message this plugin injected, so it is never captured as a prompt. */
const MYCO_METADATA_MARKER = "myco";

/** Heading placed above injected context so the model sees a labelled block. */
const CONTEXT_HEADING = "## Myco - Project Context\n\n";

/**
 * Cline's model-facing user message wraps the real prompt in a mode envelope
 * while its session metadata keeps the clean text. The hook context exposes
 * the model-facing form, so the envelope is stripped at the boundary; the
 * server-side parser strips it again for anything that reaches it unstripped.
 */
const USER_INPUT_ENVELOPES: ReadonlyArray<{ open: string; close: string }> = [
  { open: '<user_input mode="act">', close: "</user_input>" },
  { open: '<user_input mode="plan">', close: "</user_input>" },
];

const sessions = new Map<string, { directory: string; started: boolean; promptId?: string; lastPrompt?: string }>();

function nowIso(): string {
  return new Date().toISOString();
}

function stripEnvelope(text: string): string {
  for (const { open, close } of USER_INPUT_ENVELOPES) {
    const trimmed = text.trim();
    if (trimmed.startsWith(open) && trimmed.endsWith(close)) {
      return trimmed.slice(open.length, trimmed.length - close.length).trim();
    }
  }
  return text;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isMycoMessage(message: any): boolean {
  return message?.metadata?.[MYCO_METADATA_MARKER] === true;
}

/** Open a session: the `session` record is written first so attribution can read the cwd from the head. */
function openSession(sessionId: string, directory: string): string | undefined {
  const state = sessions.get(sessionId);
  if (state?.started) return undefined;
  sessions.set(sessionId, { directory, started: true });
  appendTranscriptLine(directory, AGENT, sessionId, {
    type: "session",
    sessionId,
    agent: AGENT,
    cwd: directory,
    at: nowIso(),
  });
  const answer = runMycoHook(directory, AGENT, sessionId, "session-start", {
    conversationId: sessionId,
    transcript_path: transcriptPathFor(directory, AGENT, sessionId),
    cwd: directory,
  });
  return answer?.additionalContext;
}

export const MycoClinePlugin = {
  name: "myco",
  manifest: { capabilities: ["hooks"] },

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setup(_api: any, ctx: any) {
    const sessionId = ctx?.session?.sessionId;
    const directory = ctx?.workspaceInfo?.rootPath ?? process.cwd();
    if (sessionId) openSession(sessionId, directory);
  },

  hooks: {
    /**
     * Prompt submit: mint the id through the hook, write the prompt line, and
     * append the served block as a synthetic user message.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    beforeModel: async (request: any, ctx: any) => {
      const sessionId = ctx?.session?.sessionId ?? ctx?.conversationId;
      if (!sessionId) return undefined;
      const directory = ctx?.workspaceInfo?.rootPath ?? sessions.get(sessionId)?.directory ?? process.cwd();

      const startContext = openSession(sessionId, directory);

      const messages = Array.isArray(request?.messages) ? request.messages : [];
      const last = [...messages].reverse().find((m: { role?: string }) => m?.role === "user");
      if (isMycoMessage(last)) return undefined;
      const raw = typeof last?.content === "string" ? last.content : undefined;
      const text = raw ? stripEnvelope(raw) : undefined;

      const state = sessions.get(sessionId);
      let context = startContext;
      if (text && text.trim() && text !== state?.lastPrompt) {
        const answer = runMycoHook(directory, AGENT, sessionId, "user-prompt-submit", {
          conversationId: sessionId,
          transcript_path: transcriptPathFor(directory, AGENT, sessionId),
          prompt: text,
          cwd: directory,
        });
        sessions.set(sessionId, { directory, started: true, promptId: answer?.promptId, lastPrompt: text });
        appendTranscriptLine(directory, AGENT, sessionId, {
          type: "prompt",
          sessionId,
          promptId: answer?.promptId,
          text,
          origin: "human",
          at: nowIso(),
        });
        context = answer?.additionalContext ?? context;
      }

      if (!context) return undefined;
      return {
        messages: [
          ...messages,
          {
            role: "user",
            content: `${CONTEXT_HEADING}${context}`,
            metadata: { [MYCO_METADATA_MARKER]: true },
          },
        ],
      };
    },

    /** The assistant's turn becomes a transcript line; no subprocess runs here. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    afterModel: async (response: any, ctx: any) => {
      const sessionId = ctx?.session?.sessionId ?? ctx?.conversationId;
      if (!sessionId) return;
      const state = sessions.get(sessionId);
      const directory = state?.directory ?? ctx?.workspaceInfo?.rootPath ?? process.cwd();
      const text = typeof response?.content === "string" ? response.content : response?.text;
      if (typeof text !== "string" || !text.trim()) return;
      appendTranscriptLine(directory, AGENT, sessionId, {
        type: "response",
        sessionId,
        promptId: state?.promptId,
        text,
        at: nowIso(),
      });
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    afterTool: async (call: any, ctx: any) => {
      const sessionId = ctx?.session?.sessionId ?? ctx?.conversationId;
      if (!sessionId) return;
      const state = sessions.get(sessionId);
      const directory = state?.directory ?? ctx?.workspaceInfo?.rootPath ?? process.cwd();
      appendTranscriptLine(directory, AGENT, sessionId, {
        type: "tool",
        sessionId,
        promptId: state?.promptId,
        name: call?.name ?? call?.tool,
        input: call?.input ?? call?.args,
        output: typeof call?.output === "string" ? call.output : undefined,
        failed: call?.error !== undefined,
        at: nowIso(),
      });
    },

    /** Turn end: ship the delta this run appended. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    afterRun: async (_result: any, ctx: any) => {
      const sessionId = ctx?.session?.sessionId ?? ctx?.conversationId;
      if (!sessionId) return;
      const state = sessions.get(sessionId);
      const directory = state?.directory ?? ctx?.workspaceInfo?.rootPath ?? process.cwd();
      runMycoHook(directory, AGENT, sessionId, "stop", {
        conversationId: sessionId,
        transcript_path: transcriptPathFor(directory, AGENT, sessionId),
        cwd: directory,
      });
    },

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onEvent: async (event: any, snapshot: any) => {
      if (event?.type !== "run-started") return;
      const sessionId = snapshot?.conversationId ?? snapshot?.runId ?? snapshot?.agentId;
      if (!sessionId) return;
      openSession(sessionId, snapshot?.workspaceRoot ?? process.cwd());
    },
  },
};

export default MycoClinePlugin;
