# Myco 2.0 — Canonical Architecture and Feature-Preservation Ledger

> **TL;DR.** Myco 2.0 is one feature-complete server product with two front doors — a single Bun binary and a Cloudflare Worker — plus a machine-side member install of the binary, hooks and plugins. Neither front door runs harnesses: task runs happen on workers that attach from wherever harnesses are logged in. This document is the single current architecture record for the whole 2.0 release and the completeness ledger that gives every 1.4 surface an explicit KEEP / REPLACE / DROP disposition and an owning surface. It is machine-enforced by `tests/meta/feature-ledger-completeness.test.ts`.

**Issue:** [#906](https://github.com/goondocks-co/myco/issues/906) · **Program map:** [#1144](https://github.com/goondocks-co/myco/issues/1144) (successor of [#905](https://github.com/goondocks-co/myco/issues/905)) · **Plan:** `docs/superpowers/plans/2026-09-07-myco-2-0-revised-plan.md`

## 1. Authority

Use this order when sources disagree:

1. `AGENTS.md` and nested instructions govern how work is performed.
2. **#1144 (the revised-plan anchor, successor of #905)** is the canonical program map, and the plan it executes — `docs/superpowers/plans/2026-09-07-myco-2-0-revised-plan.md` — is the settled product model.
3. The claimed child issue is the executable scope and acceptance contract.
4. Current code, tests, CI, deployments, and migration evidence determine actual state.
5. **This document** is the current architecture and disposition record for the 2.0 release.
6. Earlier Myco plans and specs are lineage and research inputs, not current authority.

This document does not restate the anchor issue's live scope, dependencies, or status. GitHub is the live status source; this is the durable architecture and ledger.

### 1.1 The governing rule

**Feature Preservation.** Replacing local daemon and server infrastructure does not change Myco's major feature set. Every existing capability receives an explicit keep, replace, or intentional-drop decision and an owning surface; infrastructure omission is never a reason to lose functionality. "Harder to build" is not a reason to drop.

A row with a disposition but **no owning surface** is the defect this document exists to prevent — that is how a capability ends up owned by nobody. The gate in §9 fails on it by name.

## 2. Lineage

Preserved in both directions so no predecessor is orphaned and no successor is unexplained.

### 2.1 Predecessors (superseded by this document and #905)

| Vault | Artifact | Status | Role now |
|---|---|---|---|
| `14015a1a3a072418` | Myco 2.0 plan-sequence re-cut | abandoned | Lineage: how Plans 4b/4c/5/6 were cut before the rescue |
| `bfc77206e402ca84` | Myco 2.0 roadmap | abandoned | Lineage: milestones, standing decisions, working discipline |
| `4f60ca559e86fcc3` | Phase 1 design spec (rev 11) | active | Research input: §4.2.1 targets, §5.8 auth, §5.9 runner, §5.10 lifecycle, §8 gates |
| `64d8f59006e9b912` | Feature-parity audit (rev 3/4) | abandoned | **Direct input to §7's ledger.** Its per-row dispositions are carried forward except where §6 records a contradiction |
| `c2d6f5d7bf4ab246` | Plan 4 spec (rev 3) | active | Research input: shipped owner-auth/read-API baseline |
| `aae2282328a9be28` | Plan 3 member spec (rev 6) | active | Research input: the member contract |

### 2.2 Shipped landmarks

The 2.0 trunk at `main` carries these merged PRs. They are the implementation baseline this ledger reconciles against — **baseline, not destination** (§6.3).

| PR | Commit | What landed |
|---|---|---|
| #897 | `fcb53af5` | Server foundation and ingest |
| #898 | `2b94f010` | Ingest completeness, blob adapter, protocol window |
| #899 | `8b2263d2` | Member-side leaf extraction |
| #900 | `6a633260` | Refusal codes, member token refresh with lineage |
| #901 | `e1c936ce` | The 2.0 member seam — write-ahead capture, rotation, retention, provisioning |
| #904 | `258d2fbe` | Query core, GitHub sign-in, the read API |

`release/1.4` was cut at `23ecd8e1` (`myco/v1.4.8`); `main` is the 2.0 trunk.

### 2.3 Successors

| Date | Successor | What it changed |
|---|---|---|
| 2026-09-07 | **Myco 2.0 — Revised Plan (v2)**, `docs/superpowers/plans/2026-09-07-myco-2-0-revised-plan.md`, filed under anchor #1144 after two independent assessments (an agent-in-a-project walk and a feasibility pass against the tree) and forty-eight decisions taken by Chris | **#905's program map is superseded.** Same destination, most of the machinery removed: capture becomes transcript-first, the harness container and the phased executor give way to three one-prompt run outcomes on attached workers, Compose and the Member Service go, digest / Canopy / generated skills are dropped with their losses recorded (§1 of the plan), and the 1.4 tree retires in one sweep after cutover rather than deletion-first |

Execution proceeds through the anchor's children (waves A–E and the retire-backward sweep). This document's §7 rows name the owning child issue; rows still naming a #905 child name the work, not a live issue number.

## 3. Destination architecture

The settled model. Terms are defined in [`CONTEXT.md`](../../CONTEXT.md), which is the canonical glossary; this section states the structure, not the definitions.

### 3.1 Deployment and Project

A **Deployment** is one physical server/data authority. It replaces **both** Grove and Team as the isolation and infrastructure boundary. A Deployment contains many Projects. Separate personal, client, or security boundaries require separate Deployments.

A **Project** is the shared body of collective intelligence for equivalent Git checkouts. Checkouts with the same portable Project ID or normalized Git remote contribute to the same Project. There is no separate project-sharing product — sharing is inherent in Deployment membership.

**Project Binding** associates a local Git project with an explicit Deployment or the Default Deployment. **Project Resolution** applies in order: portable Project ID → normalized Git remote → server-assigned identity. Different Git remotes do not auto-merge; rare duplicates are corrected by server-side **Project Reassignment** followed by normal reprocessing.

### 3.2 Membership and runtime identity

Server Provisioning creates **Enrollment Authority**. Joining exchanges it for an individually attributable **Member Credential** — the enrollment secret is never the credential used for ordinary requests.

**Membership is flat in the initial release:** every joined member has equal full application access across the Deployment, provider settings and credentials included (the separate step-up credential was dropped 2026-08-30, #1036; a future guard, if one is ever wanted, is re-authentication of the signed-in member, never a second secret).

Human member identity is distinct from machine, runtime, or coding-agent metadata. A persistent developer machine and an ephemeral **Sandbox Runtime** act as the **same member with the same capabilities**. Independently hosted cloud agents (e.g. a Copilot review agent) are **not members** and receive project-scoped read-only **External Agent Access**.

> The exact enrollment, member identity, approval, recovery, and step-up mechanism is an open research decision owned by **#907**. The constraints above are settled; the mechanism is not.

### 3.3 One server product, two front doors

The Cloudflare Worker and the self-hosted binary implement **one common server contract and shared core** with platform-specific adapters — not divergent products. Both are storage + MCP + ingest + scheduler. **Neither runs harnesses** (plan §2.6).

| | Cloudflare Deployment (**W**) | Self-hosted Deployment (**C**) |
|---|---|---|
| API + assets | Worker with static assets | Single Bun binary — the same one a member installs, serving `myco server run`; both dashboards travel inside it as generated asset modules, so it mounts no build directory. A container image is packaging, not a requirement |
| Relational store | D1 | Embedded SQLite |
| Blob store | R2 | Local volume |
| Vector store | Vectorize | Local SQLite vector adapter |
| Wake / schedule | `DeploymentClock` Durable Object alarm + cron floor | In-process scheduler |
| Secret wrapping key | Secrets Store binding | Env or file (`secrets.env` idiom) |
| Harness | The Deployment runs none. The container it used to start is gone, and a worker attaches instead | Workers attach the same way, over the Deployment's own HTTP surface under an administrator's credential, so a worker inside the laptop process and a worker on a machine of its own run identical code. `myco server run` starts one in-process unless `--no-worker`. A dispatch is never refused for want of a harness: it queues, and an operator reads the wait on the run. Three tasks keep the push-launch seam until the sweep — `embedding-reconcile` and `canopy-map`, whose surface is a server-side step loop rather than MCP, and `container-smoke`, the containerized runtime's own proof |
| Durable storage | Platform-managed | Local volume beside the binary |
| Native storage artifacts | Platform-managed | Carried in the binary: an extension-enabled SQLite library and the `vec0` extension, registered before the first connection. A host lookup remains for a checkout and a container image |
| Lifecycle | `myco server create\|update\|rollback\|status\|destroy --target cloudflare`, needing Node and a wrangler login on the operator's machine and neither on the Deployment | `myco server create\|run\|install\|uninstall\|status\|update\|destroy --target local`, with a per-user service (launchd, systemd `--user`, Task Scheduler) running `myco server run` at login |

The `HarnessContainer` Durable Object and the `[[containers]]` block are gone, retired by a `deleted_classes` migration (plan §2.6, §4 D2); `DeploymentClock` stays. Containers are a paid-plan surface, so removing them is what puts the stack on the free tier. Provisioning is one verb over a worker bundle the binary carries — no Docker, no source checkout — with Node and Wrangler an **operator-machine** prerequisite for that verb alone, never on a member or worker host.

Shared behavior belongs in the common core; target-specific infrastructure, storage, wake, TLS/proxy, backup, and observability behavior belongs in adapters. **Neither target may silently lose a feature because the other implemented it first.** A ledger row naming a capability without its per-target mechanism is how one target never gets it.

Both front doors pass the same ingest parity and eval suites before release (§8).

### 3.3.1 Deployment-held secrets (#961, approved 2026-08-24)

Secrets divide by **who reads the value back**, and only one of the four classes is a secrets-storage problem the Deployment shares with a laptop.

| Class | Examples | Stored as |
|---|---|---|
| **1a** mint-and-verify | member credentials, enrollment authorities | **Digest only.** Never retrievable — this is what makes a backfilled credential unresurrectable (#912) |
| **1b** mint-and-display | MCP access tokens, team keys | Retrievable: a member pastes the value into an external Cloud Agent |
| **2** third-party, in-process | `GITHUB_TOKEN` | Retrievable: our own code signs API calls with it |
| **3** third-party, subprocess | `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, OpenAI/OpenRouter | Retrievable, and must reach a harness process env under the provider SDKs' own names |

Classes 1b, 2 and 3 share **one** `SecretStore` port and one implementation; 1a keeps the digest path and must never route through it.

**Ciphertext lives in the store; the wrapping key does not.** Values are AES-256-GCM through Web Crypto — native on both targets, so no dependency is added — with a fresh IV per write and the secret's own name as AAD, so a ciphertext moved between slots fails to decrypt rather than returning the wrong credential. `key_version` is carried from the first migration so re-wrapping is a migration and not an outage.

The reason is our own design rather than a generic precaution: **direct store access is a deliberate, documented capability.** `BREAK-GLASS.md` prescribes `wrangler d1 execute --remote`, and #907 settled infrastructure control as proof of authority — it is the only recovery that survives losing every credential. Plaintext third-party credentials in that store would make every break-glass operation, operator query and leaked account token a disclosure of every provider key at once. The platform encrypts the store at rest, which defends the disk and not the access the runbook prescribes.

A member's own `secrets.env` is unchanged and out of scope: a `0600` file on a single-user machine is reachable by the person it belongs to, which is a different threat from a shared Deployment store.

**No managed secrets dependency is taken.** Vault-class products centre on dynamic short-lived credentials, and LLM providers issue only long-lived bearer keys — the main thing they buy does not apply to the dominant class — while every one of them would require a self-hosted operator to run infrastructure to use Myco at all.

### 3.4 Member Installation, plugins, and tenancy

The machine-side product contains the `myco` binary, hooks, spool, local registry/configuration, and worker mode. It owns **no vault, no dashboard and no resident service**: reconciliation is on demand through `myco update` and `myco doctor`, run by the setup skill and the installer (plan §2.5). Capture stays hook-invoked and write-ahead per the member seam (#901).

**Distribution splits in two** (plan §2.7):

- **Plugins** carry no binary — 82 MB against a 256 MiB cap, and no post-install scripts. **One bundle directory carries every client's manifest over one skills tree** (`plugins/myco/`, generated; the marketplace manifest is `.claude-plugin/marketplace.json` at the repository root, where every client that reads a git repo looks): an **Agent Plugins 1.0** manifest covering Codex, Cursor, VS Code Copilot and Antigravity, plus Claude Code's, Cursor's and Codex's own manifest beside it. **OpenCode, Pi and Cline take native in-process plugins that make no HTTP call of their own** (#1157): each translates its harness's lifecycle onto the binary's hook verbs, so the credential, the write-ahead spool, the server-held offset and the refusal codes have one implementation rather than four. OpenCode and Cline keep no append-only transcript — one stores a session as a file per message and per part, the other rewrites whole documents in place, and neither carries a byte offset a delta can ship against — so their plugin writes one under the member home and Myco's retention ages it; Pi writes its own and Myco only reads it. Cline is served at the reduced tier through that same plugin, which resolves D4: keeping it removes a hand-maintained copy of the transport rather than adding one. Each client declares the Deployment URL and credential through its own config prompt (Claude Code `userConfig`, Cursor `variables`, VS Code `inputs`, Codex `[plugins.*.mcp_servers.*]`), emitted from one spec so the five prompts cannot drift. **The marketplace bundle ships no hook**: a hook command is the binary's absolute path, resolved on the target machine at install time, which is why capture arrives with the installer and why the native plugins above are installer-written rather than bundle-carried. **Plugin alone = skills + MCP tools on every harness**, authenticated by an External Agent grant — the one credential shape the pipeline admits without a machine identity, a protocol header or a Project header, none of which a plugin can supply, and whose surface (#1149) is already the six tools a symbiont reads. It reaches one Project, it is minted by an owner, and it expires (90 days by default), all three stated in the plugin's own README and in the setup skill.
- **The installer** (POSIX `sh`, PowerShell) places the binary and writes capture hooks with absolute paths. It adds capture, plan capture, import and the worker.

**The retained hook set** (plan §2.2, **landed in #1155**). For a harness the Deployment parses — Claude Code, Codex, Cursor, and the native-plugin harnesses — the hooks do three jobs and write no turn row: `SessionStart` registers the session with the hook-exclusive facts (git branch, parent session and reason) and injects; turn end (`Stop`, `SessionEnd`, `session.idle`) ships the transcript delta past the Deployment-held offset, the subagent transcripts written beside the session under their own identity and role, and the plan files the turn wrote — an `Edit` record carries only a diff, so the hook finds the write in the delta and reads the file; `UserPromptSubmit` injects, and ships a plan a person pasted inside a tag envelope under a key the parse never derives; `SubagentStart` injects into the delegated agent. Claude Code's re-injection after a compaction rides `SessionStart` with the `compact` matcher, which advances the compaction ordinal itself — its `PostCompact` output is discarded by the harness and cannot inject. Cursor's prompt hook can only block, so it is not wired; Cursor keeps `postToolUse` and `postToolUseFailure`, the one source of its tool calls, and its session block gets a second chance there. The member kinds on the wire are therefore `session.start`, `session.end`, `transcript.segment` and `plan`, plus `tool.use` and `tool.failure` from a harness whose transcript declares `no_tool_results`. Which side writes the turn rows is one manifest declaration, `turnRowSource`, held equal to the presence of a server parser by `tests/meta/parser-manifest-parity.test.ts`; a harness the Deployment does not parse (Copilot, Antigravity, Windsurf) keeps its hooks as the writer until a parser lands or the sweep (#1170) retires it. Transcript identity is (machine, path, inode, head digest): a file truncated and rewritten in place keeps its path and inode and changes only its head, so it ships again as a transcript of its own, and a pointer minted before the file had a digest keeps its id. The write-ahead spool stays, drained on the next hook with backoff, and a drain that delivers everything prunes the state of sessions delivered long ago.

**Sandbox images ship the CLI, hooks and a join code** — no resident service, symbionts fixed at build time, the container short-lived. The join code (URL + credential in the environment) is exchanged at first contact for a member credential bound to the Project resolved from the repo remote.

**Tenancy is a tool parameter, not a transport** (plan §3 D1). Every Myco tool accepts `project` — a git remote or a project id — and the server resolves remote → project by the Project Resolution rule (§3.1). Reads default to the member's bound projects; **writes require an explicit project**. Session-start injection tells the agent its project id where hooks are installed, and the `myco` skill tells it to pass the repo remote where they are not. The 1.4 CLI transport for tenancy-blind harnesses retires; `myco tool call` remains as a CLI surface onto the same server code path.

Home-pin creation during join is exclusive for both project and machine pins. A pin rejected by the trust reader is still an existing file: join preserves its bytes, target and permissions, reports that it could not write the pin, and retains the recorded membership. Pin contents and permissions are written through one open file descriptor.

Member provisioning reconciles hooks and the MCP entry independently. An unchanged hook file does not suppress a missing or changed MCP entry, and the join command reports an unchanged registration as such.

### 3.5 Cutover

The transition is a **one-time, one-way migration**, not long-term coexistence or dual writing.

The installed 1.4 binary owns its existing `myco remove --yes` behavior (**Legacy Removal Boundary**). The 2.0 installer invokes it **without `--purge`**, verifies the old service and integrations are stopped, and preserves the full 1.4 home and data. It then installs the 2.0 binary and hooks, runs the setup skill, verifies managed assets through `myco doctor`, and migrates all **active** Project data to the configured Deployment.

Source data is never automatically deleted. Historical vectors and derived assets are rebuilt under the 2.0 schema. Already-archived 1.4 Projects, legacy topology/config/credentials, old vectors, and retired Canopy entries do not migrate.

The current both-mode dogfood (1.4 user-level hooks plus the 2.0 member project-local on this repo) is preserved until the cutover child performs it, and the 1.4 tree is deleted in one sweep afterwards (plan §5) rather than ahead of it.

### 3.6 Run outcomes and the runner

A **run** is one prompt to one harness, on a worker, with declared expected evidence. There is no phased executor, no orchestrator, no resume and no turn budget: retry is the next tick, and steps are added only after a measured failure on a specific model. Partial writes stand and the run is marked partial.

**Three run outcomes and one config leaf** (plan §2.5):

| Outcome | Replaces | Checkout |
|---|---|---|
| Continuous extraction and curation — create, supersede, consolidate | `extract-only`, `vault-evolve`, `supersession-sweep`, `review-session` | no; an empty scratch dir with a Myco-owned instructions file |
| Brownfield seeding from code and git history | `vault-seed` | yes; saves the Project’s first spores and a run report |
| Session titles and summaries | `title-summary` | no |
| `instructions.template` (a Settings leaf, not a run) | `cortex-instructions`, `cortex-prompt-builder` | — |

`embedding-reconcile` stays a shipped server job. `myco_agent` stays the read surface over `agent_runs`.

**Instructions are config, not generation.** Session start serves a static, member-editable `instructions.template` (≤4 KB, Markdown, validated). With instructions static, a prompt builder has nothing to build, and the generated project digest is dropped with its loss recorded in §1 of the plan.

**Instructions to a run** are the prompt body plus a Myco-owned instructions file in the scratch dir — ACP carries user prompts only. Structured final output is not relied upon: a run succeeds by making MCP writes the server verifies afterwards.

**The runner** is a minimal **ACP v1** client over stdio plus native headless drivers — `claude -p --output-format stream-json --verbose --mcp-config … --strict-mcp-config` for Claude Code, `codex exec --json` for Codex — with the ACP driver serving OpenCode, Cursor and Antigravity. The published ACP adapters are npx packages, so native drivers are what keep **Node off every member and worker host**. One internal run-event model covers all three drivers and a gate holds them to the same contract; its five stop reasons are the protocol's own, and ACP v2 moves where they are delivered without changing what they are.

**Three launch shapes, not two**, which is why they are a manifest field rather than a rule applied thrice: a subcommand on the harness's own binary (OpenCode, Cursor), no protocol at all so a native driver reads the harness's own stream (Claude Code, Codex), and a sidecar binary the vendor ships separately (Antigravity). **Tool isolation differs the same way and only two of the five are airtight**: a flag that makes the run's configuration the only source (Claude Code), a redirected configuration home (Codex, whose inline server overrides otherwise add to the host's own), and additive for the rest, which the manifest states rather than a driver claiming an exclusivity it cannot enforce. **No driver decides its own run's outcome**: a run succeeds by making the MCP writes the server verifies afterwards, so a harness reporting success without them leaves a partial run.

**Workers** run the same binary in worker mode, and the laptop server process includes a worker by default. A worker offers the harnesses it has installed and logged in, claims the oldest run it can serve from a Deployment-wide queue, holds it on a lease it renews, and drives the harness the Deployment chose. **The Deployment decides every cadence and says it on each answer** — how long to wait before asking again, and how often to renew — so a worker carries none of its own and a lease changed on the server changes what every attached worker does. The claim is `POST /worker/claim`, a route scoped to the Deployment rather than to a Project — a worker names no Project, and the Project travels back on the run it is given. Only an administrator reaches it, decided at the pipeline: a claim answers with a minted run credential and a Deployment credential opened for the harness, and both are the Deployment's authority rather than a member's.

**Source-reading workers** advertise `repository-checkout` on the claim. Older workers leave repository tasks queued. A seeding claim carries only the repository URL, branch and history depth of 200. The worker opens the read credential and pins the commit through `POST /worker/repository`, under its administrator credential and current lease; the model's run credential cannot use this route or the legacy repository route. One checkout helper serves worker and retained container paths, with HTTPS-only Git, isolated Git configuration, disabled hooks and credential helpers, a 120-second preparation bound, a 256 MiB committed-file limit, and explicit rejection of LFS and submodules. Source lives at `repo/` in a unique scratch directory per attempt and is removed when the attempt ends. Codex source runs use its read-only sandbox; Claude source runs use manual permissions with explicit file/history read allowances and no permission prompts.

The claim takes a row and binds its credential in one statement, so a run never looks healthy while its credential resolves nothing, and it rewrites the run's start so the task's budget bounds the run rather than its wait. **Lease expiry returns the run to the queue** with its credential retired and its place in line kept — a different question from a run outrunning its own budget, which is failed rather than requeued. The two claim paths stay disjoint by construction: a worker takes only a queued row that names no credential, and the three tasks the seam still serves never enter its queue.

Detection reads local files and local processes, never the network — the published agent registry carries no credential field, so a probe is always of the tool itself. A Deployment declares a preferred harness with a fallback order (`worker.harness`, `worker.harness_fallback`), overridable per task through `agent.tasks.<task>.harness`; a cloud worker logs in once and its harness OAuth token or API key is held in the Deployment's encrypted secret store (class 3, §3.3.1) and injected per run. A laptop whose harness is already logged in needs none: the Deployment holds no key for it and injects nothing.

**A run's credential is a third principal kind** (#1145). A run token is not a member token. The pipeline admits the harness member's credential to two kinds of route only — a route that serves the run principal (`/mcp`, `route.run`) and the run routes it holds today with whatever admission each handler performs itself — `heldRun` on the task surfaces, none yet on the state and run-row handlers (`legacyRunRoute` on every `/runs/*` route, and on the fifteen that remain after #1146) — and refuses it everywhere else (`run_scope`), the refresh route included, so a run credential is never refreshable. On `/mcp` the one live run the credential dispatched is resolved from the credential alone (`heldRunOfCredential`: exactly one `running`, non-stale row names it, else `no_run`), the header must name the run's Project (`project_mismatch`), and the run's surface is its task's **declared** tools (`TASK_TOOLS`, `core/task-catalogue.ts`, held equal to the task files by a gate) mapped onto `(tool, op)` pairs (`mcp/run-surface.ts`) and enforced at the one chokepoint (`mcp/server.ts callTool`) with the same byte-identical refusal a grant gets; `tools/list` is narrowed to it, and a dry run keeps its reads and loses every write. Writes carry the run's agent as `agent_id` and the run id in the `author` column beside the dispatch-named session. A run's surface is two sets (#1146). Where its work is a member's work — every write of vault content, and search — it calls the catalogued tools, so one operation keeps one implementation and one attribution path. Where the operation is the run's own — an inventory of previews under a full-read budget, bodies cut to the task's window, full-fidelity session material, its state under a compare-and-set, its prompt cursor, and its own session's titling material and title — it calls four run-only tools (`mcp/run-definitions.ts`) that are not in `SERVED_TOOLS`, are listed to no member and no grant, and have no member-side counterpart. Every bound comes off one `ReadWindow` per task (`core/read-window.ts`), so no handler names a task. `myco_run` op `report` is served to every run outside the allowlist: a report is the run protocol rather than a task capability, and a task declaring no tools of its own still has to close. Ten `/runs/*` routes are deleted with the operations that replaced them; fifteen stay as the worker's and the seam's own channel, and two of those — `claim` and `report` — stay for a reason that is not "no MCP tool does this": the push-launch seam's container reaches them over HTTP and speaks no MCP, so both go with the seam in #1170. The handshake is the principal's too — a member, a run and a grant each read instructions true for their own surface, rather than one string that told a bound principal its writes need an argument they do not.

**Close evidence** stays server-side, with the report channel and single-flight: a run closes only when the server can see the rows it owed. Each outcome names its row (`RUN_CLOSE_RULES`, `core/run-postconditions.ts`): a titling run the title it wrote on its session, an extraction pass a prompt it marked read, a seeding run a spore whose `author` is the run — each keyed to THIS run by a write the run itself landed, never by a row that merely exists. A report alone is the model's word and closes nothing that owes a row; a skip report closes a pass that found nothing to do only where the server's own read agrees (`skipHolds`: no unread prompt, a seeded Project, a standing title), else the run fails on its artifact. The prompt a run is driven under is the Deployment's (`INPUT_BUILDERS`, `core/task-inputs.ts`), built at the claim, in the vocabulary of the tools the run's surface serves; the standing rules travel beside it as the instructions file the worker writes into the scratch directory (`writeRunDir`, `packages/myco/src/runner/mcp-config.ts`, under `AGENTS.md` and `CLAUDE.md`). A worker-served task the Deployment builds no prompt for is refused at dispatch as `no_instruction`; an outcome whose worker half has not landed (`UNLANDED_TASKS`) is refused as `not_landed`. External agents write under the same discipline through a per-project grant, attributed to the grant by an author column and an agent row, and may cite a PR or commit instead of a session.

**The wake tick is the only scheduler for Deployment work** — a `DeploymentClock` alarm with a cron floor on **W**, an in-process loop on **C**, both feeding one idempotent tick (`core/tick.ts`) with per-task per-day ceilings. Triggers are session end, the clock, and an explicit ask. The member binary registers no timers; the machine-side needs that survive — upgrade check, symbiont detection, managed-files reconcile — are the on-demand verbs `myco update` and `myco doctor`.

**Evals** gate the prompts: recorded real sessions as fixtures, redacted by a gate before commit, with a hand-annotated gold set of 30–50 cases; deterministic graders per PR against replayed recordings; a weekly (and on any task-prompt or skill change) judged run on a curated subset, capped per run; results on the KPI page and the weekly job required on releases.

**Principles (Chris, 2026-09-02, closed):**
- Every agent task runs through the agent harness with the configured provider and credentials. Title and summary are no exception. There is no interim direct model call, on either target. *(Stands. The harness is now an attached worker rather than a container — plan §2.5.)*
- The run is the unit of work: one run id, one container, any number at once across triggers, schedules, sessions and Projects. *(Superseded in mechanism by plan §2.5: the run is still the unit of work, but its host is a claimed worker lease, not a container.)*
- A constraint is configurable, never hard-coded. A limit means a queue, never a refusal. *(Stands; the queue is the claim queue workers poll.)*
- One core, two launch adapters; neither target loses the feature because the other landed it first (§3.3). *(Superseded in mechanism by plan §2.6: there is no launch adapter, because neither front door launches harnesses. The no-feature-loss half stands.)*
- Decisions about dispatch start from how 1.4 drives tasks today, and are recorded here before a slice builds on them. *(Stands. The 1.4 dispatch account this section carried is in git history; 1.4 retires per plan §5.)*

## 4. Owning-surface vocabulary

Every ledger row carries one or more of these. This is the closed set the gate accepts.

| Code | Surface | Owns |
|---|---|---|
| **M** | Member Installation | Binary, hooks, plugins, spool, member registry, capture, member credential, **worker mode** |
| **MS** | Member Service | **Retired** (§3.4). Reconciliation is the on-demand `myco update` / `myco doctor` verbs, owned by **M**. The code stays in the gate's closed set; no row carries it |
| **Core** | Shared server core | Vault, query core, serving, run queue and close evidence, notifications, access grants — target-independent |
| **W** | Cloudflare adapter | Target-specific mechanism on Cloudflare |
| **C** | Self-hosted adapter | Target-specific mechanism on the self-hosted binary |
| **UI** | Server dashboard | Human surface served by the Deployment |
| **MCP** | Server MCP surface | Normal member MCP and external read-only MCP |
| **—** | none | DROP rows only |

`Core` alone means the mechanism is identical on both targets. `Core + W/C` means the need is shared but the mechanism differs per target and **both must be named** before the row is implementable.

## 5. Actor × deployment target × lifecycle matrix

Actors follow [`actors-and-boundaries.md`](actors-and-boundaries.md): the **Myco agent** (internal harness), **Symbionts** (coding agents), and **Users** (humans). 2.0 adds **Operator** (Deployment infrastructure lifecycle) and **External Agent** (read-only MCP, non-member).

| Lifecycle stage | User | Symbiont | Myco agent | Operator | External Agent |
|---|---|---|---|---|---|
| **Install** | Plugin alone → skills + MCP tools; the installer adds binary + hooks + capture + worker (**M**) | — | — | — | — |
| **Setup** | The setup skill — install, log in or join, enable hooks, verify with `doctor` (**M** → **Core**) | — | — | `myco server create` (**W**/**C**) | — |
| **Server operation** | — | — | — | `myco server update\|inspect\|rotate\|backup\|adopt\|restore\|remove\|github-app` (**W**/**C**; `github-app` registers the dashboard's sign-in app on GitHub from a manifest and installs its credentials) | — |
| **Enrollment** | Invite link or `myco login <url>` → Member Credential at the role the invitation grants; a sandbox exchanges its join code from `MYCO_JOIN_CODE` (**Core**) | — | — | An **admin** issues invites and join codes, naming the role and the Project each binds (**Core**, **UI**) | Receives a project-scoped grant: read plus spore create/supersede attributed to the grant (**Core**) |
| **Capture** | — | Hooks write-ahead to spool, drain to Deployment (**M** → **Core**) | — | — | none |
| **Intelligence** | Views results (**UI**) | Reads via MCP (**MCP**) | Runs outcomes on an attached worker under a run-scoped credential (**M** + **Core**) | — | Writes spores under a grant (**MCP**) |
| **Recall** | — | Session-start `instructions.template` and prompt-submit injection (**Core**) | — | — | Project-scoped MCP under a grant (**MCP**) |
| **Admin** | Deployment Settings, enrollment, external grants, provider credentials — all members, flat (**UI**, **Core**) | — | — | — | none |
| **Local health** | `myco doctor` (**M**) | — | — | — | — |
| **Maintenance** | — | — | — | — | — |
| ↳ machine-side | `myco update` / `myco doctor`, on demand (**M**) | — | — | — | — |
| ↳ server-side | Retention, optimize, integrity, backup (**Core** + **W**/**C**) | — | — | — | — |
| **Backup/restore** | Backup from dashboard (**UI**) | — | — | Restore is a break-glass operator procedure (**W**/**C**) | — |
| **Project movement** | Project Binding change (**M**) | — | — | Project Reassignment (**Core**) | — |
| **Update** | `myco update` reconciles managed assets and the managed AGENTS.md block (**M**) | — | — | `myco server update` (**W**/**C**) | — |
| **Migration** | 1.4 → 2.0 one-time cutover (**M** + **Core**) | — | — | — | — |
| **Removal** | `myco remove` (member only; server destroyed by Operator) (**M**) | — | — | `myco server remove` (**W**/**C**) | — |

**Sandbox Runtime** is not a row: it is a **Member Runtime** acting as the same member, installed from the image with a join code in its environment.

## 6. Contradictions called out explicitly

#906's acceptance requires that every contradiction with current code and the settled glossary be stated, not silently reconciled.

### 6.1 The parity audit vs. the settled glossary

The audit (`64d8f59006e9b912`) predates the Wayfinder decision session. Its per-row dispositions are sound and carried forward; these framings are **superseded**:

| Audit said | Now settled as | Where |
|---|---|---|
| "Multi-user access — phase 2, out of scope" (§9) | **Flat Membership is a v2.0.0 requirement.** Multi-member enrollment, credentials, and attribution ship before release (#912) | Glossary "Flat Membership (2.0)" |
| "two tiers — **owner** settings on the server" (OPEN-5) | Two tiers survive, but the server tier is **Deployment Settings**, manageable by **all members**, not an owner | Glossary "Deployment Settings" |
| "the **tokens** view *is* it" — per-project member tokens (OPEN-6) | Per-Project member tokens are **implementation baseline, not the destination**. Members hold one individually attributable Member Credential with full Deployment access | `wisdom-5b9069b8` |
| "Groves DROP — the server's `projects` table is the tenancy unit" (§6) | Grove drops, but the replacement boundary is **Deployment**; `Project` is the shared identity **within** it. Tenancy and identity are two nouns, not one | Glossary "Deployment", "Project" |
| "migrates one server per Grove or consolidated" | A Deployment contains **many** Projects. "One server holds one Project" was an intermediate design | `wisdom-5b9069b8` |
| Local service = symbiont health (OPEN-10) | Superseded again on 2026-09-07 (§2.3): there is no resident member service at all. Reconciliation across managed assets and every registered Project is the on-demand `myco update` / `myco doctor` verbs | §3.4 |
| Owner column names Plans 4b/4c/5/6 | Those plans no longer exist. Owners are GitHub children #906–#927 | #905 |
| "Restore … BREAK-GLASS rather than a dashboard button" | Unchanged in substance, now expressed as the `myco server restore` Operator path | Glossary "Server Provisioning" |

### 6.2 The glossary vs. current code

The settled glossary names surfaces the tree does **not yet carry**. These are additions, not 1.4 dispositions, and are excluded from §7's ledger by construction — the ledger disposes of the **1.4** surface:

| Named in glossary | State in `main` @ `258d2fbe` | Owner |
|---|---|---|
| `myco setup` (rerunnable post-install workflow) | **Absent.** Setup today is `myco member join --provision` | #916 |
| `myco server ...` (Operator lifecycle) | **Absent.** Provisioning today is `wrangler` plus `scripts/mint-local.ts` | #913, #914 |
| Deployment / Default Deployment / Project Binding | **Absent.** The member registry binds a project to a server URL, with no Deployment concept | #916 |
| Enrollment Authority → Member Credential exchange | **Absent.** Tokens are minted per project by the owner | #907 (mechanism), #912 (implementation) |
| Flat Membership | **Absent.** Single-owner GitHub OAuth | #912 |
| External Agent Access | **Absent.** | #921 |
| Project Reassignment | **Absent.** | #923 |

### 6.3 Shipped code that is baseline, not destination

`main` carries working implementations that the destination model **will replace**. They are not defects and must not be treated as settled precedent:

- **Single-owner GitHub OAuth** (#904) — replaced by flat multi-member enrollment (#912) once #907 settles the mechanism.
- **Per-Project member tokens** (#900, #901) — replaced by the individually attributable Member Credential (#912).
- **Both-mode 1.4/2.0 dogfood** — deliberately preserved until #924 cuts over (§3.5).

## 7. The feature-preservation ledger

Every row: an exact registry token, a disposition, an owning surface, and the child that carries it.

**A row's disposition describes the code as it stands, not the code as it is planned** (plan §6). The gates in §9 and the four server gates that read this document hold the ledger against the tree, so a token that still exists carries the disposition it has today and names its planned fate in the reason column; the disposition changes in the PR that changes the code. A surface that does not exist yet is described in the **Planned additions** block under its subsection rather than given a row, for the same reason. `Blk` marks release-blocking (must close before `myco/v2.0.0`); `—` marks non-blocking follow-up.

Dispositions: **KEEP** — exists in 2.0 in recognisable form. **REPLACE** — the need survives, the mechanism changes; the replacement is named. **DROP** — the need itself disappears; a reason is required, and "no local daemon" is a reason only when the capability existed *to manage* the daemon.

### 7.1 CLI commands — `packages/myco/src/cli.ts`

| Command | Disposition | Surface | Blk | Replacement / reason | Owner |
|---|---|---|---|---|---|
| `member` | KEEP | M | Blk | Already the 2.0 surface; gains Deployment-aware join | #916 |
| `import` | KEEP | M | Blk | New in 2.0: brings a machine's existing agent transcripts to its Deployment — run once automatically at join, repeatable with a wider window. Bounded by the Deployment's `import.*` leaves, attributed per Project through the local registry so a machine with several checkouts imports all of them, deduped against the bytes the Deployment already holds, and gated on `session_tombstones` (plan §2.2) | A4 |
| `login` | KEEP | M | Blk | Redeems a single-use expiring invite link for this machine's membership; a sandbox exchanges the same string from `MYCO_JOIN_CODE` instead (plan §2.7) | #1158 |
| `server` | KEEP | C, W | Blk | The operator surface for both front doors: the self-hosted binary under `--target local` — `create`, `run`, `install`, `uninstall`, `status`, `update`, `destroy`, no container runtime and no Node on the machine that serves — and Cloudflare provisioning reduced to one verb over a worker bundle the binary carries, with `--url` putting the Deployment on a domain the operator owns (plan §2.6). Node and wrangler are an operator-machine prerequisite for the Cloudflare verbs alone | D1, D2 |
| `settings` | KEEP | M | Blk | Sandbox entry point; #927's proof runs through it | #917 |
| `hook` | KEEP | M | Blk | The capture entry point | #917 |
| `mcp` | KEEP | M, MCP | Blk | Retargeted at the Deployment as remote HTTP MCP; tenancy travels as the tools' `project` parameter (plan §3 D1) | A6 |
| `tool` | KEEP | M, MCP | Blk | CLI mirror of the same server code path. The 1.4 CLI transport that existed only to carry tenancy for Codex, Cursor and Antigravity retires with it (plan §3 D1) | A6 |
| `version` | KEEP | M | Blk | | #917 |
| `update` | KEEP | M | Blk | Member self-update, and the on-demand reconcile that replaces the resident service: managed assets, hooks, plugins and the managed AGENTS.md block (plan §2.5) | C2 |
| `doctor` | REPLACE | M | Blk | Checks member wiring, credential liveness, spool depth, harness detection **and Deployment reachability from this machine**; the second on-demand reconcile verb (plan §2.5) | C2 |
| `remove` | REPLACE | M | Blk | Member uninstall only; a Deployment is destroyed by the Operator, not the CLI | #917 |
| `open` | REPLACE | M | Blk | Opens the Deployment dashboard URL | #918 |
| `search` | REPLACE | M, Core | Blk | Server-backed search + vector adapters | #921 |
| `vectors` | REPLACE | M, Core | Blk | Server-side vector search | #921 |
| `session` | REPLACE | M, Core | Blk | Server-backed read | #921 |
| `stats` | REPLACE | M, Core | Blk | Deployment quota/storage/schema health; today reads a local SQLite file | #922 |
| `logs` | REPLACE | M | Blk | Local log files under `MYCO_HOME` with a CLI view; server logs are a separate surface (**UI**) | #922 |
| `config` | REPLACE | M, Core | Blk | Two tiers: Member Settings local, Deployment Settings server-side | #915 |
| `setup-llm` | REPLACE | Core, UI | Blk | Deployment Settings — Intelligence Provider credentials | #915 |
| `setup-digest` | REPLACE | Core, UI | Blk | Deployment Settings — schedules and retention. **Planned DROP in #1170 (sweep)** per plan §1 and §3 D2: the generated digest goes, and what survives are Settings fields rather than a verb | #1162 |
| `detect-providers` | REPLACE | Core | Blk | Server-side provider detection under Deployment Settings | #915 |
| `verify` | REPLACE | Core | Blk | Server-side provider connectivity check | #915 |
| `agent` | REPLACE | M, Core | Blk | Becomes `myco worker`: the same binary claiming runs from the queue and driving a local harness (plan §2.5) | B1 |
| `worker` | KEEP | M | Blk | New in 2.0: attaches this machine's harnesses to a Deployment. Offers what it finds installed and logged in, claims one run at a time across every Project the Deployment serves, holds each on a lease it renews at the cadence the Deployment names, and drives the harness the Deployment chose. `--detect` prints what the machine has and exits; the laptop server process runs one in-process unless `--no-worker` | B1 |
| `task` | REPLACE | Core | Blk | The three run outcomes, defined server-side; no phased executor, no per-task turn budget (plan §2.5) | B2 |
| `upgrade` | REPLACE | M | Blk | Folds into `update` | #922 |
| `__apply-update` | REPLACE | M | Blk | Internal update orchestration retained under the 2.0 installer | #922 |
| `__restore-backup` | REPLACE | W, C | Blk | Restore becomes the `myco server restore` Operator path | #923 |
| `__finish-uninstall` | REPLACE | M | Blk | Internal teardown retained for member-only removal | #917 |
| `daemon` | DROP | — | Blk | There is no daemon and no resident member service: no vault, no UI, never on capture's path | #925 |
| `restart` | DROP | — | Blk | Nothing to restart on a member machine; the self-hosted server's user-service lifecycle is the installer's | #925 |
| `service` | DROP | — | Blk | 1.4's platform service exists to manage the daemon that retires with it | #925 |
| `subsystem` | DROP | — | Blk | Machine-global daemon ownership arbitration; no daemon to arbitrate | #925 |
| `grove` | DROP | — | Blk | Grove is deleted; Deployment is the boundary | #925 |
| `join` | DROP | — | Blk | Team Host enrollment retired; `member join` is the 2.0 path | #925 |
| `leave` | DROP | — | Blk | Team Host detach retired; `member leave` is the 2.0 path | #925 |
| `attach` | DROP | — | Blk | Team Host project routing retired; Project Binding replaces it | #925 |
| `detach` | DROP | — | Blk | Team Host project routing retired | #925 |
| `host` | DROP | — | Blk | Team Host serving retired; a Deployment is the server | #925 |
| `init` | DROP | — | Blk | Already a no-op stub — registration is automatic on first hook | #925 |

**Not yet proven for the self-hosted binary.** Two claims in §3.3's C column are held by tests that run against source rather than against a released artifact: the compiled binary is built in CI but never executed there, and the carried SQLite library is exercised only where the build has staged it (CI stages it; a fresh checkout does not, and the gate fails rather than skips when `CI` is set). Both close with the release gate in §8, not with the child that added them.

**Planned additions.** None: laptop mode's first member is the one join `myco login` cannot serve — a Deployment created by `myco server create --target local` holds no member until an invite can be minted, and the start path exposes its `ServerEnv` for the first-start bootstrap that mints one (**#1158**, after D1). `myco worker` (**#1151**) and `myco import` (**#1148**) have landed and take their rows above.

### 7.2 Dashboard routes — `packages/myco/ui/src/App.tsx`

The 1.4 URL shape is Grove- and machine-scoped (`/g/:groveSlug/...`, `/machine`). 2.0 is **project-first within one Deployment**, so every Grove-scoped and machine-scoped path drops as a *URL shape* even where the *page* is kept — the page's disposition is what the row records, and the redirect chains that exist only to forward 1.4 bookmarks drop with them.

| Route | Disposition | Surface | Blk | Replacement / reason | Owner |
|---|---|---|---|---|---|
| `/` | KEEP | UI | Blk | Root redirect into the project-first dashboard | #918 |
| `/onboarding` | REPLACE | UI | Blk | 1.4 onboards a local install; 2.0 onboards a member and a first Project | #918 |
| `/g/:groveSlug/p/:projectSlug` | REPLACE | UI | Blk | Project dashboard at a Deployment-relative project path; the Grove segment goes | #918 |
| `sessions` | KEEP | UI, Core | Blk | Read API shipped (#904); UI in #918 | #918 |
| `sessions/:id` | KEEP | UI, Core | Blk | Session detail — facts, children, transcript | #918 |
| `cortex` | DROP | — | Blk | **Dropped by #1162**: the page does not port. Its one surviving control is the `instructions.template` Settings field (§7.8); the digest and the code map keep their artifacts and their server routes until #1170 sweeps them, with both losses recorded there | #1162 |
| `skills` | DROP | — | Blk | **Dropped by #1162**: with the generation pipeline going and skills hand-written in the plugins, the page has nothing to curate, and `myco_skills` answers from the catalogue Myco ships rather than from rows (#1156). A search hit of type `skill` therefore has no page and is rendered without a link. The candidate queue and the skills tables go with the pipeline in #1170 | #1162 |
| `agent` | REPLACE | UI, Core | Blk | `agent_runs` is rows, not files. **Replaced by #1162** at `/p/:projectId/runs`: one row per run outcome with its close evidence; the 1.4 page is not ported (plan §2.8) | #1162 |
| `agent/:id` | REPLACE | UI, Core | Blk | Run detail with phases and write intents. **Replaced by #1162** at `/p/:projectId/runs/:runId`: the task, the credential that dispatched it, the calls it made back to the Deployment, and its reports; phases and write intents go with the executor (plan §2.5) | #1162 |
| `/settings` | REPLACE | UI, Core | Blk | Rebuilt against Deployment Settings + Member Settings; the four-tier scoped model does not survive | #915 |
| `/logs` | REPLACE | UI, Core | Blk | Server logs from emitted telemetry. 1.4's **local** Logs page does not port — local logs are CLI-only (**M**) | #922 |
| `/g/:groveSlug/operations` | REPLACE | UI, W, C | Blk | Backup/diagnostics/update, per-target mechanism | #923 |
| `/g/:groveSlug/dashboard` | REPLACE | UI | Blk | Grove dashboard folds into the Deployment status surface | #918 |
| `/machine` | REPLACE | UI | Blk | Machine tier is gone; the equivalent question ("which runtimes write here, are they alive?") is a Deployment members/runtimes view | #918 |
| `/system` | REPLACE | UI | Blk | Folds into the Deployment status surface | #918 |
| `/symbionts` | REPLACE | M | Blk | Symbiont detection is a **machine** question — `myco doctor`, not a dashboard page | C2 |
| `/groves` | DROP | — | Blk | Grove is deleted | #925 |
| `/team` | DROP | — | Blk | Team Host retired; membership is flat within a Deployment | #925 |
| `mycelium` | DROP | — | Blk | The semantic graph was retired 2026-04-18; do not rebuild without a retrieval consumer | #925 |
| `/machine/settings` | DROP | — | Blk | Legacy redirect for a tier that no longer exists | #925 |
| `settings` (project-scoped) | DROP | — | Blk | Legacy redirect into the unified page | #925 |
| `operations` (project-scoped) | DROP | — | Blk | Legacy redirect to the Grove-scoped page | #925 |
| `team` (project-scoped) | DROP | — | Blk | Legacy redirect to a retired page | #925 |
| `/g/:groveSlug/settings` | DROP | — | Blk | Legacy Grove-scoped redirect | #925 |
| `/g/:groveSlug/maintenance` | DROP | — | Blk | Legacy redirect; maintenance folds into operations | #925 |
| `/g/:groveSlug/team` | DROP | — | Blk | Legacy redirect to a retired page | #925 |
| `/g/:groveSlug/team/maintenance` | DROP | — | Blk | Legacy redirect to a retired page | #925 |
| `/sessions` | DROP | — | Blk | Legacy unscoped redirect; 2.0 paths are project-scoped from the start | #925 |
| `/sessions/:id` | DROP | — | Blk | Legacy unscoped redirect | #925 |
| `/cortex` | DROP | — | Blk | Legacy unscoped redirect | #925 |
| `/mycelium` (unscoped) | DROP | — | Blk | Legacy redirect to a dropped page | #925 |
| `/agent` | DROP | — | Blk | Legacy unscoped redirect | #925 |
| `/agent/:id` | DROP | — | Blk | Legacy unscoped redirect | #925 |
| `/skills` | DROP | — | Blk | Legacy unscoped redirect | #925 |
| `/operations` | DROP | — | Blk | Legacy unscoped redirect | #925 |
| `*` | KEEP | UI | Blk | Catch-all redirect | #918 |

**The 2.0 dashboard's own routes.** The rows above dispose of the 1.4 surface. These are the routes the 2.0 dashboard registers in `packages/myco-server/ui/src/App.tsx`; the completeness gate scans the 1.4 file, so these rows are the record rather than the gate.

| Route | Disposition | Surface | Blk | What it serves | Owner |
|---|---|---|---|---|---|
| `/p/:projectId/plans` | NEW | UI, Core | Blk | Every plan a Project holds, newest edit first, filtered by status. The card is the session timeline's own, and a status change writes through `POST /api/projects/{projectId}/sessions/{sessionId}/plans/{planKey}/status` — the one route that owns a plan's status. Read over `GET /api/projects/{projectId}/plans` (**#1162**) | #1162 |
| `/measures` | NEW | UI, Core | Blk | The KPI page: six measures, each rendered with its sample size — prompts that arrived with any Myco context (primary), prompts served an observation, Myco calls per prompt with a per-harness split, plan reads per session, the median wait from a credential lineage starting to its first served context, and the evaluation pass rate. Computed Deployment-wide at read time from `prompt_batches`, `spore_injections`, `session_injections`, `tool_calls`, `sessions`, `transcripts.agent` and `member_credentials` over `GET /api/kpis` (`read/kpis.ts`). The evaluation measure has **no feed** until **#1154** and renders `n = 0` with "no evaluations recorded" rather than a figure (plan §2.8, **#1162**) | #1162 |
| `/access` | KEEP | UI, Core | Blk | Members, invitations and the runtimes that write here, titled **Members**. Issue and withdraw an invitation, remove a member, stop a runtime, and read one runtime's activity. The grants an External Agent holds are per Project at `/p/:projectId/access` (**#1149**); sign-in and identity are **#1158**/**#1086** (plan §2.8, **#1162**) | #1162 |

**Still not ported, and that is a decision.** The 1.4 Agent, Cortex, Skills, Team and Canopy pages do not appear in the 2.0 dashboard, and the list above is the whole of what replaced them. The rows for `cortex` and `skills` are DROP, not deferral: nothing is waiting to build them.

### 7.3 MCP tools — `packages/myco/src/tools/definitions.ts`

Every tool is served over remote HTTP MCP by the Deployment, and every tool takes a `project` parameter: reads default to the member's bound projects, writes are refused without one (plan §3 D1). Three principals share the surface — a member credential, a **run-scoped credential** whose allowlist is the task definition's declared tools mapped onto `(tool, op)` pairs (`mcp/run-surface.ts`, #1145, remapped by #1146: `vault_create_spore` and `vault_resolve_spore` reach `myco_spores` and the two searches reach `myco_search`, while the bounded reads and the run's own bookkeeping moved to the run-only tools) and whose writes are attributed to the run — a surface in two sets since #1146, the catalogued tools for work a member also does and four run-only tools (`myco_run`, `myco_run_spores`, `myco_run_sessions`, `myco_run_prompts`) for the run's own bounded reads, state, prompt cursor and titling, which are not in `SERVED_TOOLS`, carry no row here, and are listed to no other principal — and an **external-agent grant** limited to project-scoped reads — `myco_skills` among them, though a grant is told a skill's body is not served to it, since it holds no copy — plus `myco_spores` `save` and `supersede` attributed to the grant, which carries an `agents` row of its own so its writes are revocable as a group (#1149; plan §2.5, §2.6). A grant has no Myco session, so such a write may cite the pull request or commit that produced it instead (`provenance_kind`/`provenance_ref`). Each bound principal — run or grant — is judged at the one chokepoint (`mcp/server.ts callTool`) before arguments are validated, and is told `unknown_tool` for a `(tool, op)` off its surface or a `project_id` other than its own. `alwaysLoad` is set on the entry, paired with a session-start health ping so a cold front door does not stall the session.

| Tool | Disposition | Surface | Blk | Replacement / reason | Owner |
|---|---|---|---|---|---|
| `myco_search` | REPLACE | MCP, Core | Blk | Server-side search + vector adapters; previews render each spore's `agent_line`, not its Markdown (plan §2.4) | A6 |
| `myco_cortex` | REPLACE | MCP, Core | Blk | Serves `instructions` alone, its new default op, answering the `instructions.template` Settings leaf and the Project id beside it. `notifications` (#922), `maintenance_summary` (#923), `digest`, `canopy_map` and `canopy_entry` stay declared on the tool and answer `not_served`, so a 1.4 runtime keeps its own handlers while a Deployment offers none; the digest and Canopy ops go with their artifacts in #1170, both losses recorded (plan §1, §3 D2). Blocked MCP levers: `instructions` rides the `initialize` result, but `server/discover` stays unregistered — a client hearing a discover answer skips `initialize` and envelopes its requests, which the per-request JSON transport does not speak — and `cacheHints` is emitted only by that same codec, so a `tools/list` hint would be discarded | #1150 |
| `myco_sessions` | KEEP | MCP, Core | Blk | The query core already serves this shape | A3 |
| `myco_plans` | KEEP | MCP, Core | Blk | Myco owns plan identity, versions, provenance and search; content writes through MCP are for plans with no file, and status is set only by an explicit status-only save (plan §2.3) | A3 |
| `myco_spores` | KEEP | MCP, Core | Blk | The write surface for the extraction outcome, for members, and — `save` and `supersede` only — for an external agent's grant, whose writes carry the grant as both agent and author and may cite a pull request or commit in place of a session (**landed in #1149**; plan §2.6) | A5 |
| `myco_skills` | KEEP | MCP, Core | Blk | Answers from the skills that ship with Myco, read from one generated catalogue rather than from storage, so a Deployment holding no rows still answers a fresh install's first call (**landed in #1156**). The catalogue carries listing text and **no bodies**: it is bundled into the Worker script, whose size ceiling is a free-tier tripwire, and nine bodies are 57 KiB growing with every skill added. `get` therefore names where a body sits rather than returning it — under the Myco home for a machine running the binary, which holds every body whether or not a plugin is installed. **An External Agent grant loses the body**, and is told so: it holds neither binary nor plugin, and `myco_cortex instructions` already tells it not to reach for skills. The generation pipeline, the candidate queue and their tables are deleted in #1170 (plan §2.4, D3) | C2 |
| `myco_agent` | KEEP | MCP, Core | Blk | The read surface over `agent_runs` — the runs, their outcomes and the evidence the server verified (plan §2.5) | B2 |

### 7.4 Agent tasks — `packages/myco/src/agent/definitions/tasks/`

2.0 keeps three run outcomes and one config leaf (§3.6). The phased executor, turn budgets and per-task model routing do not survive: a task is one prompt with declared expected evidence, run on an attached worker. The `agent_runs` audit trail stays.

**A run's outcome is the Deployment's, not its runtime's.** Every retained task declares what one of its runs must have left behind — a report action, the row it owed, or both (`RUN_CLOSE_RULES`, `core/run-postconditions.ts`; held equal to this catalogue by `tests/myco-server/task-catalogue.test.ts`, which also holds the three outcomes, their close rules and their input builders (`INPUT_BUILDERS`, `core/task-inputs.ts`) to one another: no outcome without a rule and a prompt, no rule or prompt without an outcome). A worker-served task the Deployment builds no prompt for is refused at dispatch (`no_instruction`) rather than queued. Both front doors a run ends through judge the same rule: a container reporting over `POST /runs/update`, and a worker reporting for the run it leases over `POST /worker/end`. A `completed` report whose evidence is absent is recorded `failed` naming what was owed; the report is still accepted, so the lease ends and the run credential is retired either way.

**Worker accounting.** Native workers report cumulative usage with their claimed attempt id on `POST /worker/end`. The Deployment validates counts and dollar values, resolves cost through `core/cost`, and writes accounting and final status atomically under the current worker lease and dispatch identity. Duplicate or stale attempts cannot replace the recorded values. Unknown counts and cost remain null. Claude's query-wide `modelUsage` includes cache reads and writes; its `total_cost_usd` is a harness estimate, stored as `estimated` with no actual charge. Codex reports inclusive input/output counts and cached input, with cost `unavailable` when no price is reported. Dashboard and MCP read the same persisted record. Older workers and claims without an attempt id can still complete without reporting accounting. Recording cost does not enforce a spending cap.


| Task | Disposition | Surface | Blk | Replacement / reason | Owner |
|---|---|---|---|---|---|
| `extract-curate` | KEEP | Core | Blk | New in 2.0: the **continuous extraction and curation** outcome (plan §2.5), replacing `extract-only`, `vault-evolve`, `supersession-sweep` and `review-session`. One pass reads a page of the prompts nobody has read (`myco_run_prompts` op `unprocessed`, the prompt and an excerpt of its first response), searches before every write, saves, supersedes, consolidates or obsoletes through `myco_spores` — each save carrying the spore's `agent_line`, the one-line projection injection serves (§7.6 v27) — marks every prompt it read through `myco_run_prompts` op `mark_processed`, and closes with action `extract` or `skip`. The Deployment builds the prompt (`core/extraction-input.ts`) and hands the standing rules beside it as the run's instructions file, which the worker writes into the scratch directory under the names harnesses read project instructions from. Its close evidence is the report and — the row the pass owed — a prompt THIS run marked read, keyed to the run by the `run_write` row the mark lands (`promptsMarkedBy`); a spore it saves names the run in `author`. A `skip` closes it only when the server finds no unread prompt. Partial writes stand: the next tick reads on from the prompts the pass did not mark. No checkout; budgeted 900 s; scheduled hourly in idle or sleep, with a 12-run rolling-day ceiling and the `has-unprocessed-prompts` precondition (`TASK_SCHEDULE`, `core/jobs.ts`). Admitted by `vault_evolution`. | B2 |
| `vault-seed` | KEEP | Core | Blk | The **brownfield seeding** outcome: one pass over the connected repository's code and git history, writing the Project's first spores through `myco_spores` op `save` and closing with action `seed` or `skip`. The Deployment builds the prompt (`core/seeding-input.ts`) and supplies the run's scratch instructions. Close evidence is the report and a spore authored by this run (`sporesWrittenBy`); a skip requires `SEEDED_SPORE_FLOOR` active spores. Seeding does not generate repository rules or an AGENTS.md block. Managed AGENTS.md guidance belongs to settings-driven installation and reconciliation, such as plan-directory gitignore behavior; user-requested rules are authored through `myco-rules`. Manual-only, budgeted 3600 s, with a lease-bound worker checkout and an immutable source commit in the run context (#1152). | B2 |
| `title-summary` | KEEP | Core | Blk | The **session titles and summaries** outcome: dispatched on a session's end and on an ask, run on a worker, no direct provider call on the server (plan §2.5). Its close evidence is a report with action `summary` and — the run's whole product — a title THIS run wrote on the session its dispatch named, read off the run's own recorded context (`core/run-postconditions.ts`). The run key is the `run_write` row the title write lands (§7.6), not a title standing on the session: an owner may re-title any session over whatever is there, so a run that reported and never called would otherwise pass on an earlier run's title. A harness that ends its turn without ever calling the Deployment leaves neither, and the run is recorded `failed` naming what it owed rather than `completed` on the worker's word | B2 |
| `embedding-reconcile` | KEEP | Core | Blk | Not a run outcome: a deterministic server job on the wake tick, admitted by the embedding provider (plan §2.5). Cloudflare uses Workers AI `@cf/baai/bge-m3` and Vectorize; self-hosted uses sqlite-vec with configured Ollama, OpenAI-compatible, OpenAI or OpenRouter embeddings. Run steps reconcile missing and stale vectors, orphan deletion and spore hubness. | #1124 |
| `canopy-map` | REPLACE | Core | Blk | Grows a scan/diff phase using normal harness code-exploration tools and content hashes; maintains the map as a living document. Its close evidence is a report with action `map` or `map-unchanged` and — for a report that claims a write — the current map row pinned to the source and repository this run was dispatched against, with `source_run_id` naming this run or the revision it succeeded (`canopyMapWrittenBy`). **Gated on #910's accepted content prototype**. **Planned DROP in #1170 (sweep)** per plan §1: the owned repo map goes and its loss is recorded — orientation comes from the harness's own tools and, optionally, a deterministic third-party graph the doctor recommends. | #1170 |
| `container-smoke` | KEEP | Core | Blk | New in 2.0: the end-to-end proof for a server-dispatched containerized run — claim, harness, one report, terminal status. Server-dispatched only, and it carries a declared daily schedule (`TASK_SCHEDULE`, `core/jobs.ts`: 24 h in `sleep`, two a day), which is what gives the probe a cadence and a per-day ceiling. Its whole product is that one report, so it holds `myco_run` op `report` even though it declares no tools of its own (#1146), and that report with action `container-smoke` is its close evidence. **Planned DROP in #1170 (sweep)** per plan §4 B1: replaced by the worker smoke — one run dispatched end to end on Claude Code, Codex and OpenCode, and a killed worker's run returning to the queue at lease expiry; the fixture is cut over before this task is removed. | #1170 |
| `digest-only` | DROP | — | Blk | The generated project digest goes, and its loss is recorded (plan §1, §3 D2): an agent gets no project-state summary before its first prompt and is told to search. #1152 removed the task from the server catalogue, its input builder, its close rule, its three run routes (`/runs/instruction`, `/runs/digest`, `/runs/digest-write`) and its material windows; its run could never write its artifact over the MCP surface a worker serves (#1216). Stored digests stay readable on the dashboard until the sweep drops `digest_extracts`. The task file goes with the sweep. | #1152 |
| `cortex-instructions` | DROP | — | Blk | Instructions are configuration, not generation (plan §2.4). The `instructions.template` Settings leaf replaced the artifact in #1150, which removed the task from the server catalogue, its input builder, its close rule and the `POST /runs/instructions-write` route. The task file under `packages/myco/src/agent/` and the `cortex_instructions` table go with the sweep. | #1150 |
| `cortex-prompt-builder` | DROP | — | Blk | Static instructions leave nothing to build (plan §2.5): session start serves `instructions.template`, so a pasteable prompt has no consumer on a Deployment. #1152 removed the task from the server catalogue; the task file and the dashboard's Builder tab go with the sweep. | #1152 |
| `extract-only` | DROP | — | Blk | Folded into `extract-curate` (plan §2.5): the quick extraction pass is the one pass there is. #1152 removed it from the server catalogue; the task file goes with the sweep. | #1152 |
| `vault-evolve` | DROP | — | Blk | Folded into `extract-curate` (plan §2.5): create, supersede, consolidate in one prompt, with the digest tiers and the phased executor it drove both gone. #1152 removed it from the server catalogue; the task file goes with the sweep. | #1152 |
| `supersession-sweep` | DROP | — | Blk | Folded into `extract-curate` (plan §2.5), which names consolidation as its own work and searches before every write. The inventory-then-resolve tool shape survives as that outcome's allowlist, so a pass still never pulls a whole vault into a model's context. #1152 removed it from the server catalogue; the task file goes with the sweep. | #1152 |
| `review-session` | DROP | — | Blk | Folded into `extract-curate` (plan §2.5): extraction runs continuously over sessions as they land, so a separate per-session review has no place. #1152 removed it from the server catalogue; the task file goes with the sweep. | #1152 |
| `skill-survey` | DROP | — | Blk | Skill lifecycle (plan §2.4 D3): the generated-skill pipeline goes; two hand-written skills ship with the plugins and five of the 52 existing files are rewritten by hand. #1152 removed the task from the server catalogue; the skill tools, tables and task file go with the sweep. | #1152 |
| `skill-generate` | DROP | — | Blk | Skill lifecycle (plan §2.4 D3): no generation pipeline, no candidate queue. #1152 removed the task from the server catalogue; the rest goes with the sweep. | #1152 |
| `skill-evolve` | DROP | — | Blk | Skill lifecycle (plan §2.4 D3): hand-written skills are revised by hand. #1152 removed the task from the server catalogue; the rest goes with the sweep. | #1152 |
| `canopy-describe` | DROP | — | Blk | Per-file descriptions and entry embeddings go with the map (plan §1) | #1170 |
| `harness-health` | DROP | — | Blk | A worker inspects its own harnesses and files findings into the notifications domain the 1.4 consumer owned; the local half is a `doctor` check (plan §2.5, §5) | #1170 |

The managed-block renderer preserves examples inside backtick and tilde fences, including shorter or different delimiters within an example. It scans fence state and marker offsets together. An unclosed fence is refused, including when the file has no managed markers, so an appended block cannot become part of an unfinished example.

### 7.5 Scheduled jobs — `packages/myco/src/constants/power-jobs.ts`

**The server-side wake tick is the only scheduler, and it schedules Deployment work only** (plan §2.5). The member binary registers no timers: the machine-side needs that survive 1.4's JobRunner — upgrade check, symbiont detection, managed-files reconcile — become the on-demand verbs `myco update` and `myco doctor`, run by the setup skill and the installer. PowerManager, its four power states and its ~24 machine-side jobs retire with the daemon (plan §5).

One idempotent tick (`core/tick.ts`) runs the due jobs, applies per-task per-day ceilings and drains the run queue; `POST /api/wake` runs the same tick on an ask. **One registry declares everything scheduled** — `core/jobs.ts` carries both tables, the tick's own jobs (`SERVER_JOBS`, implemented in `jobs-run.ts`) and the tasks the clock dispatches (`TASK_SCHEDULE`, decided in `scheduled-tasks.ts`) — and `tests/myco-server/one-scheduler.test.ts` holds the Deployment to it: a process timer appears only in `platform/bun/wake-loop.ts`, a hosted alarm only in `platform/cloudflare/deployment-clock.ts`, the cron handler only in `entry/cloudflare.ts`, and the tick is the only caller of the clock. On the member side `tests/meta/member-no-timer.test.ts` walks the import closure of the 2.0 entry points (`src/hooks/**`, `src/member/**`, `src/runner/**`): it reaches no daemon module, names no PowerManager, and holds only timers bounded by something already running — one HTTP request's budget, a hook's own re-read, and the lease heartbeat of a run a worker already claimed.

**A named precondition is asked with the store it decides over.** `PRE_CONDITIONS` and `ACCELERATORS` (`core/scheduled-tasks.ts`) take the relational store beside the Project id, so a condition about a Project's data can read that data — a hook that could not would be a condition about nothing, which is why both tables shipped empty. The store, not the whole Deployment: deciding whether to run is a read. The first one registered is `has-unprocessed-prompts`, one page of one row over `listUnprocessedPrompts` (`read/prompts.ts`) counting no prompt of a session still being written. The hourly `extract-curate` schedule names it (§7.4).

**Every registry read goes through one chokepoint**, `declared` (`core/declared.ts`, a leaf so each registry module can share it), which reads own properties only. Plain indexing answers `constructor`, `toString` and `valueOf` with callables from `Object.prototype`, and the names reaching these tables come from outside the code: a precondition or accelerator from a Settings leaf, and a task name from a dispatch request body. Unguarded, a settings string would have admitted a task no condition passed, or shortened an interval twelvefold through an "accelerator" that is the `Object` constructor; and the **primary unknown-task guard** (`admissionForTask`, with `taskTools` and `runTimeoutForTask` beside it) would have answered `[class Object]` for a task named `constructor`, so `prepareDispatch` queued a worker-served run instead of refusing `unknown_task`. All four read through the chokepoint now, pinned over the six inherited names. A schedule naming a precondition or accelerator absent from its table is refused by a gate rather than skipped in silence every wake.

**A dispatch limit queues; a per-day ceiling refuses.** The two look alike and answer differently, and the difference is the design: a limit is capacity that is coming back, so the run waits and the drain launches it (§7.5 `agent.limits.*`); a ceiling is the spend an owner capped, so a queued run would launch the moment the drain reached it and spend exactly what the cap withholds. A task at its ceiling is therefore refused, not queued, and the next wake decides again — the task runs as soon as the trailing day has room, with nothing owed for the wakes that refused. The refusal is **recorded once per episode**, where an episode is one stretch of wakes that the same filled window refuses. The entry that filled the window names it: while the ceiling holds no entry is added, so that instant is fixed and every wake inside the episode derives the same row id and writes nothing new. A Deployment waking every minute at its ceiling therefore leaves one row naming the cap rather than a row per wake, and **an episode that crosses midnight still leaves one row** — the window the ceiling counts is a trailing 24 hours and belongs to no calendar day, so keying the record on a clock division would split one refusal in two. A later episode, after the window frees and a run goes through, leaves its own row — and two episodes can sit minutes apart under a ceiling above one, so the record is keyed on the filling instant itself rather than on any division of it: with a cap of two and entries just under a day apart, the window frees as the older ages out and the next episode's filling instant lands on the same calendar day as the first's. One qualification: a successor of a `replaced` run can move the filling instant without moving the count, since `lastTaskEntryAt` reads a replaced row while `taskEntriesSince` passes over it, so one refusal a reader would call a single episode can leave two rows. That is the direction to err in — a refusal recorded twice is read, one never recorded is not. A ceiling of zero has no entry to name and is one episode for all time: the row says once that this task is not to run, and the harness identity that row points at is declared where none exists, so a Deployment that has never dispatched records the refusal instead of failing the whole wake's scheduling on a foreign key. `taskEntriesSince` counts no skipped row, so the record can never be what holds the ceiling shut. Both front doors answer the same way: the clock records the skip, and an owner's ask is refused `409 max_runs_per_day` (`api/harness.ts`). Pinned by `tests/myco-server/scheduled-tasks.test.ts` and by the `scheduled-tasks` parity scenario on both targets.

**Waking is the only platform-specific part**, and on the Worker that instant is a **Durable Object alarm**, not a cron trigger:

- An alarm takes an absolute time at **millisecond** precision and is re-armed on each fire — the same shape as the `setTimeout` it replaces. A cron expression bottoms out at one minute and cannot express a computed interval.
- **No alarm set means nothing runs**, and it costs nothing. A cron trigger fires whether or not there is work.
- Cron triggers are capped **per account** (5 free, 250 paid), so making them the primary waker would ceiling how many Deployments an account can host. Alarms carry no such cap.

A **low-frequency cron trigger is still configured, as a recovery floor**. An alarm is state held inside the Durable Object: if it is never armed — a defect, or a Deployment that has never taken a request — nothing ever wakes and the failure is *silent*. Cron is externally guaranteed and is the only thing that recovers that. It is insurance, not the mechanism.

Alarms may fire more than once, so **the tick must be idempotent**: each evaluation re-probes its sources and recomputes rather than accumulating, and a gate fails by name if a tick ever carries state between invocations.

The port is `ServerEnv.wake` — "wake me soon", called by requested work — with `DeploymentClock` (a Durable Object alarm, `*/15` cron as the floor) arming the instant on W and the process wake loop in `platform/bun/wake-loop.ts` on C.

| Job | Disposition | Surface | Blk | Replacement / reason | Owner |
|---|---|---|---|---|---|
| `embedding-reconcile` | REPLACE | Core, W, C | Blk | A tick job against Vectorize / SQLite vectors | #1124 |
| `invite-expiry` | KEEP | Core | Blk | A tick job reclaiming spent, revoked and expired invitations past the retention window; a live invitation is never touched (plan §2.7) | #1158 |
| `transcript-parse` | KEEP | Core | Blk | New in 2.0: reads each held transcript's segments into the rows they contain, per agent, server-side. Bounded by the database calls a pass may spend rather than by bytes — a free-tier Worker invocation may make 50 subrequests, and a Durable Object relaxes CPU without relaxing that (see §7.7) | A3 |
| `transcript-retention` | KEEP | Core | Blk | New in 2.0: prunes raw segments behind the parse cursor past the Deployment's `retention.transcripts` window and frees the blobs no surviving row references; derived rows and the transcript record are never pruned | A3 |
| `session-maintenance` | REPLACE | Core | Blk | A tick job: server-side session lifecycle | A3 |
| `log-retention` | REPLACE | Core | Blk | A tick job over server logs; the member keeps its own log files (**M**) | E1 |
| `agent-run-retention` | REPLACE | Core | Blk | A tick job; the lifecycle owner for run rows (plan §7) | B3 |
| `grant-expiry` | KEEP | Core | Blk | New in 2.0: a tick job over External Agent grants, the lifecycle owner for grant rows. Every grant carries an expiry, and a lapsed one is ended in the record at the instant it expired and named as expired; a lapsed key is already refused at authentication, so this converges what an owner reads. Nothing is deleted — a spore's `author` names the grant, and both the grant row and its agent row stay for that name to point at (**landed in #1149**; plan §2.6, §7) | A5 |
| `worker-lease-sweep` | KEEP | Core | Blk | New in 2.0: returns a run whose worker stopped renewing to the claim queue at lease expiry, with its dispatch credential retired and the place in the queue it had already waited for. A run inside its lease is never taken from the worker holding it. This is the job that makes a killed worker survivable, and it is a different question from the stale sweep's: a lapsed lease is re-runnable and a run past its own budget is not | B1 |
| `notification-retention` | REPLACE | Core | Blk | A tick job; the domain now carries worker health findings (plan §5) | B3 |
| `auto-backup` | REPLACE | Core, W, C | Blk | A tick job: local volume snapshot on C; owner-triggered R2 export on W | #923 |
| `database-optimize` | REPLACE | Core, C | Blk | SQLite `optimize` on C; D1 exposes no equivalent, so W reports quota/storage health instead | #922 |
| `database-integrity-check` | REPLACE | Core, C | Blk | SQLite integrity check on C; W reports schema/quota health | #922 |
| `canopy-background-scan` | REPLACE | Core | Blk | Background scan behind the map task. **Planned DROP in #1170 (sweep)** per plan §1: the map it scans for goes. | #1170 |
| `release-provenance-reconcile` | REPLACE | Core | Blk | A tick job | #922 |
| `staging-gc` | REPLACE | M, Core | Blk | The hook prunes its own spool files past a fixed age after a successful drain (**M**, plan §7); server-side blob staging GC is a tick job (**Core**) | C1, B3 |
| `symbiont-detection` | REPLACE | M | Blk | An on-demand verb, not a timer: `myco doctor` probes installed binaries and credential stores (`symbionts/detect.ts`), `myco update` registers what it finds (`cli/bootstrap.ts`), and the worker uses the same detection to pick a harness (plan §2.5). Behaviour held by `tests/cli/doctor-agents.test.ts` — the verb's check surface driven over a project tree reports the agent it found; the edge and the absence of a timer by `tests/meta/member-no-timer.test.ts` | C2 |
| `managed-files-reconcile` | REPLACE | M | Blk | An on-demand verb: `myco update` reconciles managed assets, hooks, plugins and the managed AGENTS.md block (`symbionts/reconcile.ts`, plan §2.5). Held structurally by `tests/meta/member-no-timer.test.ts` — the verb reaches the reconcile and no timer reaches the verb. Running it writes global agent config, so the behaviour is held by whoever reworks it rather than by a gate that mutates the machine | C2 |
| `self-reconcile` | REPLACE | M | Blk | Folds into the same `myco update` path | C2 |
| `upgrade-auto-check` | REPLACE | M | Blk | An on-demand check: `myco upgrade --check` resolves the channel target and reports, persisting nothing (`upgrade/release-resolver.ts`); a server format break is one binary self-update (plan §2.2) | C2 |
| `upgrade-adopt` | REPLACE | M | Blk | Adopting a staged upgrade is the same verb without the flag: `myco upgrade` | C2 |
| `service-reconcile` | REPLACE | M | Blk | Reconciles 1.4's platform service. **Planned DROP in #1170 (sweep)** per plan §2.6: the member runs no service to converge, and the self-hosted binary's user-service install is the installer's job. | #1170 |
| `capture-buffer-drain` | DROP | — | Blk | Capture is hook-invoked and write-ahead; the member drains its own spool with no scheduled job | #925 |
| `capture-only-notice-sweep` | DROP | — | Blk | Notices a degraded daemon-capture mode that no longer exists | #925 |
| `content-claim-expiry` | DROP | — | Blk | Content claims are a Team Host publication mechanism; retired with Team | #925 |
| `routed-transcript-cache-gc` | DROP | — | Blk | Routed capture is a Team Host mechanism; retired with Team | #925 |
| `routed-event-dedup-prune` | DROP | — | Blk | Routed capture is a Team Host mechanism; retired with Team | #925 |

**Planned additions.** None: the worker-lease sweep (**#1151**), grant expiry (**#1149**) and invite expiry (**#1158**) have all landed and take their rows above.

### 7.6 Data classes — vault schema v76, `packages/myco/src/db/`

Disposition here is about the **data class**, and separately about **migration**: `MIGRATE` moves active Project data to the Deployment; `REBUILD` is derived data regenerated under the 2.0 schema; `DROP` does not migrate.

| Table | Disposition | Migration | Surface | Blk | Reason | Owner |
|---|---|---|---|---|---|---|
| `sessions` | KEEP | MIGRATE | Core | Blk | Core project intelligence | #924 |
| `prompt_batches` | KEEP | MIGRATE | Core | Blk | Already ingested by the 2.0 server. Carries a `processed` marker (v31) that the extraction outcome pages forward through and marks as it reads, so a run that stops partway resumes where it stopped (#1146) | #924 |
| `session_myco_tool_calls` | KEEP | MIGRATE | Core | Blk | Tool-call history | #924 |
| `artifacts` | KEEP | MIGRATE | Core | Blk | Transcripts and responses | #924 |
| `attachments` | KEEP | MIGRATE | Core, W, C | Blk | Blob-backed; R2 on W, volume on C. Byte-lossless comparison is a #927 gate | #924 |
| `plans` | KEEP | MIGRATE | Core | Blk | Myco owns identity, versions, provenance and search; disk and GitHub stay canonical for content (plan §2.3). Gains `source`, the channel a version arrived through — a watched path, a tagged message, or an explicit save — **landed in #1147**; NULL on a row written before it, which means "inferred from the key shape" rather than a guessed default | D3, A3 |
| `spores` | KEEP | MIGRATE | Core | Blk | Gains an `author` column so a write names the principal instance behind it rather than `user` alone — **landed in #1145 (schema v24)** with the run id for a run's write and the member id for a member's, nullable for rows written before. An external agent's grant takes the same column and an `agents` row of its own, and gains `provenance_kind`/`provenance_ref` for the pull request or commit a write with no session cites — **landed in #1149 (schema v25)** (plan §2.6). Gains an `agent_line` column in #1150 (schema v27) — the ≈40-token projection injection and search previews render instead of the Markdown, null until a run derives one | A1, A5, #1150 |
| `resolution_events` | KEEP | MIGRATE | Core | Blk | Supersede/consolidate lineage; carries `author` as `spores` does (#1145, schema v24), and `provenance_kind`/`provenance_ref` with it (#1149, schema v25) | #924 |
| `spore_injections` | KEEP | REBUILD | Core | Blk | What the prompt hook was served, per (session, prompt); 1.4 carries it on `activities`. Gains `plan_ids` in #1150 (schema v27): plans join the injection, and a plan served without a record is served again on the session's next prompt | #1044, #1150 |
| `project_remotes` | KEEP | REBUILD | Core | Blk | The git remotes a Project answers to, keyed on the remote so one remote names at most one Project by the shape of the table. Written on first sight at session start, first writer wins; a genuine duplicate is corrected by Project Reassignment (§3.1) rather than rebound. **Landed in #1150 (schema v27)** | #1150 |
| `session_injections` | KEEP | REBUILD | Core | Blk | What a session was served once, per (session, kind); the plan nudge today. 1.4 carries it on `activities` | #1026 |
| `skill_records` | KEEP | MIGRATE | Core | Blk | **Planned DROP in #1170 (sweep)** per plan §2.4 D3: the skill lifecycle goes and skills become hand-written files in the plugins. | #1170 |
| `skill_candidates` | KEEP | MIGRATE | Core | Blk | **Planned DROP in #1170 (sweep)** per plan §2.4 D3: no candidate queue without a generation pipeline. | #1170 |
| `skill_lineage` | KEEP | MIGRATE | Core | Blk | **Planned DROP in #1170 (sweep)** per plan §2.4 D3: a hand-written skill's history is git history. | #1170 |
| `skill_usage` | KEEP | MIGRATE | Core | Blk | **Planned DROP in #1170 (sweep)** per plan §2.5: skill triggering is measured by evals, not by a table. | #1170 |
| `digest_extracts` | KEEP | REBUILD | Core | Blk | Derived; regenerated under 2.0. **Planned DROP in #1170 (sweep)** per plan §1 and §3 D2: the generated digest goes with its loss recorded. | #1170 |
| `digest_extract_revisions` | KEEP | REBUILD | Core | Blk | Derived. **Planned DROP in #1170 (sweep)** per plan §1: revisions of a dropped artifact. | #1170 |
| `cortex_instructions` | KEEP | REBUILD | Core | Blk | Derived. **Planned DROP in #1170 (sweep)** per plan §2.4: instructions become a config leaf, not a generated row. | #1170 |
| `canopy_maps` | KEEP | REBUILD | Core | Blk | Derived; rebuilt by the map task. **Planned DROP in #1170 (sweep)** per plan §1: the owned repo map goes with its loss recorded. | #1170 |
| `agent_runs` | KEEP | MIGRATE | Core | Blk | Audit trail | #919 |
| `agent_run_events` | KEEP | MIGRATE | Core | Blk | Also the Deployment's own record of what a run called. A run reaches this Deployment through two doors and one list holds both: an MCP tool the harness child calls lands a `run_tool` row naming the tool and the op (`mcp/server.ts`), and a run route a container drives itself lands one naming the route (`pipeline.ts`, resolved from the run's own credential — and again after a claim, the call that MAKES a run held, so a container that claims and dies carries one call rather than none). A refused call writes nothing at all on either door — the MCP surface refuses it, a run route answers `persisted: false` — and is named in telemetry instead, so a credential cannot turn calls it may not make into rows. A run's turns happen inside a harness the Deployment cannot see, so these calls are the only part of a run it observes directly — and an empty list against a closed run is how a run that reached this Deployment through neither door is read. A `run_write` row is the narrower record: a write that TOOK, which is the run key for an artifact whose own row carries none (a session's title), and the close rule reads it rather than the call that asked | #919 |
| `agent_run_write_intents` | KEEP | MIGRATE | Core | Blk | | #919 |
| `agent_turns` | KEEP | MIGRATE | Core | Blk | | #919 |
| `agent_reports` | KEEP | MIGRATE | Core | Blk | | #919 |
| `agent_tasks` | KEEP | MIGRATE | Core | Blk | Task definitions | #919 |
| `agent_state` | KEEP | REBUILD | Core | Blk | Runtime state | #919 |
| `agents` | KEEP | MIGRATE | Core | Blk | Agent identity for attribution | #919 |
| `notifications` | KEEP | MIGRATE | Core, UI | Blk | Database + web delivery, architected for further transports | #922 |
| `schema_version` | KEEP | REBUILD | Core | Blk | 2.0 schema chain | #919 |
| `activities` | REPLACE | REBUILD | Core | Blk | Project activity feed, server-side | #918 |
| `log_entries` | REPLACE | DROP | Core, M | Blk | Server logs from emitted telemetry (**Core**); local logs are files under `MYCO_HOME` (**M**). Two different things — 1.4's rows do not migrate | #922 |
| `knowledge_git_provenance` | KEEP | MIGRATE | Core | Blk | Release provenance | #919 |
| `knowledge_release_state` | KEEP | MIGRATE | Core | Blk | Release provenance | #919 |
| `session_tombstones` | KEEP | MIGRATE | Core | Blk | Deletion records must survive migration, and they gate re-import: a tombstoned session is never imported again (plan §2.2). The server table and the deletion verb landed in #1147; the tombstone outlives the rows it removed, which is what tells a deleted session from one that never arrived | A3, A4 |
| `canopy_entries` | DROP | DROP | — | Blk | Per-file descriptions and entry embeddings retire with `canopy-describe` | #920 |
| `entities` | DROP | DROP | — | Blk | Semantic graph retired 2026-04-18 | #925 |
| `entity_mentions` | DROP | DROP | — | Blk | Semantic graph retired | #925 |
| `graph_edges` | DROP | DROP | — | Blk | Semantic graph retired | #925 |
| `team_members` | DROP | DROP | — | Blk | Team Host retired | #925 |
| `team_outbox` | DROP | DROP | — | Blk | Team Host retired | #925 |
| `team_sync_membership` | DROP | DROP | — | Blk | Team Host retired | #925 |
| `team_sync_state` | DROP | DROP | — | Blk | Team Host retired | #925 |
| `content_claims` | DROP | DROP | — | Blk | Team Host publication mechanism | #925 |
| `content_publications` | DROP | DROP | — | Blk | Team Host publication mechanism | #925 |
| `routed_event_dedup` | DROP | DROP | — | Blk | Team Host routed capture | #925 |
| `migration_log` | DROP | DROP | — | Blk | 1.4-internal migration bookkeeping | #925 |
| `migration_tasks` | DROP | DROP | — | Blk | 1.4-internal migration bookkeeping | #925 |
| `migration_import_journal` | DROP | DROP | — | Blk | OAK-import bookkeeping | #925 |
| `okf_pages` | DROP | DROP | — | Blk | OKF was never proven against a consumer; the code is already gone and the sweep is the migration (plan §5) | — |
| `okf_page_revisions` | DROP | DROP | — | Blk | OKF | #925 |
| `okf_generations` | DROP | DROP | — | Blk | OKF | #925 |

**2.0 server data classes** — tables `packages/myco-server/src/db/` creates that have no 1.4 vault ancestor; disposition is about the class; there is no migration column, nothing migrates into them.

| Table | Disposition | Surface | Blk | Reason | Owner |
|---|---|---|---|---|---|
| `backups` | KEEP | Core, W, C | Blk | One row per backup artifact — object key, size, row counts, schema version, producer and pin — written by the backup job and read by restore; the artifact itself lands in R2 on W and on the volume on C | #1079 |
| `blob_reservations` | KEEP | Core | Blk | Transient upload state: the key, size and expiry an ingest holds against a credential's byte quota until the bytes land or the reservation lapses | #898 |
| `blobs` | KEEP | Core, W, C | Blk | Every stored blob's key, size, media type and writing credential; the bytes sit in R2 on W and on the volume on C | #898 |
| `deployment_secrets` | KEEP | Core | Blk | One row per named Deployment credential, holding ciphertext, IV and wrapping-key version only, written by the settings surface with its actor | #965 |
| `deployment_settings` | KEEP | Core | Blk | One row per Deployment config leaf (§7.8), each carrying the member and instant of its last write | #965 |
| `embedding_cursors` | KEEP | Core | Blk | One row per Project marking where the embedding reconciliation resumes, and the model, counts and cursor of its hubness pass | #1126 |
| `embedding_hubness_work` | KEEP | Core | Blk | A Project's in-flight hubness statistics — target model, cursor, and the running count, mean and sum of squared deviations a finished pass folds into the receipts | #1126 |
| `embedding_receipts` | KEEP | Core, W, C | Blk | One receipt per embedded record per model with the revision it covers, its readiness and its neighbour statistics; the vector itself sits in Vectorize on W and in the local vector table on C | #1126 |
| `embedding_versions` | KEEP | Core | Blk | The current revision of every embeddable record, stamped by source-table triggers so a mutation invalidates its vector in the same transaction | #1126 |
| `enrollment_authorities` | KEEP | Core | Blk | Invitations and sandbox join codes: a hashed single-use key with its expiry, the role it confers, the Project it binds, and its spend or revocation | #912 |
| `events` | KEEP | Core | Blk | The append-only ingest log a member credential writes — payload or spill key, producer, envelope hash — and the source every typed projection derives from. As of #1155 a member whose harness the Deployment parses writes four kinds here: `session.start`, `session.end`, `transcript.segment` and `plan` (Cursor adds `tool.use` and `tool.failure`, which its transcript cannot carry); every `prompt`, `response` and tool-call row of such a harness carries the parse's producer (`transcript-parse`), which is what the continuity measurement partitions on | #897, C1 |
| `external_grants` | KEEP | Core | Blk | External Agent grants: one hashed per-Project key with its label, creator, expiry, last use and revocation | #1017 |
| `identity_link_authorities` | KEEP | Core | Blk | Single-use hashed authorities a member credential mints, spent by the signed-in GitHub account that binds itself to that member | #1016 |
| `machine_claims` | KEEP | Core | Blk | The one member a machine identity belongs to, claimed at enrollment and read by every ownership predicate the ingest path applies | #912 |
| `member_credentials` | KEEP | Core | Blk | Every credential a member holds — hashed token, machine and runtime, lineage, expiry, bytes written, and the member that revoked it | #912 |
| `member_tokens` | KEEP | Core | Blk | The project-pinned v1 credential table; `member_credentials` carries live authentication and no path reads these rows | #897 |
| `members` | KEEP | Core | Blk | One row per member with label, role, linked GitHub id and revocation; every credential and every attributed write resolves through it | #912 |
| `project_capabilities` | KEEP | Core | Blk | Per-Project capability admission, one row per (Project, capability) with the actor of its last write; an absent row reads disabled | #965 |
| `project_repositories` | KEEP | Core | Blk | The committed repository a Project's code tasks read — revision, URL, branch, and the username and secret slot a private clone authenticates with — carrying the actor of its last write | #1131 |
| `projects` | KEEP | Core | Blk | One row per Project the Deployment holds — name, creation and archival state — created by a member's first write | #897 |
| `responses` | KEEP | Core | Blk | An agent response projected from its event: text or spill key, content hash, and the prompt and session it answers | #898 |
| `schema_meta` | KEEP | Core | Blk | Deployment-scoped facts keyed by name: the applied schema version and the lineage id every backup artifact header carries | #897 |
| `search_blob_chunks` | KEEP | Core | Blk | The indexed text of a spilled body in resumable chunks, keyed by (blob key, offset) and cascaded away with its queue row | #1125 |
| `search_blob_queue` | KEEP | Core | Blk | One row per blob awaiting text indexing with the next offset, completion flag and last attempt a pass resumes from; a deleted blob takes its row with it | #1125 |
| `step_up_authorities` | KEEP | Core | Blk | Hashed single-use authorities scoped by purpose; dormant, and no path writes or reads them | #965 |
| `tags` | KEEP | Core | Blk | Tags on a Project's entities keyed by (entity kind, entity id, tag); plan tags are what the projections write today | #898 |
| `tool_calls` | KEEP | Core | Blk | One tool call per row projected from its event — tool and Myco op, input, output preview, success, duration and files affected | #898 |
| `transcript_segments` | KEEP | Core | Blk | The byte ranges of a transcript, each naming the blob holding its bytes and the event that shipped it; shipped by the turn-end hooks (`Stop`, `SessionEnd`, `session.idle`) past the Deployment-held offset, for the session's own transcript and each subagent sibling (#1155) | #898 |
| `transcripts` | KEEP | Core | Blk | One transcript per (session, machine, path, head digest) with its size, role — `subagent` for a delegated agent's transcript shipped beside the session's own (#1155) — fidelity, head digest and the parse cursor the resumable parse advances, plus the instant an import shipped it — NULL for a hook-shipped one, and the lane of its newest segment, so live work is always parsed ahead of a backfill | #898, A4 |

**Planned additions.** None: `plans.source` (#1147, schema v28), `spores.agent_line` (#1150, schema v27), `project_remotes` (#1150, schema v27) and `enrollment_authorities.role`/`.project_id` (#1158, schema v26) have all landed and take their rows above.

### 7.7 Operational capabilities

Capabilities that are not a single registry token but must still carry a disposition and an owner.

| Capability | Disposition | Surface | Blk | Replacement / reason | Owner |
|---|---|---|---|---|---|
| Session, prompt, tool-call, response capture | KEEP | M, Core | Blk | Shipped; proven by the §8.4 parity run. As of #1155 the prompts, responses and tool calls of a parsed harness are written by the parse alone; the hooks ship the session, the delta and the plan files (§3.4) | shipped, C1 |
| Transcript capture and segmentation | KEEP | M, Core | Blk | Shipped | shipped |
| Attachment capture | KEEP | M, Core | Blk | Shipped | shipped |
| Plan capture from watched plan dirs | KEEP | M, Core | Blk | Parsed server-side from the transcript stream — `Write` calls to the allowlist, tagged messages, and the hook re-reading any allowlisted path it saw edited during the turn (plan §2.3). The channel each version arrived through is recorded on `plans.source` rather than inferred from the key shape | A3 |
| Server-side transcript parsing | KEEP | Core, W, C | Blk | New in 2.0: per-agent parsers turn a held transcript into prompts, responses, tool calls, attachments and plans, through the same projections a hook event lands in. A parser declares what its format can support, and a session whose transcript cannot carry tool results is excluded from extraction rather than believed (see the fidelity note below) | A3 |
| Task execution on attached workers | KEEP | M, Core | Blk | New in 2.0: neither front door runs a harness. A worker offers the harnesses it has installed and logged in, claims one run at a time from a Deployment-wide queue on an administrator's credential, holds it on a lease it renews, and drives the harness the Deployment chose from `worker.harness` and `worker.harness_fallback` with a per-task override. The model's whole tool surface is the run-scoped MCP credential, written into the harness's per-run configuration; the run token reaches a file and a process environment and never a prompt or a log. Lease expiry returns a run to the queue rather than failing it, which is a different question from a run outrunning its budget. Three tasks keep the launch seam until #1170: two whose surface is a server-side step loop rather than MCP, and the containerized runtime's own proof. The Cloudflare harness probe retired with the container it proved (`POST /api/harness/probe`, `ServerEnv.harnessProbe` and `harnessEnd`, #1160): it read a container's live state, and no target starts one. Worker liveness is a different fact under a different name — a `workers` field on `POST /api/status`, from the lease columns | B1 |
| Session deletion | KEEP | Core, UI | Blk | New in 2.0: a tombstone suppresses a session and removes every row derived from it, on both sides — reads through one predicate at every seam, writes through a check shared by every kind, so live capture cannot repopulate what a person deleted. The tombstone outlives the rows and gates re-import (plan §2.2) | A3, A4 |
| Plan capture via `myco_plans` MCP | REPLACE | MCP, Core | Blk | MCP talks to the Deployment directly — the one §8.4 parity miss | #921 |
| Session lineage (parent/child detection) | KEEP | Core | Blk | Columns carried; populated by the member | shipped |
| Project admission policy (ignored/archived) | REPLACE | Core | Blk | Server-side `archived` Project state: refuses ingest with a named terminal refusal, hidden from default listings with explicit opt-in, all history and attribution preserved | #918 |
| Backup | REPLACE | Core, W, C | Blk | Volume snapshot on C; owner-triggered R2 export with lifecycle retention on W (D1's `db.dump()` is alpha-only, so W iterates and streams) | #923 |
| Restore | REPLACE | W, C | Blk | Break-glass Operator procedure via `myco server restore` on both targets — never a dashboard button | #923 |
| Diagnostic export bundle | REPLACE | M, Core | Blk | Local shape from **M**; server-side export from **Core** | #922 |
| Project movement between Deployments | KEEP | Core | Blk | Project identity and history survive movement | #923 |
| Project Reassignment | REPLACE | Core | Blk | Server-side correction of duplicate Project identities | #923 |
| Symbiont detection and hook installation | REPLACE | M | Blk | On demand through `myco doctor`; the installer writes hooks with absolute paths, and sandbox images fix their symbionts at build time (plan §2.5, §2.7) | C2 |
| Managed asset reconciliation | REPLACE | M | Blk | One idempotent `myco update` path over managed assets, hooks, plugins and the managed AGENTS.md block — a verb, not a resident service (plan §2.5) | C2 |
| Recall injection (prompt submit) | REPLACE | Core | Blk | 5–7 items under a hard 300-token budget with a stated drop order (plans after spores, lowest score first), each carrying its id so the agent can follow up, plus one line naming the search tool. Cursor injects at post-tool-use instead: its prompt hook can only block (plan §2.1, §2.4) | A6 |
| Recall injection (session start) | REPLACE | Core | Blk | The static `instructions.template` and the agent's project id — no plans, no generated project state; the template tells the agent to search (plan §2.4, §3 D2) | A6 |
| External agent MCP for cloud agents | REPLACE | MCP, Core | Blk | Per-project grant: read, plus spore create and supersede attributed to the grant by an author column and an agent row, optionally citing a PR or commit instead of a session. Copilot code review consumes it through repository-level MCP configuration — remote HTTP, headers, `COPILOT_MCP_*` secrets, no OAuth (plan §2.6) | A5 |
| HTTPS / trusted-proxy contract | REPLACE | W, C | Blk | Platform TLS on W; documented proxy contract on C | #909 |
| Update reliability | KEEP | M, MS | Blk | | #922 |
| Deploy against the runs in flight | REPLACE | W | Blk | New in 2.0: nothing to wait for on this target. The Worker carries no runtime, so a deploy replaces nothing that holds a run — a request in flight finishes on the version that took it, and a run executes on a worker the deploy never touches. The container drain and the rollout watch retired with the container. The self-hosted target keeps its own wait, bounded by the harness stop grace | #1115 |
| Server logs / observability | REPLACE | Core, UI | Blk | From the telemetry the server already emits; `wrangler tail` remains the W operator view | #922 |
| Native Cloudflare intelligence provider | REPLACE | W | — | **Non-blocking follow-up** — the Intelligence Provider contract is provider-agnostic | #928 |
| Offline capture | KEEP | M | Blk | The write-ahead spool stays, drained on the next hook with backoff; after a drain that delivered everything the hook prunes the state of sessions delivered long ago, and an unacknowledged spool is quarantined rather than deleted (plan §2.2, §7; **landed in #1155**) | #1155 |
| Plugin distribution | REPLACE | M | Blk | One generated bundle directory carrying every client's manifest over one skills tree, listed by a marketplace manifest at the repository root; nine hand-written skills under enforced listing and length caps, each with a trigger-eval case. No plugin carries a hook or a binary (**landed in #1156**; plan §2.7) | C2 |
| Bounded import and backfill | KEEP | M, Core | Blk | New in 2.0: a machine's existing transcripts reach its Deployment through the same segment path a live turn uses — attributed per Project through the local registry, deduped against the bytes already held so a repeat ships nothing, gated on tombstones, and bounded by `import.*`. Imported transcripts are marked and parsed behind live work; their sessions arrive closed, dated when they happened, and untitled. Imported Cursor sessions carry the fidelity flag and are excluded from extraction. **Attribution is per file and not every harness supports it**: Claude Code and Codex record a working directory their manifest names, Cursor is placed by its project-slug directory, and Antigravity, Copilot and Windsurf record neither — their transcripts are reported as naming no project rather than imported, until a manifest declares a `transcriptCwdPath` for them. A transcript naming a checkout this Deployment holds no Project for is reported as belonging to a project the Deployment does not hold, which is a thing a person can connect — distinct from one that names nowhere (plan §2.2) | A4 |

**Planned additions.** Each capability below lands with its code and takes a row then. The list is the count; a number stated beside it is a second copy of its length, and two lanes each striking their own entry leave the number describing neither.

- **Run-scoped MCP credential** (**#1145**) — a third principal kind with `heldRun` per request, a per-run tool allowlist from the task definition enforced at the MCP chokepoint, and run attribution on writes. Today a run token is an ordinary member token (plan §2.5).
- **Invite and join** (**#1158**, landed) — single-use expiring invite links and `myco login <url>` for humans; a join code in `MYCO_JOIN_CODE` for sandboxes and CI, exchanged at first contact for a member credential. The Project is bound when the invitation is **minted**, not resolved from the repo remote at first contact: the normalized-remote leg of Project Resolution (§3.1) belongs to the `project` tool parameter of D1 tenancy, and binding at mint leaves a sandbox with nothing to guess — a code carrying no Project is refused `enrollment_no_project` and stays unspent. Admin and member roles only; revocation kept (plan §2.7).
- **Eval suite** (**#1154**) — recorded real sessions as fixtures with a redaction gate before commit, a hand-annotated gold set of 30–50 cases, deterministic graders per PR against replayed recordings, and a weekly capped judged run required on releases (plan §2.5, §7).
- **Grant-attributed spore writes** (**#1149**) — an author column and an agent row per grant, so an external agent's create or supersede carries the grant rather than `user`, optionally citing a PR or commit instead of a session (plan §2.6).

**Where the parse runs, and why it is not a Durable Object request.** Plan §2.2 states that parsers run "inside a Durable Object request on Cloudflare (30 s CPU)". Two facts measured against the tree and against Cloudflare's published limits (2026-09-08) put the mechanism elsewhere, and the decision — parsers server-side, per agent, on both front doors — is unchanged by it.

- **The CPU claim is unverified for the Free tier.** The Workers limits page gives one tier-split CPU table, 10 ms on Free and 5 min (default 30 s) on Paid; the Durable Objects page publishes a DO-specific row of 30 s that is *not* tier-split. The DO relaxations that are unambiguous are wall time, which was never the constraint.
- **The binding constraint is subrequests, and a Durable Object does not relax it.** Free allows **50 subrequests per invocation**, D1 and blob reads both count, and each event ingested through its own batch spends one.

Measured: an 8 MiB segment of a real Claude Code transcript parses in ~11 ms, which is one whole free-tier CPU budget — and that figure is `JSON.parse` alone, before deriving, hashing or writing. So the parse is a **tick job bounded by the database calls a pass may spend**, resumable over a byte cursor, landing derived events in one batch. On the Worker the tick's own timer already *is* a Durable Object alarm, so any CPU headroom that exists is inherited with no new class, binding or migration tag; on the binary the same job runs in-process. Nothing under `platform/` differs between the two, which is what §3.3 requires. A per-target parse entry was designed and dropped on these numbers.

**Transcript identity, and what the head digest does not cover.** A transcript is named by (machine, path, inode). A file truncated and rewritten in place keeps all three, so the server records a digest of its first bytes and refuses a segment that disagrees with the one held — terminally, rather than appending one file's bytes to another's record. Two limits are stated rather than implied: a rewrite leaving the first bytes intact passes, so this catches replacement and truncation rather than every edit; and it is **inert until the member sends the field**, which is C1's half (**#1155**). C1 must ship sending and re-minting together — sending alone would park a transcript on a refusal it cannot answer.

**Fidelity is a property of a format, not of a file.** Cursor's transcript carries no tool results, so no parse of one can produce them and a session captured from it is structurally incomplete. Each parser declares what its format supports, the transcript records it, and extraction excludes such sessions **by default at the read layer's own definition** rather than by an argument at each call site: `listSessions` defaults to full fidelity and `listSessionSummaries` opts out, so a reader that assembles material inherits the rule and a reader that shows history does not. The dashboard still shows them: a hidden session is an absence a person can see, while a spore extracted from a knowingly incomplete transcript reads exactly like a good one. Only one of those is discoverable after the fact.

Codex currently retains `no_tool_results` and its fallback tool hook. Its parser reads paired `function_call` and `custom_tool_call` items with string or content-array outputs. The redacted Codex 0.153.4 recording in `tests/fixtures/codex-0.153.4-redacted.jsonl` proves the custom-call pair. Local-shell, tool-search and web-search variants remain outside that recorded coverage; full fidelity is not claimed.

**A row already stored wins, and a backfill must not inherit that.** A derived event is named by the row it produces, so a refusal on that name means the row exists with *different* content — an older parser's, or a hook's. The parse keeps the stored version and moves on, emitting `transcript_row_conflict`: stopping a transcript over one row already recorded would cost every row after it. That is the right default for a live parse and the **wrong** one for the bounded import (**#1148**), which re-reads transcripts over rows something else already wrote. Import needs an explicit rule for which version wins; it must not adopt this one by inheritance.

**An unreadable line does not silence a transcript.** A line that is not JSON is skipped and counted, and only a run of them past a threshold stops the file — losing thousands of rows to one corrupt line is the larger data loss. A stopped transcript records the parser version that stopped it and is offered again once that moves, so a format break is answered by the same deploy that fixes it rather than leaving files permanently dark.

### 7.8 Config leaves — `packages/myco/src/config/schema.ts`

1.4 resolves settings across four tiers — `machine`, `grove`, `project`, `local` — through `SCOPE_REGISTRY` (`packages/myco/src/config/scope.ts`). **2.0 keeps two**: Member Settings on the machine, Deployment Settings on the server (§6.1, and the `config` and `/settings` rows above). Every leaf therefore needs somewhere to land, and a leaf nobody placed is a setting that silently changes meaning.

Classification is **per leaf, not per registry row**. Seven of the registry's 31 rows are block prefixes covering many leaves, and a block is exactly where a mixed disposition hides: `release_provenance` is repo-specific except for one interval, and `notifications` is per-viewer except for its retention window. Bulk-mapping either would have moved a setting to the wrong side of the seam without anyone seeing it.

**Tier** is what the leaf becomes:

- **Member** — stays on the machine. Capture, symbiont, spool, log and machine preferences never become server state (#915 scope).
- **Deployment** — one value for the whole server, managed by any member (§5 Admin row).
- **Project** — per-Project state on the Deployment rather than config. Capability admission and repo-specific settings live here: a Project is created on first use (`resolveProject`), so its settings cannot live in a file that must exist before the Project does.
- **—** — dropped; mechanism rather than setting.

**Coverage is measured against DECLARED leaves, not defaulted ones.** A leaf declared `.optional()` with no default never appears in a parsed config, so anything enumerating that way cannot see it — and the leaves that go missing are not a random sample. `agent.provider.base_url`, `agent.provider.type` and `embedding.base_url` are all optional, and they name the endpoint a Deployment's own credential is sent to. A coverage gate blind to those is blind exactly where it matters most, which is why `declaredLeafPaths()` walks the schema rather than an instance of it.

**Every Deployment leaf is member-writable (the step-up gate was dropped 2026-08-30, #1036).** The substitution risk #907 named is answered in structure: a credentialed provider's key travels only to its provider's own fixed endpoint (member-side `agent/provider.ts`) or into the launched runtime's environment under the variable its harness reads (server-side `core/harness.ts`, the one opener of a Deployment credential besides the settings surface), stored credentials are write-only and masked, and every write records its actor. A custom `base_url` receives no stored Deployment credential — the rule every provider consumer must keep.

(A deep scan of submitted values for smuggled endpoints — `containsProviderRedirect` — used to decide which writes needed the extra proof. It left with its premise on 2026-08-30: with every leaf member-writable, an endpoint inside `agent.tasks` is the same act as typing it into `agent.provider.base_url`, and the defense that holds is the fixed-endpoint rule above — a per-task override can pick a provider and model, and its endpoint is read from the leaf alone.)

**Capability master gates are fail-closed and that is a mechanism, not a default.** Two of 1.4's four gates go with their capabilities — `skills.enabled` with the generation pipeline and `cortex.canopy.enabled` with the map — leaving `vault_evolution.enabled` and `cortex.enabled`. Today all four default **`true`** in the schema, and `capabilityEnabled` returns `defaultEnabled ?? true` for an absent path (`config/capabilities.ts`). What actually makes a new project capture-only is a *write at provision time* — `reseedCaptureOnly()` seeding `false` for every gate (`vault/provision.ts`). On a Deployment, where Projects appear from a member's first write with no ceremony, the server-side predicate must therefore be the **inverse**: an absent row reads **disabled**. Otherwise every new Project silently acquires every cost-bearing capability, which is the auto-adoption #428 exists to prevent.

Four blocks hold dynamic children the schema cannot enumerate — `agent.tasks`, `notifications.domains`, `symbionts` and `release_provenance.package_map`. They are classified whole, as their own rows below, and the completeness gate collapses any leaf beneath them onto the block prefix.

| Leaf | Disposition | Tier | Surface | Reason | Owner |
|---|---|---|---|---|---|
| `version` | DROP | — | — | Schema version marker, not a setting | #925 |
| `config_version` | DROP | — | — | Migration mechanism, not a setting | #925 |
| `embedding.provider` | REPLACE | Deployment | Core | Self-hosted embedding provider; Cloudflare always uses Workers AI bge-m3 | #1124 |
| `embedding.model` | REPLACE | Deployment | Core | Self-hosted embedding model; Cloudflare always uses Workers AI bge-m3 | #1124 |
| `embedding.prevent_deep_sleep` | REPLACE | Deployment | Core | Wake policy for the embedding job; a Deployment-side scheduling concern | #915 |
| `daemon.log_level` | KEEP | Member | M | Log verbosity of the member binary on this machine | C1 |
| `daemon.log_retention_days` | KEEP | Member | M | Local log retention on this machine | C1 |
| `daemon.stale_session_threshold_ms` | KEEP | Member | M | Local session-liveness heuristic for capture on this machine | C1 |
| `capture.transcript_paths` | KEEP | Member | M | Where this machine's agents write transcripts | #915 |
| `capture.plan_dirs` | KEEP | Member | M | Where this machine's agents write plans | #915 |
| `capture.ignore_plan_dirs_in_git` | KEEP | Member | M | Local plan-capture filter | #915 |
| `capture.artifact_extensions` | KEEP | Member | M | Local artifact filter | #915 |
| `capture.buffer_max_events` | KEEP | Member | M | Local write-ahead buffer bound | #915 |
| `capture.ignore.paths` | KEEP | Member | M | Local capture exclusion | #915 |
| `capture.ignore.patterns` | KEEP | Member | M | Local capture exclusion | #915 |
| `release_provenance.enabled` | REPLACE | Project | Core | Per-repository: whether this Project tracks provenance | #915 |
| `release_provenance.production_refs` | REPLACE | Project | Core | Git refs of one repository | #915 |
| `release_provenance.integration_refs` | REPLACE | Project | Core | Git refs of one repository | #915 |
| `release_provenance.production_debug_include_unknown` | REPLACE | Project | Core | Per-repository reporting detail | #915 |
| `release_provenance.github.repo` | REPLACE | Project | Core | Names one owner/repo | #915 |
| `release_provenance.github.token_env` | REPLACE | Project | Core | Names one repository's credential slot | #915 |
| `release_provenance.github.max_lookups_per_run` | REPLACE | Project | Core | Per-repository API budget | #915 |
| `release_provenance.package_map` | REPLACE | Project | Core | Monorepo package to tag mapping for one repository | #915 |
| `agent.harness` | REPLACE | Deployment | Core | Which harness the Deployment runs tasks under. **Planned REPLACE by #1151** per plan §2.5: which harness a worker drives is resolved by detection against a Deployment-declared preference and fallback order. | #1151 |
| `agent.model` | REPLACE | Deployment | Core | Model pin the Deployment applies when a task sets none | #919 |
| `agent.reasoningLevel` | REPLACE | Deployment | Core | Default reasoning tier the Deployment resolves through the provider's map | #919 |
| `agent.provider.type` | REPLACE | Deployment | Core | Selects the provider, and with it which endpoint family the Deployment's credential is sent to | #915 |
| `agent.provider.base_url` | REPLACE | Deployment | Core | A custom endpoint; no stored Deployment credential is sent to one | #915 |
| `agent.provider.local_backend` | REPLACE | Deployment | Core | Which local runtime a local provider targets | #915 |
| `agent.provider.model` | REPLACE | Deployment | Core | Model the provider is asked for | #915 |
| `agent.provider.context_length` | REPLACE | Deployment | Core | Context window the Deployment requests of a local provider | #915 |
| `agent.provider.reasoning_map.default` | REPLACE | Deployment | Core | Model this provider resolves the `default` reasoning tier to | #919 |
| `agent.provider.effort_map.default.effort` | REPLACE | Deployment | Core | Effort this provider applies at the `default` tier | #919 |
| `agent.provider.effort_map.default.verbosity` | REPLACE | Deployment | Core | Verbosity this provider applies at the `default` tier | #919 |
| `agent.provider.thinking_budget_map.default` | REPLACE | Deployment | Core | Thinking budget this provider applies at the `default` tier | #919 |
| `agent.provider.reasoning_map.high` | REPLACE | Deployment | Core | Model this provider resolves the `high` reasoning tier to | #919 |
| `agent.provider.effort_map.high.effort` | REPLACE | Deployment | Core | Effort this provider applies at the `high` tier | #919 |
| `agent.provider.effort_map.high.verbosity` | REPLACE | Deployment | Core | Verbosity this provider applies at the `high` tier | #919 |
| `agent.provider.thinking_budget_map.high` | REPLACE | Deployment | Core | Thinking budget this provider applies at the `high` tier | #919 |
| `agent.provider.reasoning_map.low` | REPLACE | Deployment | Core | Model this provider resolves the `low` reasoning tier to | #919 |
| `agent.provider.effort_map.low.effort` | REPLACE | Deployment | Core | Effort this provider applies at the `low` tier | #919 |
| `agent.provider.effort_map.low.verbosity` | REPLACE | Deployment | Core | Verbosity this provider applies at the `low` tier | #919 |
| `agent.provider.thinking_budget_map.low` | REPLACE | Deployment | Core | Thinking budget this provider applies at the `low` tier | #919 |
| `embedding.base_url` | REPLACE | Deployment | Core | Self-hosted embedding endpoint; Cloudflare uses its Workers AI binding | #1124 |
| `backup.dir` | DROP | — | — | A member-writable server-side filesystem path is the #907 H5 family, and has no meaning on a Worker. Where a self-hosted Deployment writes backups is operator configuration, not a member setting | #923 |
| `agent.tasks` | REPLACE | Deployment | Core | Per-task overrides the Deployment applies to its own harness runs | #919 |
| `notifications.domains` | KEEP | Member | M | Per-viewer delivery preference for each notification domain | #915 |
| `symbionts` | KEEP | Member | M | Which coding agents are installed on this machine; never server state | #917 |
| `release_provenance.reconcile_interval_minutes` | REPLACE | Deployment | Core | The only Deployment-shaped leaf here; already split out as its own grove-homed entry | #915 |
| `agent.summary_batch_interval` | REPLACE | Deployment | Core | Deployment-side task batching | #915 |
| `agent.scheduled_tasks_enabled` | REPLACE | Deployment | Core | Whether the Deployment runs scheduled intelligence | #915 |
| `agent.event_tasks_enabled` | REPLACE | Deployment | Core | Whether the Deployment runs event-driven intelligence | #915 |
| `agent.semantic_write_check_enabled` | REPLACE | Deployment | Core | Deployment-side write-quality gate | #915 |
| `agent.cold_project_threshold_days` | REPLACE | Deployment | Core | Deployment-side scheduling policy | #915 |
| `agent.scheduled_tasks_active_window_days` | REPLACE | Deployment | Core | Deployment-side scheduling policy | #915 |
| `agent.run_retention_days` | REPLACE | Deployment | Core | Retention of Deployment-held agent run records | #915 |
| `agent.limits.concurrent_runs` | NEW | Deployment | Core | Runs at once across the Deployment; a dispatch past it waits in the queue | #1091 |
| `agent.limits.task_concurrent_runs` | NEW | Deployment | Core | Runs of one task at once; past it, the dispatch waits | #1091 |
| `agent.limits.task_runs_per_hour` | NEW | Deployment | Core | Runs of one task started in the trailing hour; past it, the dispatch waits | #1091 |
| `backup.retention.keep_daily` | REPLACE | Deployment | Core | Deployment backup policy; the per-target mechanism belongs with the backup work, not here | #923 |
| `backup.retention.keep_weekly` | REPLACE | Deployment | Core | Deployment backup policy; the per-target mechanism belongs with the backup work, not here | #923 |
| `backup.auto_interval_hours` | REPLACE | Deployment | Core | Deployment backup policy; the per-target mechanism belongs with the backup work, not here | #923 |
| `maintenance.auto_optimize` | REPLACE | Deployment | C | PRAGMA optimize has no D1 equivalent; needs a per-target mechanism or an explicit drop | #913 |
| `maintenance.auto_optimize_interval_hours` | REPLACE | Deployment | C | Schedule for the above | #913 |
| `maintenance.auto_integrity_check` | REPLACE | Deployment | C | SQLite integrity/FK check has no D1 equivalent | #913 |
| `maintenance.auto_integrity_check_interval_hours` | REPLACE | Deployment | C | Schedule for the above | #913 |
| `update.channel` | KEEP | Member | M | Which build this machine installs | #915 |
| `skills.enabled` | REPLACE | Project | Core | Capability master gate; per-Project admission, fail-closed when absent. **Planned DROP in #1170 (sweep)** per plan §2.4 D3: it gates a generation pipeline that goes, and hand-written skills need no admission gate. | #1170 |
| `skills.confidence_threshold` | REPLACE | Deployment | Core | Advanced setting governed by the skills capability. **Planned DROP in #1170 (sweep)** per plan §2.4 D3: it scores candidates, of which there will be none. | #1170 |
| `skills.usage_stale_days` | REPLACE | Deployment | Core | Advanced setting governed by the skills capability. **Planned DROP in #1170 (sweep)** per plan §2.4 D3: it ages a generated skill, of which there will be none. | #1170 |
| `vault_evolution.enabled` | REPLACE | Project | Core | Capability master gate; per-Project admission, fail-closed when absent | #915 |
| `notifications.enabled` | KEEP | Member | M | Per-viewer delivery preference | #915 |
| `notifications.system_notifications` | KEEP | Member | M | Per-viewer OS notification preference | #915 |
| `notifications.default_mode` | KEEP | Member | M | Per-viewer delivery preference | #915 |
| `notifications.retention_days` | REPLACE | Deployment | Core | Prune window for Deployment-held notification records; no member owns it | #915 |
| `retention.transcripts` | KEEP | Deployment | Core | New in 2.0: days a raw transcript segment is kept after the parse has read it, 0–3650. **0 means indefinitely**, and so does an absent value — `setLeaf` has no delete, so without an in-range off value a Deployment that once set a window could never return to keeping everything. Derived rows are never pruned by it | A3 |
| `worker.harness` | KEEP | Deployment | Core | New in 2.0: the harness a worker prefers to drive. A worker offers what it has installed and logged in, the Deployment names what it wants, and the claim chooses the first of preference then fallback the worker actually has. An absent value means the fallback order alone decides | B1 |
| `worker.harness_fallback` | KEEP | Deployment | Core | New in 2.0: the ordered harnesses a claim falls back through when the preferred one is not on the worker. Per-task override rides the `agent.tasks` document as `agent.tasks.<task>.harness`, the same shape a provider override uses; there is no dotted-path leaf | B1 |
| `cortex.enabled` | REPLACE | Project | Core | Capability master gate; per-Project admission, fail-closed when absent | #915 |
| `import.enabled` | KEEP | Deployment | Core | New in 2.0: whether a machine's existing transcripts are imported at all. Absent means on — an import runs at join, so the leaf exists to stop it. The only one of the three that is also an admission on the write path: a window and a per-harness count are properties of a whole pass, which one event cannot be judged against | A4 |
| `import.max_sessions_per_harness` | KEEP | Deployment | Core | New in 2.0: most sessions one agent's store contributes, default 50. Applied where the pass is planned | A4 |
| `import.window_days` | KEEP | Deployment | Core | New in 2.0: how far back an import reaches, default 30. Most harnesses keep transcripts for about a month, so a wider window finds more only where the archive survived longer — which is why the repeatable command may ask past this | A4 |
| `instructions.template` | REPLACE | Deployment | Core | The static session-start instructions any member edits: Markdown, at most 4 KB, validated on write and refused above it. Served on `POST /context/session` beside the Project id, and by `myco_cortex` op `instructions`. Replaces the `cortex-instructions` task (plan §2.4) and, with it, `cortex-prompt-builder`: static instructions leave nothing to build (plan §2.5, #1152) | #1150, #1152 |
| `cortex.instructions.inject_on_session_start` | REPLACE | Deployment | Core | Applied by the Deployment on `POST /context/session`, once per session | #1026 |
| `cortex.instructions.inject_on_subagent_start` | REPLACE | Deployment | Core | Applied by the Deployment on `POST /context/session`, once per subagent | #1026 |
| `cortex.digest.tier` | REPLACE | Deployment | Core | Digest size the Deployment generates and serves at session start, nearest tier held when the exact one is absent. Read by the digest run that writes the artifact; no longer served at session start as of #1150. **Planned DROP in #1170 (sweep)** per plan §1 and §3 D2: it sizes an artifact that goes. | #1170 |
| `cortex.digest.inject_on_session_start` | REPLACE | Deployment | Core | Applied by the Deployment on `POST /context/session`; off unless a Deployment asks for it. Unread as of #1150: session start serves `instructions.template` and nothing generated, so this setting changes nothing. **Planned DROP in #1170 (sweep)** per plan §2.4. | #1170 |
| `cortex.spores.inject_on_prompt_submit` | REPLACE | Deployment | Core | Applied by the Deployment on `POST /context/prompt` | #1026 |
| `cortex.spores.max_per_prompt` | REPLACE | Deployment | Core | Applied by the Deployment on `POST /context/prompt`, clamped to 0..10. Counts items — spores and plans share it as of #1150 — and the 300-token budget may serve fewer | #1026, #1150 |
| `cortex.plans.inject_intent_nudge_on_prompt_submit` | REPLACE | Deployment | Core | Applied by the Deployment on `POST /context/prompt`, once per session | #1026 |
| `cortex.canopy.enabled` | REPLACE | Project | Core | Capability master gate; per-Project admission, fail-closed when absent. **Planned DROP in #1170 (sweep)** per plan §1: it gates a map that goes. | #1170 |
| `cortex.canopy.refresh.background_enabled` | REPLACE | Deployment | Core | Deployment-side map refresh policy. **Planned DROP in #1170 (sweep)** per plan §1: refresh policy for a map that goes. | #1170 |
| `cortex.canopy.refresh.background_period_minutes` | REPLACE | Deployment | Core | Deployment-side map refresh schedule. **Planned DROP in #1170 (sweep)** per plan §1: refresh schedule for a map that goes. | #1170 |
| `cortex.canopy.exclude.default_patterns` | REPLACE | Deployment | Core | Map scan exclusion applied Deployment-side. **Planned DROP in #1170 (sweep)** per plan §1: scan exclusion for a map that goes. | #1170 |
| `cortex.canopy.exclude.patterns` | REPLACE | Deployment | Core | Map scan exclusion applied Deployment-side. **Planned DROP in #1170 (sweep)** per plan §1: scan exclusion for a map that goes. | #1170 |
| `cortex.canopy.min_file_bytes` | DROP | — | — | Retired per-file injection threshold | #1170 |
| `cortex.canopy.inject_on_pre_tool_use` | DROP | — | — | Retired Canopy entry injection | #1170 |
| `appearance.theme` | KEEP | Member | M | Per-viewer dashboard theme | #918 |
| `appearance.mode` | KEEP | Member | M | Per-viewer light/dark; Deployment-wide would flip every member's dashboard | #918 |
| `appearance.font` | KEEP | Member | M | Per-viewer dashboard typography | #918 |
| `appearance.density` | KEEP | Member | M | Per-viewer dashboard density | #918 |

**Planned additions.** None: the leaf registry (`core/settings.ts`) and this table are held equal in both directions, so a leaf named here before it exists would refuse every write. `worker.harness` and `worker.harness_fallback` (**#1151**) and `import.enabled`, `import.window_days` and `import.max_sessions_per_harness` (**#1148**) have all landed and take their rows above.

**What the dashboard exposes, and how (#1162).** Every Deployment leaf above has a control on `/settings`, grouped by the catalogue in `packages/myco-server/ui/src/settings/catalogue.ts`, and a gate holds that catalogue equal to `DEPLOYMENT_LEAVES` so a leaf cannot exist on one side alone. The five the 2.0 dashboard is judged on (plan §2.8) sit on these tabs:

| Leaf | Tab | Control |
|---|---|---|
| `instructions.template` | Cortex | The session-start Markdown, bounded at 4 KB of UTF-8 and refused above it at the write |
| `worker.harness`, `worker.harness_fallback` | Workers | The harness a worker prefers, and the ordered fallback as a JSON array |
| `retention.transcripts` | Records | The transcript window in days, 0 for indefinitely |
| `import.enabled`, `import.window_days`, `import.max_sessions_per_harness` | Importing past sessions | Whether a joining machine brings history, how far back, and at most how many per agent |
| `agent.limits.concurrent_runs`, `agent.limits.task_concurrent_runs`, `agent.limits.task_runs_per_hour` | Limits | The per-task and Deployment-wide run ceilings |

**There is no document write, so there are no siblings to drop.** A change on the page is one `PUT /api/settings/{leaf}` carrying one `value`, applied by the single validated operation in `core/settings.ts`. The form holds no copy of the Deployment's settings to write back, which is what makes the classic silent-data-loss shape — one field edited, every sibling overwritten with whatever the form happened to hold — unreachable rather than merely avoided. Held by `tests/myco-server/settings-leaves-round-trip.test.ts` (each leaf written in turn over the route, every sibling read back intact, a refused value changing nothing) and by `tests/myco-server-ui/settings.test.tsx` (one edit, one request, one leaf, one key in the body).

**Leaves whose page is gone are not leaves that are gone.** #1162 drops the Cortex and Skills **pages** (§7.2). Their leaves keep their rows and their controls: `cortex.digest.tier` still sizes the artifact a scheduled run writes, `cortex.canopy.*` still governs the map refresh, and `skills.confidence_threshold` and `skills.usage_stale_days` are still held by the server. Each is already marked **Planned DROP in #1170 (sweep)** above, and a leaf's disposition changes in the pull request that removes the code reading it, never in one that only removes a page. `cortex.digest.inject_on_session_start` is the one leaf the dashboard shows and refuses to offer: the control is disabled, because a switch that changes nothing reads worse than one that cannot be thrown.

**Project-tier `release_provenance.*` has no store yet, and that is a deferral rather than an oversight.** Step 6 builds `project_capabilities`, keyed on the four capability ids, and nothing else per Project — so the eight repo-specific `release_provenance` leaves are classified but not writable, and `setLeaf` refuses them. They are per-repository settings for a feature (#922 owns release provenance) whose per-Project store lands with the surface that configures it. The same rule as the two blocks below: a tier without a mechanism is recorded as such rather than assigned quietly.

Two further blocks are **not settled here**, and are marked so rather than assigned silently. `backup.*` describes Deployment backup policy but leads with a filesystem path that has no meaning on a Worker; #923 owns backup/restore and owns the per-target mechanism with it. `maintenance.*` is `PRAGMA optimize` and SQLite integrity checking, neither of which exists on D1 — a capability row without a per-target mechanism is how one target quietly loses a feature (§3.3), so it belongs with the self-hosted work in #913.

## 8. Release blockers

`myco/v2.0.0` publishes only when every gate below is satisfied on live data. Each is the plan's own gate (plan §8), and each fails by observation rather than by claim.

1. **Fresh machine.** Plugin alone → a first tool answer; one installer command → first injection, a captured session **and a spore**, on Claude Code, Codex and Cursor.
2. **Sandbox.** A sandbox holding only a join code captures a session and its plan.
3. **External agent.** Copilot code review reads context over MCP with a grant and saves a spore whose author is the grant.
4. **Workers.** A worker on a laptop and a worker on a VM each complete the three run outcomes with close evidence, on at least two harnesses.
5. **Both front doors** pass the same ingest parity and eval suites.
6. **KPIs.** The page shows the six measures with n, from live data.
7. **After the sweep** (plan §5): `packages/myco/src/agent/` is gone, the capture surface is under 4,000 lines, no daemon, Compose, Containers, digest, Canopy, Team-Host or skill-lifecycle code remains, and the ledger gate in §9 passes.

Every row in §7 is `Blk` except one: **#928** (native Cloudflare intelligence-provider integration), recorded as explicitly non-blocking.

## 9. The gate

A ledger with no gate goes stale the first time someone adds a CLI command.

`tests/meta/feature-ledger-completeness.test.ts` statically scans the six registries — CLI dispatch in `packages/myco/src/cli.ts`, routes in `packages/myco/ui/src/App.tsx`, `TOOL_*` constants in `packages/myco/src/tools/definitions.ts`, task YAML filenames, `POWER_JOB_NAMES` values, and `CREATE TABLE` names under `packages/myco/src/db/` — and asserts that **every token appears in a §7 table with both a disposition and an owning surface**, failing by name when either is missing.

The surface half is the one that matters most: a row with a disposition but no surface is how a capability ends up owned by nobody. That is the defect this whole ledger exists to answer.
