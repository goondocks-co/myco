import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface WriterClaim { instance: string; at: number; born?: number }

export type PluginCaptureStatus = "committed" | "refused" | "failed";

export interface PluginCaptureOptions {
  fileSystem?: typeof fs;
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
export function createPluginCaptureStore(options: PluginCaptureOptions) {
  type CaptureStatus = PluginCaptureStatus;
  const fileSystem = options.fileSystem ?? fs;
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
