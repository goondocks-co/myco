/**
 * Myco plugin for opencode.
 *
 * opencode stores a session as one JSON file per message and per part, so
 * there is no append-only byte stream to ship a delta against. This plugin
 * writes one instead: every in-process event becomes a line in
 * `<MYCO_HOME>/member/transcripts/<routing-key>/opencode/<sessionId>.jsonl`, and the Myco
 * binary ships that transcript exactly as it ships Claude Code's or Codex's.
 *
 * The plugin makes no network call. It writes lines and it runs `myco hook
 * <verb>`; the binary owns the credential, the write-ahead spool, the
 * server-held offset and every refusal. With no binary installed the plugin is
 * inert and the harness is unaffected.
 *
 * Zero runtime dependencies: the opencode plugin API is duck-typed rather than
 * imported so the file loads in a clone with nothing installed.
 */
// myco:plugin-marker — Myco owns this file; `myco remove` deletes it while it carries this line.
// myco:member-plugin — a global Myco plugin steps aside for a project that carries this line.
import { spawnSync } from "node:child_process";
import nodeFs from 'node:fs';
const { accessSync, appendFileSync, closeSync, fstatSync, readSync, renameSync, rmdirSync, readdirSync, constants: fsConstants, lstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } = nodeFs;
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
//   `openSync`, `closeSync`, `writeSync`, `unlinkSync`, `fstatSync`, `readSync`,
//   `renameSync`, `rmdirSync`, `readdirSync`,
//   `constants as fsConstants`, `join`, `dirname`, `resolve`, `homedir`,
//   `spawnSync`
// and nothing else from the outer file.
//
// Export discipline: opencode's legacy-plugin loader throws on any module
// export that isn't a function, killing the whole plugin at load. Only
// FUNCTION exports may be added to this snippet (or to the plugin files).
//
// DO NOT edit this block inside a plugin file directly — edit the snippet
// and run `node packages/myco/scripts/gen-templates.mjs` to update every
// inlined copy and the bundled templates. Changes here apply to every plugin the next time it
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
function readTrustedPin(filePath: string, projectPin = false): string | null {
  try {
    if (process.platform !== "win32") {
      const stat = lstatSync(filePath);
      if (stat.isSymbolicLink()) return null;
      const myUid = typeof process.getuid === "function" ? process.getuid() : null;
      if (myUid !== null && stat.uid !== myUid) return null;
      if ((stat.mode & 0o777) & RUNTIME_PIN_INSECURE_MODE_MASK) return null;
    }
    const raw = readFileSync(filePath, "utf-8").trim();
    if (projectPin && raw && !projectPinIsTrusted(filePath)) return null;
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
    const pin = readAbsolutePin(join(dir, ".myco", "runtime.home"), resolve(dir) !== homedir());
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
function readAbsolutePin(filePath: string, projectPin = false): string | null {
  const raw = readTrustedPin(filePath, projectPin);
  if (raw === null) return null;
  const expanded = expandTilde(raw);
  return expanded.startsWith("/") || /^[A-Za-z]:[\\/]/.test(expanded) ? expanded : null;
}

/**
 * This project's Myco home, in the binary's precedence (`src/paths/home.ts`):
 * an explicit `MYCO_HOME`, then a trusted project `runtime.home` pin found by
 * walking up from `directory`, then the machine pin, then `~/.myco`. A pinned
 * project reads and writes its selected home without an environment override.
 * Identity is the home, never a path this file guesses.
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
    const pin = readTrustedPin(join(dir, ".myco", "runtime.command"), resolve(dir) !== homedir());
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
 * agent's manifest `transcriptDiscovery` pattern, which names the same
 * routing key and agent beneath `@memberHome/member/transcripts`.
 */
const verifiedRoutingKeys = new Map<string, string>();

function routingKeyFor(directory: string, refresh = true): string | null {
  const held = verifiedRoutingKeys.get(directory);
  if (!refresh && held !== undefined) return held;
  try {
    const run = spawnSync(
      resolveMycoBinary(directory),
      ["member", "routing-key", "--credential", MYCO_CREDENTIAL_SOURCE, "--root", directory],
      {
        cwd: directory,
        env: { ...process.env, MYCO_HOME: resolveMycoHome(directory) },
        timeout: MYCO_HOOK_TIMEOUT_MS,
        maxBuffer: 1024,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const key = typeof run.stdout === "string" ? run.stdout.trim() : "";
    if (run.status === 0 && /^[0-9a-f]{16}\/(?:[A-Za-z0-9._-]{1,64}|~pending-[0-9a-f]{32})$/.test(key)
      && !key.endsWith("/.") && !key.endsWith("/..")) { verifiedRoutingKeys.set(directory, key); return key; }
  } catch { /* An unavailable binary cannot name a capture destination. */ }
  if (held !== undefined) {
    noteOnce(`routing-refresh-${directory}`, `${directory}: routing refresh unavailable — capture remains pinned to its verified destination`);
    return held;
  }
  noteOnce(`routing-${directory}`, `${directory}: could not resolve the member routing key — this session is not captured`);
  return null;
}

function transcriptPathFor(directory: string, agent: string, sessionId: string, routingKey = routingKeyFor(directory)): string | null {
  return routingKey === null ? null : join(resolveMycoHome(directory), "member", "transcripts", routingKey, agent, `${sessionId}.jsonl`);
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

type CaptureStatus = "committed" | "refused" | "failed";
type HookAnswer = { additionalContext?: string; promptId?: string };
type CaptureResult = { status: CaptureStatus; answer?: HookAnswer };

// <myco:capture-store>
interface WriterClaim { instance: string; at: number; born?: number }

type PluginCaptureStatus = "committed" | "refused" | "failed";

interface PluginCaptureOptions {
  fileSystem?: typeof nodeFs;
  note: (key: string, message: string) => void;
  home: (directory: string) => string;
  routing: (directory: string, refresh?: boolean) => string | null;
  transcript: (directory: string, agent: string, sessionId: string, routingKey?: string | null) => string | null;
  format: number;
  released?: (claimPath: string) => void;
  retained?: (directory: string, agent: string, sessionId: string) => void;
  captured?: (claimPath: string, record: Record<string, unknown>) => void;
}

/** The mutation gate and durable raw capture owned by a plugin session. */
function createPluginCaptureStore(options: PluginCaptureOptions) {
  type CaptureStatus = PluginCaptureStatus;
  const fileSystem = options.fileSystem ?? nodeFs;
  const noteOnce = options.note;
  const resolveMycoHome = options.home;
  const routingKeyFor = options.routing;
  const transcriptPathFor = options.transcript;
  const MYCO_TRANSCRIPT_FORMAT = options.format;
  const CLAIM_STALE_MS = 15 * 60 * 1000;

  const CLAIM_TOUCH_MS = 30 * 1000;

  const CLAIM_RECHECK_MS = 1000;

  const CLAIM_GATE_WAIT_MS = 25;
  const CLAIM_GATE_RETRY_MS = 1;
  const claimGateWaiter = new Int32Array(new SharedArrayBuffer(4));

  function claimPathFor(directory: string, agent: string, sessionId: string, routingKey = routingKeyFor(directory)): string | null {
    return routingKey === null ? null : join(resolveMycoHome(directory), "member", "claims", routingKey, `${agent}-${sessionId}.lock`);
  }

  const claimedSessions = new Map<string, boolean>();
  const claimRecheckAt = new Map<string, number>();
  const claimTouchedAt = new Map<string, number>();
  const heldClaimPaths = new Map<string, string>();

  const MYCO_INSTANCE_ID = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  const activeClaimGates = new Set<string>();
  const pendingClaimGateCleanup = new Map<string, string>();
  let claimGateOrdinal = 0;

  function removeClaimGate(gate: string, token: string): void {
    try { fileSystem.unlinkSync(join(gate, token)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { fileSystem.rmdirSync(gate); }
    catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }

  function recoverClaimGate(gate: string): void {
    let tokens: string[];
    try { tokens = fileSystem.readdirSync(gate); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (tokens.length === 0) {
      try { fileSystem.rmdirSync(gate); }
      catch (error) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
      return;
    }
    if (tokens.length !== 1) return;
    const token = tokens[0];
    const match = /^owner-(\d+)-/.exec(token);
    if (!match || Number(match[1]) <= 0) return;
    const birth = /^owner-\d+-birth-(\d+(?:\.\d+)?)-/.exec(token)?.[1];
    if (birth !== undefined) {
      if (writerStatus({ instance: `${match[1]}-gate`, at: 0, born: Number(birth) }) === "dead") removeClaimGate(gate, token);
      return;
    }
    try { process.kill(Number(match[1]), 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") removeClaimGate(gate, token);
    }
  }

  function withClaimGate<T>(claimPath: string, denied: T, operation: () => T): T {
    if (activeClaimGates.has(claimPath)) return operation();
    const gate = `${claimPath}.operation`;
    const cleanupToken = pendingClaimGateCleanup.get(claimPath);
    if (cleanupToken !== undefined) {
      removeClaimGate(gate, cleanupToken);
      pendingClaimGateCleanup.delete(claimPath);
    }
    const token = `owner-${process.pid}-${PROCESS_BORN_AT === undefined ? "unverified" : `birth-${PROCESS_BORN_AT}`}-${MYCO_INSTANCE_ID}-${++claimGateOrdinal}`;
    const prepared = `${gate}.${token}`;
    fileSystem.mkdirSync(dirname(claimPath), { recursive: true, mode: 0o700 });
    fileSystem.mkdirSync(prepared, { mode: 0o700 });
    try {
      const handle = fileSystem.openSync(join(prepared, token), "wx", 0o600);
      fileSystem.closeSync(handle);
      const deadline = performance.now() + (claimedSessions.get(claimPath) === true ? CLAIM_GATE_WAIT_MS : 0);
      for (let attempt = 0; attempt < 2 || performance.now() < deadline; attempt += 1) {
        try { fileSystem.renameSync(prepared, gate); }
        catch (error) {
          if (!["ENOTEMPTY", "EEXIST", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
          recoverClaimGate(gate);
          if (attempt > 0 && performance.now() < deadline) Atomics.wait(claimGateWaiter, 0, 0, CLAIM_GATE_RETRY_MS);
          continue;
        }
        activeClaimGates.add(claimPath);
        try { return operation(); }
        finally {
          activeClaimGates.delete(claimPath);
          pendingClaimGateCleanup.set(claimPath, token);
          try {
            removeClaimGate(gate, token);
            pendingClaimGateCleanup.delete(claimPath);
          } catch (error) {
            noteOnce(`gate-cleanup-${claimPath}`, `cannot release writer operation for ${claimPath} (${(error as Error)?.message ?? "unknown"}); cleanup retries on the next action`);
          }
        }
      }
      noteOnce(`gate-wait-${claimPath}`, `writer operation for ${claimPath} is busy; this action could not acquire it`);
      return denied;
    } finally {
      removeClaimGate(prepared, token);
    }
  }

  const proofCache = new Map<number, { until: number; birth: number | undefined }>();
  const PROCESS_BIRTH_PRECISION_MS = 1000;
  const PROCESS_PROBE_TIMEOUT_MS = 2000;

  function processBirth(pid: number): number | undefined {
    const cached = proofCache.get(pid);
    if (cached !== undefined && performance.now() < cached.until) return cached.birth;
    const probe = process.platform === "win32"
      ? spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString('o')`], { encoding: "utf8", timeout: PROCESS_PROBE_TIMEOUT_MS })
      : spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: PROCESS_PROBE_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C" } });
    const value = Date.parse(probe.stdout?.trim() ?? "");
    const birth = probe.status === 0 && Number.isFinite(value) ? value : undefined;
    proofCache.set(pid, { until: performance.now() + CLAIM_RECHECK_MS, birth });
    return birth;
  }
  const PROCESS_BORN_AT = processBirth(process.pid);

  function writerStatus(holder: WriterClaim): "live" | "dead" | "unknown" {
    const pid = Number(/^(\d+)-/.exec(holder.instance)?.[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || holder.born === undefined) return "unknown";
    try { process.kill(pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown"; }
    const birth = pid === process.pid ? PROCESS_BORN_AT : processBirth(pid);
    if (birth === undefined) return "unknown";
    return birth > holder.born + PROCESS_BIRTH_PRECISION_MS ? "dead" : "live";
  }

  function claimHolder(claimPath: string): WriterClaim | null {
    try {
      const [instance, at, born] = fileSystem.readFileSync(claimPath, "utf-8").trim().split(/\s+/);
      if (!instance) return null;
      return { instance, at: Number.parseInt(at ?? "0", 10) || 0, ...(born !== undefined && Number.isFinite(Number(born)) ? { born: Number(born) } : {}) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  function writeClaim(claimPath: string): void {
    const handle = fileSystem.openSync(claimPath, "w", 0o600);
    try { fileSystem.writeSync(handle, `${MYCO_INSTANCE_ID} ${Date.now()}${PROCESS_BORN_AT === undefined ? "" : ` ${PROCESS_BORN_AT}`}`); }
    finally { fileSystem.closeSync(handle); }
  }

  function takeClaim(claimPath: string): boolean {
    let handle: number;
    try { handle = fileSystem.openSync(claimPath, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
    try { fileSystem.writeSync(handle, `${MYCO_INSTANCE_ID} ${Date.now()}${PROCESS_BORN_AT === undefined ? "" : ` ${PROCESS_BORN_AT}`}`); }
    finally { fileSystem.closeSync(handle); }
    return true;
  }

  function holdsSessionClaim(directory: string, agent: string, sessionId: string, routingKey = routingKeyFor(directory)): boolean {
    const claimPath = claimPathFor(directory, agent, sessionId, routingKey);
    if (claimPath === null) return false;
    if (claimedSessions.get(claimPath) === true) return true;
    if (performance.now() < (claimRecheckAt.get(claimPath) ?? 0)) return false;
    let claimed = false;
    try {
      claimed = withClaimGate(claimPath, false, () => {
        if (takeClaim(claimPath)) return true;
        const holder = claimHolder(claimPath);
        if (holder?.instance === MYCO_INSTANCE_ID) return true;
        if (holder !== null && Date.now() - holder.at <= CLAIM_STALE_MS && writerStatus(holder) !== "dead") return false;
        try { fileSystem.unlinkSync(claimPath); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        return takeClaim(claimPath);
      });
    } catch (error) {
      noteOnce(`claim-error-${claimPath}`, `${agent} session ${sessionId}: cannot acquire its claim (${(error as Error)?.message ?? "unknown"})`);
    }
    claimedSessions.set(claimPath, claimed);
    if (claimed) {
      claimRecheckAt.delete(claimPath);
      claimTouchedAt.set(claimPath, performance.now());
      heldClaimPaths.set(claimPath, claimPath);
      releaseClaimsWhenProcessEnds();
    } else {
      claimRecheckAt.set(claimPath, performance.now() + CLAIM_RECHECK_MS);
      noteOnce(`claim-wait-${claimPath}`, `${agent} session ${sessionId}: waiting for its writer claim; acquisition retries on later actions`);
    }
    return claimed;
  }

  let claimExitHookInstalled = false;
  function releaseClaimsWhenProcessEnds(): void {
    if (claimExitHookInstalled) return;
    claimExitHookInstalled = true;
    try {
      process.once("exit", () => {
        for (const [key, claimPath] of heldClaimPaths) {
          try {
            withClaimGate(claimPath, undefined, () => {
              if (claimHolder(claimPath)?.instance === MYCO_INSTANCE_ID) fileSystem.unlinkSync(claimPath);
            });
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
            noteOnce(`exit-${key}`, `could not give up the claim on ${key} at exit (${(error as Error)?.message ?? "unknown"}) — retained capture waits for verified writer recovery`);
          }
        }
      });
    } catch (error) {
      noteOnce("exit-hook", `could not register the exit hook (${(error as Error)?.message ?? "unknown"}) — retained claims carry their process birth proof for recovery`);
    }
  }

  function keepsSessionClaim(directory: string, agent: string, sessionId: string, routingKey = routingKeyFor(directory)): boolean {
    const claimPath = claimPathFor(directory, agent, sessionId, routingKey);
    if (routingKey === null || claimPath === null || !holdsSessionClaim(directory, agent, sessionId, routingKey)) return false;
    const key = claimPath;
    const holder = claimHolder(claimPath);
    if (holder?.instance !== MYCO_INSTANCE_ID) {
      claimedSessions.set(key, false);
      claimRecheckAt.set(key, performance.now() + CLAIM_RECHECK_MS);
      claimTouchedAt.delete(key);
      heldClaimPaths.delete(key);
      noteOnce(key, `another instance took session ${sessionId}; this one stops writing`);
      return false;
    }
    const touched = claimTouchedAt.get(key) ?? 0;
    if (performance.now() - touched >= CLAIM_TOUCH_MS) {
      writeClaim(claimPath);
      claimTouchedAt.set(key, performance.now());
    }
    return true;
  }

  function releaseSessionClaim(directory: string, agent: string, sessionId: string): void {
    for (const [key, claimPath] of heldClaimPaths) {
      if (!claimPath.endsWith(`/${agent}-${sessionId}.lock`) && !claimPath.endsWith(`\\${agent}-${sessionId}.lock`)) continue;
      try {
        const released = withClaimGate(claimPath, false, () => {
          if (claimHolder(claimPath)?.instance === MYCO_INSTANCE_ID) fileSystem.unlinkSync(claimPath);
          return true;
        });
        if (!released) continue;
        claimedSessions.delete(key);
        claimRecheckAt.delete(key);
        claimTouchedAt.delete(key);
        heldClaimPaths.delete(key);
        options.released?.(claimPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
        noteOnce(`release-${key}`, `${agent} session ${sessionId}: could not give up its claim (${(error as Error)?.message ?? "unknown"}) — retained capture waits for verified writer recovery`);
      }
    }
  }

  function appendRaw(file: string, record: Record<string, unknown>, committed: () => void, mode: 'a+' | 'wx' = 'a+'): void {
    fileSystem.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const handle = fileSystem.openSync(file, mode, 0o600);
    try {
      const size = fileSystem.fstatSync(handle).size;
      const tail = Buffer.alloc(1);
      const unfinished = size > 0 && fileSystem.readSync(handle, tail, 0, 1, size - 1) === 1 && tail[0] !== 0x0a;
      fileSystem.appendFileSync(handle, `${unfinished ? "\n" : ""}${JSON.stringify({ v: MYCO_TRANSCRIPT_FORMAT, ...record })}\n`, "utf8");
      committed();
      if (unfinished) noteOnce(`tail-${file}-${size}`, `${file}: isolated an unfinished capture tail at byte ${size}`);
    } finally { fileSystem.closeSync(handle); }
  }

  const IMMUTABLE_CAPTURE = "immutable-v1";
  let pendingCaptureOrdinal = 0;
  const replayingCapture = new Set<string>();
  const replayedCaptureSizes = new Map<string, number>();

  function retainPendingCapture(directory: string, agent: string, sessionId: string, record: Record<string, unknown>): CaptureStatus {
    const routingKey = routingKeyFor(directory, false);
    const claimPath = claimPathFor(directory, agent, sessionId, routingKey);
    if (claimPath === null) return "refused";
    try {
      const holder = claimHolder(claimPath);
      if (holder !== null && holder.instance !== MYCO_INSTANCE_ID && writerStatus(holder) === "live") return "refused";
      const pendingDir = `${claimPath}.pending`;
      fileSystem.mkdirSync(pendingDir, { recursive: true, mode: 0o700 });
      const ordinal = ++pendingCaptureOrdinal;
      const file = join(pendingDir, `${MYCO_INSTANCE_ID}-${String(ordinal).padStart(16, "0")}.jsonl`);
      let committed = false;
      try {
        appendRaw(file, { ...record, _captureSnapshot: IMMUTABLE_CAPTURE, _captureScope: { directory, agent, sessionId }, captureId: typeof record.captureId === "string" ? record.captureId
          : record.type === "prompt" && typeof record.submissionId === "string" ? `submission-${record.submissionId}` : `${MYCO_INSTANCE_ID}-${ordinal}` }, () => { committed = true; }, "wx");
      } catch (error) {
        if (!committed) throw error;
        noteOnce(`pending-close-${file}`, `${file}: capture retained; descriptor cleanup failed (${(error as Error).message})`);
      }
      options.retained?.(directory, agent, sessionId);
      noteOnce(`pending-${claimPath}`, `${agent} session ${sessionId}: capture retained pending writer verification`);
      return "committed";
    } catch (error) {
      noteOnce(`pending-error-${claimPath}`, `${agent} session ${sessionId}: cannot retain pending capture (${(error as Error)?.message ?? "unknown"})`);
      return "failed";
    }
  }

  function flushPendingCapture(directory: string, agent: string, sessionId: string, routingKey: string): void {
    const claimPath = claimPathFor(directory, agent, sessionId, routingKey)!;
    if (replayingCapture.has(claimPath)) return;
    const pendingDir = `${claimPath}.pending`;
    let files: string[];
    try { files = fileSystem.readdirSync(pendingDir).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    files = files.filter(name => name.endsWith(".jsonl") && replayedCaptureSizes.get(join(pendingDir, name)) !== fileSystem.statSync(join(pendingDir, name)).size);
    if (files.length === 0) return;
    const transcript = transcriptPathFor(directory, agent, sessionId, routingKey)!;
    const captured = new Set<string>();
    const submissions = new Map<string, string | undefined>();
    for (const line of fileSystem.readFileSync(transcript, "utf8").split("\n").filter(Boolean)) {
      let row: Record<string, unknown>;
      try { row = JSON.parse(line); } catch { continue; }
      if (typeof row.captureId === "string") captured.add(row.captureId);
      if (row.type === "prompt" && typeof row.submissionId === "string") {
        captured.add(`submission-${row.submissionId}`);
        submissions.set(row.submissionId, typeof row.promptId === "string" ? row.promptId : undefined);
      }
    }
    replayingCapture.add(claimPath);
    try {
      for (const name of files) {
        if (!name.endsWith(".jsonl")) continue;
        const file = join(pendingDir, name);
        const text = fileSystem.readFileSync(file, "utf8");
        const end = text.lastIndexOf("\n") + 1;
        let damaged = end !== text.length;
        let immutable = false;
        const lines = text.slice(0, end).split("\n").filter(Boolean);
        for (const [index, line] of lines.entries()) {
          let row: Record<string, unknown>;
          try {
            row = JSON.parse(line);
            if (typeof row !== "object" || row === null || typeof row.captureId !== "string") throw new Error("record has no capture identity");
          } catch (error) {
            damaged = true;
            noteOnce(`damaged-${file}-${index}`, `${file}: damaged pending capture at line ${index + 1} retained for inspection (${(error as Error).message})`);
            continue;
          }
          if (lines.length === 1 && row._captureSnapshot === IMMUTABLE_CAPTURE) immutable = true;
          if (captured.has(row.captureId as string)) continue;
          if (typeof row.submissionId === "string" && submissions.has(row.submissionId)) row.promptId = submissions.get(row.submissionId);
          appendRaw(transcript, row, () => {
            captured.add(row.captureId as string);
            if (row.type === "prompt" && typeof row.submissionId === "string") submissions.set(row.submissionId, typeof row.promptId === "string" ? row.promptId : undefined);
            options.captured?.(claimPath, row);
          });
        }
        replayedCaptureSizes.set(file, Buffer.byteLength(text));
        // Immutable records retire after replay; mutable legacy files require a dead producer.
        const instance = name.slice(0, -".jsonl".length);
        const pid = Number(/^(\d+)-/.exec(instance)?.[1]);
        let dead = false;
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
        }
        if ((dead || immutable) && fileSystem.statSync(file).size === Buffer.byteLength(text)) {
          if (damaged) fileSystem.renameSync(file, `${file}.damaged`);
          else fileSystem.unlinkSync(file);
        }
      }
    } finally { replayingCapture.delete(claimPath); }
  }

  function appendTranscriptLine(
    directory: string,
    agent: string,
    sessionId: string,
    record: Record<string, unknown>,
  ): CaptureStatus {
    const routingKey = routingKeyFor(directory, false);
    const claimPath = claimPathFor(directory, agent, sessionId, routingKey);
    const filePath = transcriptPathFor(directory, agent, sessionId, routingKey);
    if (routingKey === null || claimPath === null || filePath === null || !holdsSessionClaim(directory, agent, sessionId, routingKey)) return "refused";
    let committed = false;
    try {
      return withClaimGate<CaptureStatus>(claimPath, "refused", () => {
        if (!keepsSessionClaim(directory, agent, sessionId, routingKey)) return "refused";
        if (record.type !== "session") flushPendingCapture(directory, agent, sessionId, routingKey);
        appendRaw(filePath, record, () => {
          committed = true;
          if (record.type === "prompt" && typeof record.submissionId === "string") options.captured?.(claimPath, record);
        });
        return "committed";
      });
    } catch (error) {
      noteOnce(`write-${agent}-${sessionId}`, committed
        ? `${filePath}: record appended; descriptor cleanup failed (${(error as Error)?.message ?? "unknown"})`
        : `cannot write ${filePath}: ${(error as Error)?.message ?? "unknown"} — this session is not captured`);
      return committed ? "committed" : "failed";
    }
  }

  function recoverInbox(directory: string, agent: string, sessionId: string): boolean {
    const routingKey = routingKeyFor(directory, false);
    const claimPath = claimPathFor(directory, agent, sessionId, routingKey);
    const transcript = transcriptPathFor(directory, agent, sessionId, routingKey);
    if (claimPath === null || routingKey === null || transcript === null) return false;
    return withClaimGate(claimPath, false, () => {
      let size = 0;
      try { size = fileSystem.statSync(transcript).size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (size === 0) appendRaw(transcript, { type: "session", sessionId, agent, cwd: directory, at: new Date().toISOString() }, () => {});
      flushPendingCapture(directory, agent, sessionId, routingKey);
      return true;
    });
  }
  return { recoverInbox, processBirth, withClaimGate, claimPathFor, holdsSessionClaim, releaseSessionClaim, keepsSessionClaim, appendTranscriptLine, retainPendingCapture, flushPendingCapture, claimHolder, writerStatus, MYCO_INSTANCE_ID, CLAIM_STALE_MS, CLAIM_RECHECK_MS };
}
// </myco:capture-store>
const captureStore = createPluginCaptureStore({
  fileSystem: nodeFs,
  retained: wakePendingCapture,
  note: noteOnce, home: resolveMycoHome, routing: routingKeyFor, transcript: transcriptPathFor, format: MYCO_TRANSCRIPT_FORMAT,
  released: (claimPath) => { transcriptSessions.delete(claimPath); },
  captured: (claimPath, record) => {
    if (typeof record.submissionId === "string") transcriptSessions.get(claimPath)?.submissions?.set(record.submissionId, typeof record.promptId === "string" ? { promptId: record.promptId } : {});
  },
});
const { withClaimGate, claimPathFor, holdsSessionClaim, releaseSessionClaim, keepsSessionClaim, appendTranscriptLine, retainPendingCapture, flushPendingCapture, MYCO_INSTANCE_ID, CLAIM_STALE_MS, CLAIM_RECHECK_MS } = captureStore;
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
 * What the hook says on stderr is noted, each line once per session: a hook
 * that refuses to capture (a command missing `--symbiont` or `--credential`,
 * no membership) exits 0 and says why only there.
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
  routingKey = routingKeyFor(directory),
): HookAnswer | null {
  // The instance that does not speak for this session runs nothing: a second
  // participant would spawn a second hook per turn, mint an id nothing uses
  // and place a second context block in front of the model.
  //
  // Re-checked rather than remembered, exactly as the write path is. An
  // instance displaced while idle would otherwise keep injecting from a memo
  // taken before it lost the session — and an agent whose transcript it never
  // writes, like Pi, would reach that state on every session, since a claim
  // taken once and never touched goes stale on its own.
  const claimPath = claimPathFor(directory, agent, sessionId, routingKey);
  if (routingKey === null || claimPath === null || !holdsSessionClaim(directory, agent, sessionId, routingKey)) return null;
  try {
    return withClaimGate(claimPath, null, () => {
      if (!keepsSessionClaim(directory, agent, sessionId, routingKey)) return null;
      const pluginRoot = join(resolveMycoHome(directory), "member", "transcripts");
      const transcriptPath = payload.transcript_path;
      const withinPluginRoot = typeof transcriptPath === "string"
        && (transcriptPath.startsWith(`${pluginRoot}/`) || transcriptPath.startsWith(`${pluginRoot}\\`));
      if (withinPluginRoot && transcriptPath !== transcriptPathFor(directory, agent, sessionId, routingKey)) {
        noteOnce(`route-changed-${agent}-${sessionId}`, `${agent} session ${sessionId}: routing changed during capture — this hook waits for the next action`);
        return null;
      }
      return callMycoHook(directory, agent, sessionId, verb, payload);
    });
  } catch (error) {
    noteOnce(`claim-error-${claimPath}`, `${agent} session ${sessionId}: cannot verify its claim (${(error as Error)?.message ?? "unknown"})`);
    return null;
  }
}

function callMycoHook(directory: string, agent: string, sessionId: string, verb: string, payload: Record<string, unknown>): HookAnswer | null {
      try {
        const run = spawnSync(
          resolveMycoBinary(directory),
          ["hook", verb, "--symbiont", agent, "--credential", MYCO_CREDENTIAL_SOURCE],
          {
            cwd: directory,
            env: { ...process.env, MYCO_HOME: resolveMycoHome(directory) },
            input: JSON.stringify(payload),
            timeout: MYCO_HOOK_TIMEOUT_MS,
            maxBuffer: 4 * 1024 * 1024,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        const said = typeof run.stderr === "string" ? run.stderr : "";
        for (const line of said.split("\n").map((l) => l.trim().replace(/^\[myco\]\s*/, "")).filter(Boolean)) {
          noteOnce(`hook-said-${agent}-${sessionId}-${line}`, `${agent} session ${sessionId}: ${line}`);
        }
        if (run.error) throw run.error;
        if (run.status !== 0) throw new Error(`exited ${run.status ?? run.signal}`);
        const stdout = run.stdout;
        const trimmed = typeof stdout === "string" ? stdout.trim() : "";
        if (!trimmed) return {};
        if (!trimmed.startsWith("{")) return { additionalContext: trimmed };
        return JSON.parse(trimmed) as { additionalContext?: string; promptId?: string };
      } catch (error) {
        noteOnce(`hook-${agent}-${sessionId}`, `${agent} session ${sessionId}: could not run \`myco hook ${verb}\`: ${(error as Error)?.message ?? "unknown"} — this session is not captured`);
        return null;
      }
}

function wakePendingCapture(directory: string, agent: string, sessionId: string): void {
  const routingKey = routingKeyFor(directory, false);
  if (routingKey === null) return;
  callMycoHook(directory, agent, sessionId, "stop", transcriptHookPayload(directory, agent, sessionId, routingKey));
}

/** Completed initialization obligations and a hook answer awaiting its prompt append. */
const transcriptSessions = new Map<string, {
  header: boolean;
  started: boolean;
  pendingPrompt?: { submission: string; answer: HookAnswer };
  submissions?: Map<string, HookAnswer>;
}>();

function transcriptHookPayload(directory: string, agent: string, sessionId: string, routingKey: string): Record<string, unknown> {
  return {
    ...(agent === "cline" ? { conversationId: sessionId } : { session_id: sessionId }),
    transcript_path: transcriptPathFor(directory, agent, sessionId, routingKey),
    cwd: directory,
  };
}

/** Initialize before any turn record; each obligation completes only after its operation succeeds. */
function initializeTranscriptSession(directory: string, agent: string, sessionId: string, routingKey = routingKeyFor(directory, false)): CaptureResult {
  const claimPath = claimPathFor(directory, agent, sessionId, routingKey);
  if (routingKey === null || claimPath === null || !holdsSessionClaim(directory, agent, sessionId, routingKey)) return { status: "refused" };
  try {
    return withClaimGate<CaptureResult>(claimPath, { status: "refused" }, () => {
      if (!keepsSessionClaim(directory, agent, sessionId, routingKey)) return { status: "refused" };
      const state = transcriptSessions.get(claimPath) ?? { header: false, started: false };
      transcriptSessions.set(claimPath, state);
      if (!state.header) {
        const status = appendTranscriptLine(directory, agent, sessionId, {
          type: "session",
          sessionId,
          agent,
          cwd: directory,
          at: new Date().toISOString(),
        });
        if (status !== "committed") return { status };
        state.header = true;
      }
      flushPendingCapture(directory, agent, sessionId, routingKey);
      if (state.started) return { status: "committed" };
      const answer = runMycoHook(directory, agent, sessionId, "session-start", transcriptHookPayload(directory, agent, sessionId, routingKey), routingKey);
      if (answer === null) return { status: "failed" };
      state.started = true;
      return { status: "committed", answer };
    });
  } catch (error) {
    noteOnce(`init-${agent}-${sessionId}`, `${agent} session ${sessionId}: cannot initialize capture (${(error as Error)?.message ?? "unknown"})`);
    return { status: "failed" };
  }
}

/** All plugin turn records require the same session initialization obligations. */
function captureTranscriptLine(directory: string, agent: string, sessionId: string, record: Record<string, unknown>): CaptureStatus {
  const initialized = initializeTranscriptSession(directory, agent, sessionId);
  const status = initialized.status === "committed" ? appendTranscriptLine(directory, agent, sessionId, record) : initialized.status;
  return status === "refused" ? retainPendingCapture(directory, agent, sessionId, record) : status;
}

/** Keep a successful prompt hook answer until its transcript append commits. */
function captureTranscriptPrompt(directory: string, agent: string, sessionId: string, text: string, submission?: string): CaptureResult {
  const record = { type: "prompt", sessionId, submissionId: submission, text, origin: "human", at: new Date().toISOString() };
  const routingKey = routingKeyFor(directory);
  const initialized = initializeTranscriptSession(directory, agent, sessionId, routingKey);
  if (initialized.status !== "committed") return initialized.status === "refused"
    ? { status: retainPendingCapture(directory, agent, sessionId, record) }
    : initialized;
  const claimPath = claimPathFor(directory, agent, sessionId, routingKey);
  if (routingKey === null || claimPath === null) return { status: "refused" };
  try {
    const result = withClaimGate<CaptureResult>(claimPath, { status: "refused" }, () => {
      if (!keepsSessionClaim(directory, agent, sessionId, routingKey)) return { status: "refused" };
      const state = transcriptSessions.get(claimPath)!;
      if (submission !== undefined) {
        if (state.submissions === undefined) {
          state.submissions = new Map();
          for (const line of readFileSync(transcriptPathFor(directory, agent, sessionId, routingKey)!, "utf8").split("\n").filter(Boolean)) {
            let row: Record<string, unknown>;
            try { row = JSON.parse(line); } catch { continue; }
            if (row.type === "prompt" && typeof row.submissionId === "string") state.submissions.set(row.submissionId, typeof row.promptId === "string" ? { promptId: row.promptId } : {});
          }
        }
        const captured = state.submissions.get(submission);
        if (captured !== undefined) return { status: "committed", answer: captured };
      }
      const answer = submission !== undefined && state.pendingPrompt !== undefined && state.pendingPrompt.submission === submission ? state.pendingPrompt.answer
        : runMycoHook(directory, agent, sessionId, "user-prompt-submit", { ...transcriptHookPayload(directory, agent, sessionId, routingKey), prompt: text }, routingKey);
      if (answer !== null && submission !== undefined) state.pendingPrompt = { submission, answer };
      const status = appendTranscriptLine(directory, agent, sessionId, { ...record, promptId: answer?.promptId });
      if (status === "committed") delete state.pendingPrompt;
      return { status, answer: answer ?? undefined };
    });
    return result.status === "committed" ? result
      : { status: retainPendingCapture(directory, agent, sessionId, { ...record, promptId: result.answer?.promptId }), answer: result.answer };
  } catch (error) {
    noteOnce(`prompt-${agent}-${sessionId}`, `${agent} session ${sessionId}: cannot capture prompt (${(error as Error)?.message ?? "unknown"})`);
    return { status: "failed" };
  }
}

// <myco:project-pin-trust>
import pinFs from 'node:fs';
import pinOs from 'node:os';
import pinPath from 'node:path';
import { createHash as pinHash, randomUUID as pinNonce } from 'node:crypto';

const PROJECT_PIN_TRUST_DIRECTORY = 'project-pin-trust';

function pinDigest(value) {
  return pinHash('sha256').update(value).digest('hex');
}

function projectPinIdentity(filePath) {
  const directory = pinPath.dirname(filePath);
  const root = pinFs.realpathSync(pinPath.dirname(directory));
  if (pinFs.realpathSync(directory) !== pinPath.join(root, '.myco')) throw new Error('pin directory is a symlink');
  let repo = root;
  while (true) {
    const dotGit = pinPath.join(repo, '.git');
    if (pinFs.existsSync(dotGit)) {
      const stat = pinFs.lstatSync(dotGit);
      if (stat.isSymbolicLink()) throw new Error('git directory is a symlink');
      let common = dotGit;
      if (!stat.isDirectory()) {
        const match = /^gitdir: (.+)\s*$/.exec(pinFs.readFileSync(dotGit, 'utf8').trim());
        if (!match) throw new Error('invalid git directory');
        const admin = pinFs.realpathSync(pinPath.resolve(repo, match[1]));
        common = pinFs.realpathSync(pinPath.resolve(admin, pinFs.readFileSync(pinPath.join(admin, 'commondir'), 'utf8').trim()));
        const backlink = pinFs.realpathSync(pinPath.resolve(admin, pinFs.readFileSync(pinPath.join(admin, 'gitdir'), 'utf8').trim()));
        if (backlink !== pinFs.realpathSync(dotGit) || pinPath.dirname(admin) !== pinPath.join(common, 'worktrees')) throw new Error('unregistered worktree');
      }
      return JSON.stringify([pinFs.realpathSync(common), pinPath.relative(repo, root), pinPath.basename(filePath)]);
    }
    const parent = pinPath.dirname(repo);
    if (parent === repo) return JSON.stringify([root, pinPath.basename(filePath)]);
    repo = parent;
  }
}

function projectPinRecord(filePath, homeDir) {
  const base = pinPath.join(homeDir, '.myco', PROJECT_PIN_TRUST_DIRECTORY);
  return pinPath.join(base, `${pinDigest(projectPinIdentity(filePath))}.json`);
}

function outsideCheckout(directory) {
  let dir = pinFs.realpathSync(directory);
  while (true) {
    if (pinFs.existsSync(pinPath.join(dir, '.git'))) throw new Error('project pin trust must live outside a checkout');
    const parent = pinPath.dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

/** Project pins require this user's approval of the local repository and pin path. */
function projectPinIsTrusted(filePath, homeDir = process.env.HOME || process.env.USERPROFILE || pinOs.homedir()) {
  try {
    const record = projectPinRecord(filePath, homeDir);
    outsideCheckout(pinPath.dirname(record));
    const stat = pinFs.lstatSync(record);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    if (process.platform !== 'win32' && ((stat.mode & 0o022) || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))) return false;
    const approved = JSON.parse(pinFs.readFileSync(record, 'utf8'));
    return approved.identity === projectPinIdentity(filePath);
  } catch {
    return false;
  }
}

/** Explicit pin-writing and approval commands are the only callers of this writer. */
function trustProjectPin(filePath, homeDir = process.env.HOME || process.env.USERPROFILE || pinOs.homedir()) {
  const stat = pinFs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('pin must be a regular file');
  if (process.platform !== 'win32' && ((stat.mode & 0o022) || (typeof process.getuid === 'function' && stat.uid !== process.getuid()))) throw new Error('pin ownership or permissions are unsafe');
  const value = pinFs.readFileSync(filePath, 'utf8').trim();
  if (!value) throw new Error('pin is empty');
  const record = projectPinRecord(filePath, homeDir);
  pinFs.mkdirSync(pinPath.dirname(record), { recursive: true, mode: 0o700 });
  outsideCheckout(pinPath.dirname(record));
  const temporary = `${record}.${pinNonce()}`;
  try {
    pinFs.writeFileSync(temporary, JSON.stringify({ identity: projectPinIdentity(filePath) }) + '\n', { mode: 0o600, flag: 'wx' });
    pinFs.renameSync(temporary, record);
  } finally {
    pinFs.rmSync(temporary, { force: true });
  }
}
// </myco:project-pin-trust>
// </myco:shared-helpers>

const AGENT = "opencode";

/**
 * Marks a part this plugin injected. opencode replays injected parts through
 * `chat.message`, so without the marker our own context would be captured as
 * the user's next prompt.
 */
const MYCO_METADATA_MARKER = "myco";

/** Heading placed above injected context so the model sees a labelled block. */
const CONTEXT_HEADING = "## Myco - Project Context\n\n";

/** The prompt id the binary minted for the turn in flight, per session. */
const promptIds = new Map<string, string>();
const submissionIds = new Map<string, string>();
/** Sessions opened by this instance, including pending initialization. */
const openedSessions = new Set<string>();

function nowIso(): string {
  return new Date().toISOString();
}

function textOfParts(parts: Array<{ type?: string; text?: string; synthetic?: boolean; metadata?: Record<string, unknown> }>): string {
  return parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .filter((p) => p.synthetic !== true)
    .filter((p) => p.metadata?.[MYCO_METADATA_MARKER] !== true)
    .map((p) => p.text as string)
    .join("\n")
    .trim();
}

/**
 * Open a session: write the `session` record first — attribution reads the
 * working directory from the head of the file — then register and inject.
 */
function openSession(directory: string, sessionId: string): string | undefined {
  openedSessions.add(sessionId);
  return initializeTranscriptSession(directory, AGENT, sessionId).answer?.additionalContext;
}

/**
 * End a session this instance opened and give up its claim, so a new instance
 * resuming the session takes it at once.
 */
function endSession(directory: string, sessionId: string): void {
  openedSessions.delete(sessionId);
  promptIds.delete(sessionId);
  submissionIds.delete(sessionId);
  runMycoHook(directory, AGENT, sessionId, "session-end", {
    session_id: sessionId,
    transcript_path: transcriptPathFor(directory, AGENT, sessionId),
    cwd: directory,
  });
  releaseSessionClaim(directory, AGENT, sessionId);
}

export const MycoPlugin = async ({
  client,
  directory,
  worktree,
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any;
  directory: string;
  worktree?: string;
}) => {
  const root = worktree ?? directory;

  /** Place a block in the session out of band, used at session start and resume. */
  const injectSynthetic = async (sessionId: string, text: string): Promise<void> => {
    try {
      await client.session.prompt({
        path: { id: sessionId },
        body: {
          parts: [{ type: "text", text, synthetic: true, metadata: { [MYCO_METADATA_MARKER]: true } }],
          noReply: true,
        },
      });
    } catch {
      // Injection is best effort; a session that refuses it still captures.
    }
  };

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    event: async ({ event }: { event: any }) => {
      const type = event?.type;

      if (type === "session.created") {
        const sessionId = event?.properties?.info?.id;
        if (!sessionId) return;
        const context = openSession(root, sessionId);
        if (context) await injectSynthetic(sessionId, `${CONTEXT_HEADING}${context}`);
        return;
      }

      if (type === "session.idle") {
        const sessionId = event?.properties?.sessionID;
        if (!sessionId) return;
        promptIds.delete(sessionId);
        submissionIds.delete(sessionId);
        runMycoHook(root, AGENT, sessionId, "stop", {
          session_id: sessionId,
          transcript_path: transcriptPathFor(root, AGENT, sessionId),
          cwd: root,
        });
        return;
      }

      if (type === "session.deleted") {
        const sessionId = event?.properties?.info?.id;
        if (sessionId) endSession(root, sessionId);
        return;
      }

      // The instance is going away and names no session: end every session it opened.
      if (type === "server.instance.disposed") {
        for (const sessionId of [...openedSessions]) endSession(root, sessionId);
      }
    },

    /**
     * An assistant text part, once opencode has finished it: the turn's
     * response line. `chat.message` carries only the user's message, so this is
     * the one place the assistant's words reach the plugin whole. The text is
     * read and left as it is.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "experimental.text.complete": async (input: any, output: any) => {
      const sessionId = input?.sessionID;
      const text = typeof output?.text === "string" ? output.text.trim() : "";
      if (!sessionId || !text) return;
      captureTranscriptLine(root, AGENT, sessionId, {
        type: "response",
        submissionId: submissionIds.get(sessionId),
        sessionId,
        promptId: promptIds.get(sessionId),
        text,
        at: nowIso(),
      });
    },

    /**
     * A turn's user message: register the session if this is the first thing
     * seen, mint the prompt id through the hook, write the prompt line, and
     * push the served context onto this message's parts.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "chat.message": async (_input: any, output: any) => {
      const sessionId = output?.message?.sessionID ?? output?.parts?.[0]?.sessionID;
      if (!sessionId) return;

      const parts = (output?.parts ?? []) as Array<{
        id?: string;
        messageID?: string;
        sessionID?: string;
        type?: string;
        text?: string;
        synthetic?: boolean;
        metadata?: Record<string, unknown>;
      }>;

      const text = textOfParts(parts);
      if (!text) return;

      const startContext = openSession(root, sessionId);
      if (startContext) await injectSynthetic(sessionId, `${CONTEXT_HEADING}${startContext}`);

      const submission = output?.message?.id ?? _input?.messageID;
      const result = captureTranscriptPrompt(root, AGENT, sessionId, text, submission);
      if (result.status !== "committed") return;
      const answer = result.answer;
      if (typeof submission === "string") submissionIds.set(sessionId, submission);
      else submissionIds.delete(sessionId);
      const promptId = answer?.promptId;
      if (promptId) promptIds.set(sessionId, promptId);
      else promptIds.delete(sessionId);

      const context = answer?.additionalContext;
      if (!context) return;
      // Mirror the user part's identity so opencode renders the block in place
      // rather than as a message of its own.
      const template = parts.find((p) => p?.type === "text");
      const idPrefix =
        typeof template?.id === "string" && template.id.includes("_")
          ? template.id.slice(0, template.id.indexOf("_") + 1)
          : "prt_";
      output.parts.push({
        id: `${idPrefix}myco${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`,
        ...(template?.messageID !== undefined ? { messageID: template.messageID } : {}),
        ...(template?.sessionID !== undefined ? { sessionID: template.sessionID } : {}),
        type: "text",
        text: `${CONTEXT_HEADING}${context}`,
        synthetic: true,
        metadata: { [MYCO_METADATA_MARKER]: true },
      });
    },

    /** A finished tool call becomes a transcript line; completed session initialization requires no subprocess. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "tool.execute.after": async (input: any, output: any) => {
      const sessionId = input?.sessionID;
      if (!sessionId) return;
      captureTranscriptLine(root, AGENT, sessionId, {
        type: "tool",
        submissionId: submissionIds.get(sessionId),
        sessionId,
        promptId: promptIds.get(sessionId),
        name: input?.tool,
        input: input?.args,
        output: typeof output?.output === "string" ? output.output : undefined,
        failed: output?.error !== undefined,
        at: nowIso(),
      });
    },

    /** Compaction drops the earlier turns, so the served block is placed again. */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    "experimental.session.compacting": async (input: any, output: any) => {
      const sessionId = input?.sessionID;
      if (!sessionId) return;
      const answer = runMycoHook(root, AGENT, sessionId, "post-compact", {
        session_id: sessionId,
        transcript_path: transcriptPathFor(root, AGENT, sessionId),
        cwd: root,
      });
      if (answer?.additionalContext && Array.isArray(output?.context)) {
        output.context.push(`${CONTEXT_HEADING}${answer.additionalContext}`);
      }
    },
  };
};

export default MycoPlugin;
