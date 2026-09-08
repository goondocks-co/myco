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
| Harness | Workers attach from wherever harnesses are logged in; no container required | Workers attach the same way. The start path binds a `harnessLaunch` seam and no worker fills it yet, so a laptop Deployment today answers every dispatch that no runtime is available; the in-process worker lands with **B1** |
| Durable storage | Platform-managed | Local volume beside the binary |
| Native storage artifacts | Platform-managed | Carried in the binary: an extension-enabled SQLite library and the `vec0` extension, registered before the first connection. A host lookup remains for a checkout and a container image |
| Lifecycle | `myco server create\|update\|rollback\|destroy --target cloudflare` | `myco server create\|run\|install\|uninstall\|status\|update\|destroy --target local`, with a per-user service (launchd, systemd `--user`, Task Scheduler) running `myco server run` at login |

The `HarnessContainer` Durable Object and the `[[containers]]` block retire with a `deleted_classes` migration (plan §2.6, §4 D2); `DeploymentClock` stays. A prebuilt worker bundle reduces Cloudflare provisioning to one verb — no Docker, no source checkout — with Node and Wrangler an **operator-machine** prerequisite for that verb alone, never on a member or worker host.

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

- **Plugins** carry no binary — 82 MB against a 256 MiB cap, and no post-install scripts. An **Agent Plugins 1.0** bundle covers Codex, Cursor and VS Code Copilot; Claude Code takes its own plugin; OpenCode, Pi and Cline take native in-process plugins over one shared TypeScript API client; Antigravity takes a bundle. Each declares the Deployment URL and credential through its own client's config prompt (Claude Code `userConfig`, Cursor `variables`, VS Code `inputs`, Codex `[plugins.*.mcp_servers.*]`). **Plugin alone = skills + MCP tools on every harness.**
- **The installer** (POSIX `sh`, PowerShell) places the binary and writes capture hooks with absolute paths. It adds capture, plan capture, import and the worker.

**Sandbox images ship the CLI, hooks and a join code** — no resident service, symbionts fixed at build time, the container short-lived. The join code (URL + credential in the environment) is exchanged at first contact for a member credential bound to the Project resolved from the repo remote.

**Tenancy is a tool parameter, not a transport** (plan §3 D1). Every Myco tool accepts `project` — a git remote or a project id — and the server resolves remote → project by the Project Resolution rule (§3.1). Reads default to the member's bound projects; **writes require an explicit project**. Session-start injection tells the agent its project id where hooks are installed, and the `myco` skill tells it to pass the repo remote where they are not. The 1.4 CLI transport for tenancy-blind harnesses retires; `myco tool call` remains as a CLI surface onto the same server code path.

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
| Brownfield seeding from code and git history | `vault-seed` | yes; the managed AGENTS.md block (≤500 chars) is written as one atomic replacement and the rest of the file is untouched |
| Session titles and summaries | `title-summary` | no |
| `instructions.template` (a Settings leaf, not a run) | `cortex-instructions`, `cortex-prompt-builder` | — |

`embedding-reconcile` stays a shipped server job. `myco_agent` stays the read surface over `agent_runs`.

**Instructions are config, not generation.** Session start serves a static, member-editable `instructions.template` (≤4 KB, Markdown, validated). With instructions static, a prompt builder has nothing to build, and the generated project digest is dropped with its loss recorded in §1 of the plan.

**Instructions to a run** are the prompt body plus a Myco-owned instructions file in the scratch dir — ACP carries user prompts only. Structured final output is not relied upon: a run succeeds by making MCP writes the server verifies afterwards.

**The runner** is a minimal **ACP v1** client (`@agentclientprotocol/sdk`, stdio) plus native headless drivers — `claude -p --output-format stream-json --mcp-config … --strict-mcp-config` for Claude Code, `codex exec --json` for Codex — with the ACP driver serving OpenCode, Cursor and Antigravity through their native ACP binaries. The published ACP adapters are npx packages, so native drivers are what keep **Node off every member and worker host**. One internal run-event model covers all three drivers, and a gate holds them to the same contract. The session layer is shaped so ACP v2's changed turn semantics stay a contained change.

**Workers** run the same binary in worker mode, and the laptop server process includes a worker by default. A worker claims work by long poll, holds a lease with a heartbeat, and lease expiry returns the run to the queue — single-flight honours the lease, not the process. Detection probes installed binaries and credential stores. A Deployment declares a preferred harness with a fallback order, overridable per task; a cloud worker logs in once and its harness OAuth token or API key is held in the Deployment's encrypted secret store (class 3, §3.3.1) and injected per run.

**A run's credential is a third principal kind** (#1145). A run token is not a member token. The pipeline admits the harness member's credential to two kinds of route only — a route that serves the run principal (`/mcp`, `route.run`) and the run routes it holds today with whatever admission each handler performs itself — `heldRun` on the task surfaces, none yet on the state and run-row handlers (`legacyRunRoute` on every `/runs/*` route, deleted with them in #1146) — and refuses it everywhere else (`run_scope`), the refresh route included, so a run credential is never refreshable. On `/mcp` the one live run the credential dispatched is resolved from the credential alone (`heldRunOfCredential`: exactly one `running`, non-stale row names it, else `no_run`), the header must name the run's Project (`project_mismatch`), and the run's surface is its task's **declared** tools (`TASK_TOOLS`, `core/task-catalogue.ts`, held equal to the task files by a gate) mapped onto `(tool, op)` pairs (`mcp/run-surface.ts`) and enforced at the one chokepoint (`mcp/server.ts callTool`) with the same byte-identical refusal a grant gets; `tools/list` is narrowed to it, and a dry run keeps its reads and loses every write. Writes carry the run's agent as `agent_id` and the run id in the `author` column beside the dispatch-named session. The five run operations that exist as HTTP routes today move onto this run-scoped MCP surface and the HTTP duplicates are deleted (#1146).

**Close evidence** stays server-side, with the report channel and single-flight: a run closes only when the server can see the rows it owed. External agents write under the same discipline through a per-project grant, attributed to the grant by an author column and an agent row, and may cite a PR or commit instead of a session.

**The wake tick is the only scheduler for Deployment work** — a `DeploymentClock` alarm with a cron floor on **W**, an in-process loop on **C**, both feeding one idempotent tick (`core/tick.ts`) with per-task per-day ceilings. Triggers are session end, the clock, and an explicit ask. The member binary registers no timers; the machine-side needs that survive — upgrade check, symbiont detection, managed-files reconcile — are the on-demand verbs `myco update` and `myco doctor`.

**Evals** gate the prompts: recorded real sessions as fixtures, redacted by a gate before commit, with a hand-annotated gold set of 30–50 cases; deterministic graders per PR against replayed recordings; a weekly (and on any task-prompt or skill change) judged run on a curated subset, capped per run; results on the KPI page and the weekly job required on releases.

**Principles (Chris, 2026-09-02, closed):**
- Every agent task runs through the agent harness with the configured provider and credentials. Title and summary are no exception. There is no interim direct model call, on either target. *(Stands. The harness is now an attached worker rather than a container — plan §2.5.)*
- The run is the unit of work: one run id, one container, any number at once across triggers, schedules, sessions and Projects. *(Superseded in mechanism by plan §2.5: the run is still the unit of work, but its host is a claimed worker lease, not a container.)*
- A constraint is configurable, never hard-coded. A limit means a queue, never a refusal. *(Stands; the queue is the claim queue workers long-poll.)*
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
| `login` | KEEP | M | Blk | Redeems a single-use expiring invite link for this machine's membership; a sandbox exchanges the same string from `MYCO_JOIN_CODE` instead (plan §2.7) | #1158 |
| `server` | KEEP | C, W | Blk | The operator surface for both front doors: the self-hosted binary under `--target local` — `create`, `run`, `install`, `uninstall`, `status`, `update`, `destroy`, no container runtime and no Node on the machine that serves — and Cloudflare provisioning reduced to one verb over a prebuilt bundle (plan §2.6) | D1, D2 |
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
| `agent` | REPLACE | M, Core | Blk | Becomes `myco worker`: the same binary claiming runs by long poll and driving a local harness (plan §2.5) | B1 |
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

**Planned additions.** Laptop mode's first member is the one join `myco login` cannot serve: a Deployment created by `myco server create --target local` holds no member until an invite can be minted, and the start path exposes its `ServerEnv` for the first-start bootstrap that mints one (**#1158**, after D1). Two verbs land with their code and take rows then: `myco worker` (worker mode — long-poll claim, lease with heartbeat, harness detection; the laptop server process runs one in-process, plan §2.5, **#1151**); `myco import` (the repeatable backfill behind the join-time pass — newest 50 sessions per harness within 30 days, content-hash dedupe, tombstone gate, plan §2.2, **#1148**).

### 7.2 Dashboard routes — `packages/myco/ui/src/App.tsx`

The 1.4 URL shape is Grove- and machine-scoped (`/g/:groveSlug/...`, `/machine`). 2.0 is **project-first within one Deployment**, so every Grove-scoped and machine-scoped path drops as a *URL shape* even where the *page* is kept — the page's disposition is what the row records, and the redirect chains that exist only to forward 1.4 bookmarks drop with them.

| Route | Disposition | Surface | Blk | Replacement / reason | Owner |
|---|---|---|---|---|---|
| `/` | KEEP | UI | Blk | Root redirect into the project-first dashboard | #918 |
| `/onboarding` | REPLACE | UI | Blk | 1.4 onboards a local install; 2.0 onboards a member and a first Project | #918 |
| `/g/:groveSlug/p/:projectSlug` | REPLACE | UI | Blk | Project dashboard at a Deployment-relative project path; the Grove segment goes | #918 |
| `sessions` | KEEP | UI, Core | Blk | Read API shipped (#904); UI in #918 | #918 |
| `sessions/:id` | KEEP | UI, Core | Blk | Session detail — facts, children, transcript | #918 |
| `cortex` | KEEP | UI, Core | Blk | Digest, instructions and the map today. **Planned DROP in #1170 (sweep)** per plan §1 and §4 E1: the page does not port, instructions become the `instructions.template` Settings field, and the digest and the map go with their losses recorded | #1162 |
| `skills` | KEEP | UI, Core | Blk | Needs the server-side skills tables. **Planned DROP in #1170 (sweep)** per plan §2.4 D3: with the generation pipeline deleted and skills hand-written in the plugins, the page has nothing to curate | #1162 |
| `agent` | KEEP | UI, Core | Blk | `agent_runs` is rows, not files. **Planned REPLACE by #1162**: the runs view — one row per run outcome with its close evidence; the 1.4 page is not ported (plan §2.8) | #1162 |
| `agent/:id` | KEEP | UI, Core | Blk | Run detail with phases and write intents. **Planned REPLACE by #1162**: the prompt, the worker that claimed it, and the evidence the server verified; phases and write intents go with the executor (plan §2.5) | #1162 |
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

**Planned additions.** Two routes land with the 2.0 dashboard and take rows then: a members-and-invites page — issue, revoke, and the grants external agents hold (plan §2.8, **#1162**, **#1158**); and a KPI page showing the six measures with n — prompts with any Myco context present (primary), spore serve rate, Myco calls per prompt per harness, plan reads per session, install-to-first-injection time, eval pass rates (plan §2.8, **#1162**, **#1154**).

### 7.3 MCP tools — `packages/myco/src/tools/definitions.ts`

Every tool is served over remote HTTP MCP by the Deployment, and every tool takes a `project` parameter: reads default to the member's bound projects, writes are refused without one (plan §3 D1). Three principals share the surface — a member credential, a **run-scoped credential** whose allowlist is the task definition's declared tools mapped onto `(tool, op)` pairs (`mcp/run-surface.ts`, #1145: today `vault_spores`/`vault_spore`/`vault_create_spore`/`vault_resolve_spore`, `vault_sessions` and the two searches reach `myco_spores`, `myco_sessions` and `myco_search`; the rest of a task's tools gain MCP equivalents in #1146) and whose writes are attributed to the run, and an **external-agent grant** limited to project-scoped reads plus `myco_spores` `save` and `supersede` attributed to the grant, which carries an `agents` row of its own so its writes are revocable as a group (#1149; plan §2.5, §2.6). A grant has no Myco session, so such a write may cite the pull request or commit that produced it instead (`provenance_kind`/`provenance_ref`). Each bound principal — run or grant — is judged at the one chokepoint (`mcp/server.ts callTool`) before arguments are validated, and is told `unknown_tool` for a `(tool, op)` off its surface or a `project_id` other than its own. `alwaysLoad` is set on the entry, paired with a session-start health ping so a cold front door does not stall the session.

| Tool | Disposition | Surface | Blk | Replacement / reason | Owner |
|---|---|---|---|---|---|
| `myco_search` | REPLACE | MCP, Core | Blk | Server-side search + vector adapters; previews render each spore's `agent_line`, not its Markdown (plan §2.4) | A6 |
| `myco_cortex` | REPLACE | MCP, Core | Blk | Shrinks to `instructions`, `notifications`, `maintenance` and `projects_activity`, all server-side, with `instructions` as the default op. The digest ops go with the digest and the Canopy ops with the map, both dropped with their losses recorded (plan §1, §3 D2) | A6 |
| `myco_sessions` | KEEP | MCP, Core | Blk | The query core already serves this shape | A3 |
| `myco_plans` | KEEP | MCP, Core | Blk | Myco owns plan identity, versions, provenance and search; content writes through MCP are for plans with no file, and status is set only by an explicit status-only save (plan §2.3) | A3 |
| `myco_spores` | KEEP | MCP, Core | Blk | The write surface for the extraction outcome, for members, and — `save` and `supersede` only — for an external agent's grant, whose writes carry the grant as both agent and author and may cite a pull request or commit in place of a session (**landed in #1149**; plan §2.6) | A5 |
| `myco_skills` | KEEP | MCP, Core | Blk | Reduced to reading the hand-written skills that ship with the plugins. The generation pipeline, the candidate queue and their tables are deleted (plan §2.4, D3) | C2 |
| `myco_agent` | KEEP | MCP, Core | Blk | The read surface over `agent_runs` — the runs, their outcomes and the evidence the server verified (plan §2.5) | B2 |

### 7.4 Agent tasks — `packages/myco/src/agent/definitions/tasks/`

2.0 keeps three run outcomes and one config leaf (§3.6). The phased executor, turn budgets and per-task model routing do not survive: a task is one prompt with declared expected evidence, run on an attached worker. The `agent_runs` audit trail stays.

| Task | Disposition | Surface | Blk | Replacement / reason | Owner |
|---|---|---|---|---|---|
| `digest-only` | KEEP | Core | Blk | Hosted and on demand. Its schedule is declared and **ships switched off** — 24 h in `sleep`, one a day — so an owner's ask carries the same per-day ceiling and the same `agent.tasks.digest-only.schedule` override as the instructions task; the clock runs nothing until they turn it on. It is not in `MANUAL_ONLY_TASKS`. The server builds the run's prompt — what each tier holds, how much has landed since, and the per-tier material windows — and carries it on the run row; an owner may ask for it from scratch, which tells the run to write every tier from the material alone. The run holds `vault_report`, `vault_spores`, `vault_spore`, `vault_sessions`, `vault_read_digest` and `vault_write_digest`; each tier it writes goes through `POST /runs/digest-write`, archiving the body it replaces with the run that replaced it and filing the extract under the substrate hash the SERVER recorded. Its close evidence is a report with action `digest` or `skip`, and — for a report that claims a write — a digest row the server can see. `POST /runs/digest` serves a digest run the tier it named or nothing, so a neighbour's body is never carried forward under an absent tier's name; a run that only reads is served the nearest tier and told so. Unlike the instructions, a digest dispatch is never answered `unchanged`: the run judges tier by tier and says which it left alone. One run is budgeted 1800 s (`TASK_RUN_TIMEOUT_SECONDS`, equal to the task file's own `timeoutSeconds` and gated), its `/runs/spore` bodies are cut to the tier window's share of its full-read budget. **Planned DROP in #1170 (sweep)** per plan §1 and §3 D2: the generated digest goes and its loss is recorded — an agent gets no project-state summary before its first prompt and is told to search. | #1170 |
| `cortex-instructions` | KEEP | Core | Blk | Hosted: the server builds the input from its own reads, carries it on the run row as the run's instruction, and the run reads it back over `POST /runs/instruction`. The run holds `vault_report`, `vault_spores`, `vault_spore`, `vault_sessions` and `vault_read_digest`; its report with action `cortex_instructions` files the artifact through `POST /runs/instructions-write` under the hash the SERVER recorded, and is the run's close evidence. Scheduled every 24 h in `sleep`, one a day, **shipped switched off** — an owner turns it on with `agent.tasks.cortex-instructions.schedule.enabled` after one measured run. A dispatch whose input matches the artifact already written starts no run at all. One run is budgeted 900 s (`TASK_RUN_TIMEOUT_SECONDS`, equal to the task file's own `timeoutSeconds` and gated), and an owner's per-day ceiling is the declared block under their own `agent.tasks.<task>.schedule` override. **Planned DROP in #1170 (sweep)** per plan §2.4: instructions become config, not generation — the `instructions.template` Settings leaf, static, member-editable, ≤4 KB, validated. | #1170 |
| `cortex-prompt-builder` | KEEP | Core | Blk | Manual-only and unserved: it carries no schedule and no hosted tool surface. Recall injects the instructions at every session start, so a pasteable prompt has no consumer on a Deployment; the task stays in the catalogue for an owner's explicit ask. **Planned DROP in #1170 (sweep)** per plan §2.5: static instructions leave nothing to build. | #1170 |
| `skill-survey` | KEEP | Core | Blk | Skill lifecycle. **Planned DROP in #1170 (sweep)** per plan §2.4 D3: the generated-skill pipeline goes; two hand-written skills ship with the plugins and five of the 52 existing files are rewritten by hand. | #1170 |
| `skill-generate` | KEEP | Core | Blk | Skill lifecycle. **Planned DROP in #1170 (sweep)** per plan §2.4 D3: no generation pipeline, no candidate queue. | #1170 |
| `skill-evolve` | KEEP | Core | Blk | Skill lifecycle. **Planned DROP in #1170 (sweep)** per plan §2.4 D3: hand-written skills are revised by hand. | #1170 |
| `extract-only` | KEEP | Core | Blk | Folded into the **continuous extraction and curation** outcome — one prompt, no checkout, expected evidence the server verifies (plan §2.5) | B2 |
| `embedding-reconcile` | KEEP | Core | Blk | Not a run outcome: a deterministic server job on the wake tick, admitted by the embedding provider (plan §2.5). Cloudflare uses Workers AI `@cf/baai/bge-m3` and Vectorize; self-hosted uses sqlite-vec with configured Ollama, OpenAI-compatible, OpenAI or OpenRouter embeddings. Run steps reconcile missing and stale vectors, orphan deletion and spore hubness. | #1124 |
| `title-summary` | KEEP | Core | Blk | The **session titles and summaries** outcome: dispatched on a session's end and on an ask, run on a worker, no direct provider call on the server (plan §2.5) | B2 |
| `review-session` | KEEP | Core | Blk | **Planned DROP in #1170 (sweep)** per plan §2.5: extraction and curation run continuously over sessions as they land, so a separate per-session review has no place. | #1170 |
| `vault-evolve` | KEEP | Core | Blk | Folded into the **continuous extraction and curation** outcome — create, supersede, consolidate in one prompt (plan §2.5) | B2 |
| `supersession-sweep` | KEEP | Core | Blk | Folded into the **continuous extraction and curation** outcome, which names consolidation as its own work (plan §2.5). The inventory-then-resolve tool shape survives as that outcome's allowlist, so a sweep still never pulls a whole vault into a model's context | B2 |
| `vault-seed` | KEEP | Core | Blk | The **brownfield seeding** outcome: the one run with a checkout, seeding from code and git history, writing the managed AGENTS.md block (≤500 chars) as one atomic replacement and leaving the rest of the file untouched (plan §2.5) | B2 |
| `canopy-map` | REPLACE | Core | Blk | Grows a scan/diff phase using normal harness code-exploration tools and content hashes; maintains the map as a living document. **Gated on #910's accepted content prototype**. **Planned DROP in #1170 (sweep)** per plan §1: the owned repo map goes and its loss is recorded — orientation comes from the harness's own tools and, optionally, a deterministic third-party graph the doctor recommends. | #1170 |
| `canopy-describe` | DROP | — | Blk | Per-file descriptions and entry embeddings go with the map (plan §1) | #1170 |
| `harness-health` | DROP | — | Blk | A worker inspects its own harnesses and files findings into the notifications domain the 1.4 consumer owned; the local half is a `doctor` check (plan §2.5, §5) | #1170 |
| `container-smoke` | KEEP | Core | Blk | New in 2.0: the end-to-end proof for a server-dispatched containerized run — claim, harness, one report, terminal status. Server-dispatched only; carries no schedule. **Planned DROP in #1170 (sweep)** per plan §4 B1: replaced by the worker smoke — one run dispatched end to end on Claude Code, Codex and OpenCode, and a killed worker's run returning to the queue at lease expiry; the fixture is cut over before this task is removed. | #1170 |

### 7.5 Scheduled jobs — `packages/myco/src/constants/power-jobs.ts`

**The server-side wake tick is the only scheduler, and it schedules Deployment work only** (plan §2.5). The member binary registers no timers: the machine-side needs that survive 1.4's JobRunner — upgrade check, symbiont detection, managed-files reconcile — become the on-demand verbs `myco update` and `myco doctor`, run by the setup skill and the installer. PowerManager, its four power states and its ~24 machine-side jobs retire with the daemon (plan §5).

One idempotent tick (`core/tick.ts`) runs the due jobs, applies per-task per-day ceilings and drains the run queue; `POST /api/wake` runs the same tick on an ask. **Waking is the only platform-specific part**, and on the Worker that instant is a **Durable Object alarm**, not a cron trigger:

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
| `notification-retention` | REPLACE | Core | Blk | A tick job; the domain now carries worker health findings (plan §5) | B3 |
| `auto-backup` | REPLACE | Core, W, C | Blk | A tick job: local volume snapshot on C; owner-triggered R2 export on W | #923 |
| `database-optimize` | REPLACE | Core, C | Blk | SQLite `optimize` on C; D1 exposes no equivalent, so W reports quota/storage health instead | #922 |
| `database-integrity-check` | REPLACE | Core, C | Blk | SQLite integrity check on C; W reports schema/quota health | #922 |
| `canopy-background-scan` | REPLACE | Core | Blk | Background scan behind the map task. **Planned DROP in #1170 (sweep)** per plan §1: the map it scans for goes. | #1170 |
| `release-provenance-reconcile` | REPLACE | Core | Blk | A tick job | #922 |
| `staging-gc` | REPLACE | M, Core | Blk | The hook prunes its own spool files past a fixed age after a successful drain (**M**, plan §7); server-side blob staging GC is a tick job (**Core**) | C1, B3 |
| `symbiont-detection` | REPLACE | M | Blk | An on-demand verb, not a timer: `myco doctor` probes installed binaries and credential stores, and the worker uses the same detection to pick a harness (plan §2.5) | C2 |
| `managed-files-reconcile` | REPLACE | M | Blk | An on-demand verb: `myco update` reconciles managed assets, hooks, plugins and the managed AGENTS.md block (plan §2.5) | C2 |
| `self-reconcile` | REPLACE | M | Blk | Folds into the same `myco update` path | C2 |
| `upgrade-auto-check` | REPLACE | M | Blk | An on-demand check under `myco update`; a server format break is one binary self-update (plan §2.2) | C2 |
| `upgrade-adopt` | REPLACE | M | Blk | Adopting a staged upgrade folds into `update` | C2 |
| `service-reconcile` | REPLACE | M | Blk | Reconciles 1.4's platform service. **Planned DROP in #1170 (sweep)** per plan §2.6: the member runs no service to converge, and the self-hosted binary's user-service install is the installer's job. | #1170 |
| `capture-buffer-drain` | DROP | — | Blk | Capture is hook-invoked and write-ahead; the member drains its own spool with no scheduled job | #925 |
| `capture-only-notice-sweep` | DROP | — | Blk | Notices a degraded daemon-capture mode that no longer exists | #925 |
| `content-claim-expiry` | DROP | — | Blk | Content claims are a Team Host publication mechanism; retired with Team | #925 |
| `routed-transcript-cache-gc` | DROP | — | Blk | Routed capture is a Team Host mechanism; retired with Team | #925 |
| `routed-event-dedup-prune` | DROP | — | Blk | Routed capture is a Team Host mechanism; retired with Team | #925 |

**Planned additions.** One tick job lands with its code and takes a row then, the last lifecycle row the plan owes an owner (plan §7): the worker-lease sweep, which returns a lapsed lease's run to the claim queue so single-flight follows the lease and not the process (**#1151**). Grant expiry (**#1149**) and invite expiry (**#1158**) have landed and take their rows above.

### 7.6 Data classes — vault schema v76, `packages/myco/src/db/`

Disposition here is about the **data class**, and separately about **migration**: `MIGRATE` moves active Project data to the Deployment; `REBUILD` is derived data regenerated under the 2.0 schema; `DROP` does not migrate.

| Table | Disposition | Migration | Surface | Blk | Reason | Owner |
|---|---|---|---|---|---|---|
| `sessions` | KEEP | MIGRATE | Core | Blk | Core project intelligence | #924 |
| `prompt_batches` | KEEP | MIGRATE | Core | Blk | Already ingested by the 2.0 server | #924 |
| `session_myco_tool_calls` | KEEP | MIGRATE | Core | Blk | Tool-call history | #924 |
| `artifacts` | KEEP | MIGRATE | Core | Blk | Transcripts and responses | #924 |
| `attachments` | KEEP | MIGRATE | Core, W, C | Blk | Blob-backed; R2 on W, volume on C. Byte-lossless comparison is a #927 gate | #924 |
| `plans` | KEEP | MIGRATE | Core | Blk | Myco owns identity, versions, provenance and search; disk and GitHub stay canonical for content (plan §2.3). Gains `source`, the channel a version arrived through — a watched path, a tagged message, or an explicit save — **landed in #1147**; NULL on a row written before it, which means "inferred from the key shape" rather than a guessed default | D3, A3 |
| `spores` | KEEP | MIGRATE | Core | Blk | Gains an `author` column so a write names the principal instance behind it rather than `user` alone — **landed in #1145 (schema v24)** with the run id for a run's write and the member id for a member's, nullable for rows written before. An external agent's grant takes the same column and an `agents` row of its own, and gains `provenance_kind`/`provenance_ref` for the pull request or commit a write with no session cites — **landed in #1149 (schema v25)** (plan §2.6) | A1, A5 |
| `resolution_events` | KEEP | MIGRATE | Core | Blk | Supersede/consolidate lineage; carries `author` as `spores` does (#1145, schema v24), and `provenance_kind`/`provenance_ref` with it (#1149, schema v25) | #924 |
| `spore_injections` | KEEP | REBUILD | Core | Blk | What the prompt hook was served, per (session, prompt); 1.4 carries it on `activities` | #1044 |
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
| `agent_run_events` | KEEP | MIGRATE | Core | Blk | | #919 |
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

**Planned additions.** Three columns land with their code and take rows then: `spores.agent_line`, the ≈40-token trigger → guidance projection that injection and search previews render instead of the Markdown, backfilled once under a cost ceiling and re-derived on edit (plan §2.4, **#1150**); and `enrollment_authorities.role` and `.project_id`, what an invitation grants and the Project it binds a sandbox to — the single-use expiring invitation itself already has this table, so #1158 adds the two columns rather than a second one (plan §2.7, **#1158**).

### 7.7 Operational capabilities

Capabilities that are not a single registry token but must still carry a disposition and an owner.

| Capability | Disposition | Surface | Blk | Replacement / reason | Owner |
|---|---|---|---|---|---|
| Session, prompt, tool-call, response capture | KEEP | M, Core | Blk | Shipped; proven by the §8.4 parity run | shipped |
| Transcript capture and segmentation | KEEP | M, Core | Blk | Shipped | shipped |
| Attachment capture | KEEP | M, Core | Blk | Shipped | shipped |
| Plan capture from watched plan dirs | KEEP | M, Core | Blk | Parsed server-side from the transcript stream — `Write` calls to the allowlist, tagged messages, and the hook re-reading any allowlisted path it saw edited during the turn (plan §2.3). The channel each version arrived through is recorded on `plans.source` rather than inferred from the key shape | A3 |
| Server-side transcript parsing | KEEP | Core, W, C | Blk | New in 2.0: per-agent parsers turn a held transcript into prompts, responses, tool calls, attachments and plans, through the same projections a hook event lands in. A parser declares what its format can support, and a session whose transcript cannot carry tool results is excluded from extraction rather than believed (see the fidelity note below) | A3 |
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
| Deploy against the runs in flight | REPLACE | W | Blk | New in 2.0: `myco server update --target cloudflare` waits for the tasks the Deployment has in flight before it pushes — queued as well as running, since a dispatched run whose container has not started is the one most easily lost — bounded by each run's own budget plus the overrun margin; a Deployment whose runs cannot be read refuses the deploy rather than reading silence as quiet, and `--no-drain` ships over whatever is running. It then watches the container instances reach the pushed image before it returns, and records where they landed. A deploy shipping the image already running rolls nothing. | #1115 |
| Server logs / observability | REPLACE | Core, UI | Blk | From the telemetry the server already emits; `wrangler tail` remains the W operator view | #922 |
| Native Cloudflare intelligence provider | REPLACE | W | — | **Non-blocking follow-up** — the Intelligence Provider contract is provider-agnostic | #928 |
| Offline capture | KEEP | M | Blk | The write-ahead spool stays, drained on the next hook with backoff; the hook prunes drained files past a fixed age (plan §2.2, §7) | #1155 |

**Planned additions.** Eight capabilities land with their code and take rows then:

- **Transcript-first ingest** (**#1147**) — the on-disk transcript is the source of truth for everything it contains. The turn-end hook ships the delta past a server-held offset; segments are parsed per agent server-side, inside a Durable Object request on W (30 s CPU, against 10 ms for a plain free-tier Worker invocation) and in process on C. Identity is (path, inode, prefix hash). Five facts stay hook-exclusive: git branch, compaction trigger, notifications and errors, task-completed, wall-clock ordering (plan §2.2).
- **Bounded import and backfill** (**#1148**) — automatic on join, newest 50 sessions per harness within 30 days, content-hash dedupe, machine-scoped keys, imports not born active, tombstone gate; a repeatable command widens the window. Imported Cursor sessions carry a fidelity flag and are excluded from extraction, their JSONL having no tool results (plan §2.2).
- **Session tombstone** (**#1147**) — suppresses a mis-imported session and its derived rows, and blocks re-import (plan §2.2).
- **Run-scoped MCP credential** (**#1145**) — a third principal kind with `heldRun` per request, a per-run tool allowlist from the task definition enforced at the MCP chokepoint, and run attribution on writes. Today a run token is an ordinary member token (plan §2.5).
- **Task execution on attached workers** (**#1151**) — long-poll claim, lease with heartbeat, lease expiry returning the run to the queue; a Deployment-preferred harness with a fallback order and a per-task override; a cloud worker's harness credential held in the Deployment's encrypted store and injected per run (plan §2.5).
- **Invite and join** (**#1158**, landed) — single-use expiring invite links and `myco login <url>` for humans; a join code in `MYCO_JOIN_CODE` for sandboxes and CI, exchanged at first contact for a member credential. The Project is bound when the invitation is **minted**, not resolved from the repo remote at first contact: the normalized-remote leg of Project Resolution (§3.1) belongs to the `project` tool parameter of D1 tenancy, and binding at mint leaves a sandbox with nothing to guess — a code carrying no Project is refused `enrollment_no_project` and stays unspent. Admin and member roles only; revocation kept (plan §2.7).
- **Eval suite** (**#1154**) — recorded real sessions as fixtures with a redaction gate before commit, a hand-annotated gold set of 30–50 cases, deterministic graders per PR against replayed recordings, and a weekly capped judged run required on releases (plan §2.5, §7).
- **Grant-attributed spore writes** (**#1149**) — an author column and an agent row per grant, so an external agent's create or supersede carries the grant rather than `user`, optionally citing a PR or commit instead of a session (plan §2.6).

**Where the parse runs, and why it is not a Durable Object request.** Plan §2.2 states that parsers run "inside a Durable Object request on Cloudflare (30 s CPU)". Two facts measured against the tree and against Cloudflare's published limits (2026-09-08) put the mechanism elsewhere, and the decision — parsers server-side, per agent, on both front doors — is unchanged by it.

- **The CPU claim is unverified for the Free tier.** The Workers limits page gives one tier-split CPU table, 10 ms on Free and 5 min (default 30 s) on Paid; the Durable Objects page publishes a DO-specific row of 30 s that is *not* tier-split. The DO relaxations that are unambiguous are wall time, which was never the constraint.
- **The binding constraint is subrequests, and a Durable Object does not relax it.** Free allows **50 subrequests per invocation**, D1 and blob reads both count, and each event ingested through its own batch spends one.

Measured: an 8 MiB segment of a real Claude Code transcript parses in ~11 ms, which is one whole free-tier CPU budget — and that figure is `JSON.parse` alone, before deriving, hashing or writing. So the parse is a **tick job bounded by the database calls a pass may spend**, resumable over a byte cursor, landing derived events in one batch. On the Worker the tick's own timer already *is* a Durable Object alarm, so any CPU headroom that exists is inherited with no new class, binding or migration tag; on the binary the same job runs in-process. Nothing under `platform/` differs between the two, which is what §3.3 requires. A per-target parse entry was designed and dropped on these numbers.

**Transcript identity, and what the head digest does not cover.** A transcript is named by (machine, path, inode). A file truncated and rewritten in place keeps all three, so the server records a digest of its first bytes and refuses a segment that disagrees with the one held — terminally, rather than appending one file's bytes to another's record. Two limits are stated rather than implied: a rewrite leaving the first bytes intact passes, so this catches replacement and truncation rather than every edit; and it is **inert until the member sends the field**, which is C1's half (**#1155**). C1 must ship sending and re-minting together — sending alone would park a transcript on a refusal it cannot answer.

**Fidelity is a property of a format, not of a file.** Cursor's transcript carries no tool results, so no parse of one can produce them and a session captured from it is structurally incomplete. Each parser declares what its format supports, the transcript records it, and extraction excludes such sessions **by default at the read layer's own definition** rather than by an argument at each call site: `listSessions` defaults to full fidelity and `listSessionSummaries` opts out, so a reader that assembles material inherits the rule and a reader that shows history does not. The dashboard still shows them: a hidden session is an absence a person can see, while a spore extracted from a knowingly incomplete transcript reads exactly like a good one. Only one of those is discoverable after the fact.

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
| `cortex.enabled` | REPLACE | Project | Core | Capability master gate; per-Project admission, fail-closed when absent | #915 |
| `cortex.instructions.inject_on_session_start` | REPLACE | Deployment | Core | Applied by the Deployment on `POST /context/session`, once per session | #1026 |
| `cortex.instructions.inject_on_subagent_start` | REPLACE | Deployment | Core | Applied by the Deployment on `POST /context/session`, once per subagent | #1026 |
| `cortex.digest.tier` | REPLACE | Deployment | Core | Digest size the Deployment generates and serves at session start, nearest tier held when the exact one is absent. **Planned DROP in #1170 (sweep)** per plan §1 and §3 D2: it sizes an artifact that goes. | #1170 |
| `cortex.digest.inject_on_session_start` | REPLACE | Deployment | Core | Applied by the Deployment on `POST /context/session`; off unless a Deployment asks for it. **Planned DROP in #1170 (sweep)** per plan §2.4: session start will serve `instructions.template` and nothing generated. | #1170 |
| `cortex.spores.inject_on_prompt_submit` | REPLACE | Deployment | Core | Applied by the Deployment on `POST /context/prompt` | #1026 |
| `cortex.spores.max_per_prompt` | REPLACE | Deployment | Core | Applied by the Deployment on `POST /context/prompt`, clamped to 0..10 | #1026 |
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

**Planned additions.** Six Deployment leaves land with their code and take rows then — the leaf registry (`core/settings.ts`) and this table are held equal in both directions, so a leaf named here before it exists would refuse every write: `instructions.template`, the static session-start instructions any member edits, ≤4 KB, Markdown only, validated on write, and the leaf that replaces the `cortex-instructions` and `cortex-prompt-builder` tasks (plan §2.4, **#1150**); `worker.harness` and `worker.harness_fallback`, the harness a worker prefers and the order it falls back through, each overridable per task (plan §2.5, **#1151**); and `import.enabled`, `import.window_days` and `import.max_sessions_per_harness`, the bounds on the join-time backfill — 30 days and 50 sessions per harness (plan §2.2, **#1148**).

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
