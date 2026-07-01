---
name: myco:stop-hook-fragility
description: |
  Use when prompt/response capture stops working, a Claude Code hook reports
  a silent non-blocking error, or you're modifying anything in
  packages/myco/src/hooks/, the global launcher, or the EventBuffer/
  reconciliation path. Stop hooks are the most fragile point in Myco's
  capture chain — covers three distinct, independently-diagnosable failure
  modes: (1) hook path wiring breaking when ~/.myco/runtime/ is deleted
  even though the native daemon is active, (2) capture-critical hooks
  needing an EventBuffer fallback so daemon restarts mid-turn don't
  permanently drop the assistant response, and (3) the global launcher's
  catch-all masking real errors as a silent "non-blocking status code, no
  stderr" failure. Apply this even if the user just says "capture isn't
  working" or "hook is erroring" without naming a root cause — the
  procedure here is how you tell the three apart and fix or recover from
  each.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Stop Hook Fragility: Diagnosis, Idempotency, and Recovery

Stop hooks sit at the boundary between Claude Code and Myco's capture
pipeline, and they are the most fragile point in that chain: a single
broken path, a missing fallback, or a masked exit code silently stops
prompt/response capture with no visible symptom in the session itself.
Three independent failure modes have been observed, each with a
different root cause and a different diagnostic fingerprint. Treat
"capture isn't working" as a triage problem — figure out which of the
three you're looking at before reaching for a fix.

## Prerequisites

Know the shape of the hook chain before diagnosing anything:

- Claude Code invokes hooks per the command registered in
  `~/.claude/settings.json` (e.g. the Stop hook entry).
- That command routes through `~/.myco/launcher.cjs`, which spawns the
  actual hook binary and translates the child's exit/signal into its
  own process exit.
- The hook binaries themselves live in `packages/myco/src/hooks/`
  (covering, among others, the stop, user-prompt-submit, and
  post-tool-use entry points). **Every hook in this directory is
  fail-open** — it always exits 0, writing errors only to stderr. The
  hook code is never the source of a non-zero exit you see in Claude
  Code's UI.
- Capture-critical hooks POST to the daemon (a `capturePost(...)` call,
  which is `captureCritical`) and, on failure, should buffer to
  `<grove>/projects/<pid>/buffer/<sid>.jsonl` for replay via
  `reconcileBufferBatches` on next daemon start.

## Procedure A: Triage — which of the three failure modes is this?

Work through these checks in order; they're cheap and conclusive.

1. **Is the symptom "hook exits with `No such file or directory`" or
   total silence on a known-good machine?** → Path wiring (Procedure B).
2. **Is the symptom "assistant response missing after a daemon
   restart" or "buffer recovery didn't work" for the last turn
   specifically?** → Buffer durability (Procedure C).
3. **Is the symptom "PreToolUse/PostToolUse hook error — non-blocking
   status code: No stderr output" in Claude Code's UI?** → Launcher
   masking (Procedure D). Confirm fast: PostToolUse's hook chain ends
   in `|| true` and can *never* exit non-zero, while PreToolUse has
   only the myco hook in the chain — so a PreToolUse hook error is
   conclusively coming from the launcher, not hook code.

If none of these match, the failure isn't one of the three known modes
— don't force-fit it; check daemon health and logs independently
(`~/.myco/logs/`).

## Procedure B: Path wiring — `~/.myco/runtime/` deletion breaks hook invocation

**Root cause.** `~/.claude/settings.json` can hardcode the Stop hook
command to route through the *managed runtime* at
`~/.myco/runtime/node_modules/.bin/myco`, not the native binary at
`~/.myco/bin/myco`. These are two different install mechanisms, and a
hook config can keep pointing at the managed runtime path long after
the native binary has taken over as the active daemon. Deleting
`~/.myco/runtime/` during cleanup — even when the native daemon is
demonstrably running from `~/.myco/bin/myco` — breaks the hook
invocation with `No such file or directory`, silently killing prompt
capture for the entire session. Nothing in the running daemon's state
indicates this; the failure is purely in the hook's exec path.

**Why this is a trap.** The native binary transition can be
*incomplete* in a way that looks complete: the daemon process is
native, prompts mostly work, but the actual hook entry point in
`~/.claude/settings.json` is still wired through the npm-installed
managed runtime. "The daemon is native now, so the managed runtime
directory is dead weight" is the wrong inference.

**Diagnosis.**
```bash
# What does the Stop hook actually invoke?
grep -A2 '"Stop"' ~/.claude/settings.json

# Does that path exist?
ls -la ~/.myco/runtime/node_modules/.bin/myco
```

**Fix.** Restore the managed runtime symlink so the hardcoded path
resolves again:
```bash
ln -sf <path-to-dev-build> ~/.myco/runtime/node_modules/.bin/myco
```
The hook exits 0 immediately once the symlink resolves.

**Prevention.** Before removing `~/.myco/runtime/` (or any runtime
directory) during cleanup, `grep` every hook config that references
Myco (`~/.claude/settings.json`, project-level `.claude/settings.json`
files) for paths inside that directory. Do not assume "the native
binary is active" implies "no hook config still points at the managed
runtime."

## Procedure C: Buffer durability — capture-critical hooks need an EventBuffer fallback

**Root cause.** A capture-critical hook (one that POSTs an event the
daemon must receive exactly once, like the Stop hook's
`last_assistant_message`) must do two things on POST failure: buffer
the event for replay, and do so in a way that's safe even if the same
event later arrives twice. Historically the Stop hook
(`packages/myco/src/hooks/stop.ts`) POSTed via a `capturePost`
call to the stop endpoint but had no `EventBuffer` fallback — its
catch block only wrote to stderr. Every other capture hook
(`user-prompt-submit`, `post-tool-use`, the shared
`captureHookEvent`) already buffered to
`<grove>/projects/<pid>/buffer/<sid>.jsonl` on POST failure, replayed
by `reconcileBufferBatches` on next daemon start. Because Stop didn't,
a daemon restart at exactly the wrong moment (mid- or just-after a
turn) permanently lost that turn's assistant response — recoverable
only via the separate, agent-dependent `lifecycle.reconcile` transcript
re-mine path, which doesn't exist for symbionts with no minable
transcript.

**The general pattern to apply when adding or auditing a
capture-critical hook:**

1. **Producer side — buffer on failure.** Wrap the POST in a
   POST-then-buffer boundary (Myco extracted this into one shared
   `captureCriticalEvent()` helper function so stop, post-tool-use,
   and user-prompt-submit are thin callers of it) so `!ok || ignored`
   triggers a buffer write of the minimal payload needed to replay the
   event later. Skip buffering only when there's genuinely nothing to
   recover (e.g. no `last_assistant_message` to buffer).
2. **Consumer side — make replay idempotent.** The reconciliation
   handler for that event type must tolerate the same event arriving
   twice (a buffered event racing a late live event, or a double
   replay) without corrupting state. Myco's pattern: write a field
   only while it's still NULL (`setResponseSummary` only writes once),
   so a buffered Stop event colliding with a live one converges to the
   same result instead of overwriting or erroring.
3. **Don't redundantly block on daemon recovery in the hook.** If the
   POST call is already wrapped as `captureCritical` (it has its own
   wedged-daemon recovery), don't add a second explicit
   `ensureRunning({checkStale:false})` call before it — that's
   redundant and can block the agent for multiple seconds on an
   ordinary daemon blip. Check whether the underlying POST helper
   already self-heals before adding recovery logic in the caller.
4. **Keep the buffer write in the hook process.** It only fires when
   the daemon is unreachable, so by definition nothing else can
   perform it on the hook's behalf — don't try to centralize it
   somewhere the hook process can't reach.

**The `bufferOnIgnored` knob — don't "simplify" it away.**
`post-tool-use` passes `bufferOnIgnored:false` deliberately:
`tool_use` replay calls `handleToolUse` directly with no re-evaluation
of capture rules, so buffering a daemon-`ignored` (rule-dropped) tool
event would resurrect it on replay. `user_prompt` replay *does*
re-apply the capture rule (`classifyNextPromptDecision`), so
buffering-on-ignored is safe there. If you're auditing or extending a
capture-critical hook, check whether its replay path re-evaluates
rules before deciding whether ignored events are safe to buffer — this
asymmetry is principled, not an oversight, and "harmonizing" it would
reintroduce the tool-use bug.

**Tests to mirror this pattern against:** `tests/hooks/stop-buffer.test.ts`
(producer side) and `tests/daemon/reconciliation-stop.test.ts`
(consumer side, including no-overwrite / no-divergence idempotency
cases). Any new capture-critical hook should have an equivalent pair.

## Procedure D: Launcher error masking — silent exit-1 from the global catch-all

**Symptom.** Claude Code shows `PreToolUse/PostToolUse hook error —
non-blocking status code: No stderr output`, with zero diagnostic
information.

**Root cause.** This is never the Myco hook code — every hook under
`packages/myco/src/hooks/` is fail-open and always exits 0. The actual
exiter is the global launcher script's catch-all (installed as
`~/.myco/launcher.cjs`), which boils down to: if the child process
error carries a numeric exit-status field, propagate that status;
otherwise exit 1. When the spawned child is killed by a signal rather
than exiting normally, that status field comes back `null`. Spawn-class
errors (`EAGAIN`/`EMFILE` under fork pressure, `EACCES`/`ETXTBSY`
while the binary is mid-replacement by a self-update) also produce a
non-numeric status. All of these collapse to exit 1 with zero
stdout/stderr and zero logging — the launcher swallows the actual
error before it can be surfaced.

**This failure is situational, not deterministic.** The same
invocation that fails can exit 0 in well under a second under normal
load, including dozens of parallel runs. Look for machine-wide
pressure around the failure window: a parallel test run plus multiple
agents causing a fork storm, or daemon logs showing event-loop lag
near the same timestamp. Don't assume the hook binary itself
regressed — check system load and concurrent processes first.

**Diagnosis checklist:**
- Confirm it's PreToolUse (conclusive — see Procedure A.3) or that
  PostToolUse's `|| true` somehow didn't apply (rare; check the
  installed hook chain hasn't drifted from the template).
- Check the launcher's log output if present, and daemon logs for
  event-loop lag or restart activity around the same timestamp.
- Check for a self-update in progress (a binary-replacement race) or a
  burst of concurrent process spawns.
- Capture impact: if `post-tool-use` dies before it can send, the
  event is lost from *both* the daemon and the buffer — the hook
  process itself is the buffer writer, so a process that dies before
  reaching its own catch block leaves no trace anywhere. Only
  Stop-time transcript mining can heal this gap, and only for
  agents with a minable transcript.

**Fix direction (if extending the launcher):** launcher hook contexts
should log the underlying error's code or signal once (to stderr and
to a launcher log file) and exit 0, reserving real non-zero exit codes
for tool/CLI invocation contexts rather than hook contexts. The goal
is to stop collapsing distinguishable failures into one opaque exit-1
with no trace.

## Cross-Cutting Gotchas

- **"The daemon is fine" doesn't mean the hook path is fine.** Path
  wiring (B) and launcher masking (D) both produce failures that look
  like capture is broken even though the daemon process itself is
  healthy. Always check the hook's actual invocation path and exit
  behavior independently of daemon health.
- **Silence is the default failure signature across all three modes.**
  None of these failure modes produce a loud, attributable error in
  the session transcript. If "capture isn't working" is reported with
  no other symptom, run the Procedure A triage rather than guessing.
- **Recovery options shrink the further downstream the loss occurs.**
  A path-wiring failure (B) is fully recoverable by fixing the symlink
  — no data was ever sent. A buffer-durability gap (C) is recoverable
  via transcript re-mining *if* the agent produces a minable
  transcript, otherwise the response is permanently lost. A launcher
  masking failure on `post-tool-use` (D) loses the event from both the
  daemon and the buffer simultaneously, since the dying process was
  the only thing that could have buffered it. When auditing a new
  hook, ask which of these three loss profiles applies to it.
- **Hooks must stay thin.** When fixing any of these, prefer
  extracting shared logic (POST-then-buffer boundaries, path
  resolution) into one shared helper rather than duplicating recovery
  logic per-hook — duplication is exactly how a fix lands in
  `user-prompt-submit` and `post-tool-use` but gets missed in `stop`.
