# Myco 2.0 — Canonical Architecture and Feature-Preservation Ledger

> **TL;DR.** Myco 2.0 is one feature-complete server product with two first-class deployment targets (Cloudflare, self-hosted Compose) plus a thin machine-side Member Installation. This document is the single current architecture record for the whole 2.0 release and the completeness ledger that gives every 1.4 surface an explicit KEEP / REPLACE / DROP disposition and an owning surface. It is machine-enforced by `tests/meta/feature-ledger-completeness.test.ts`.

**Issue:** [#906](https://github.com/goondocks-co/myco/issues/906) · **Program map:** [#905](https://github.com/goondocks-co/myco/issues/905) · **Execution protocol:** Myco plan `0a5f6a8580788429`

## 1. Authority

Use this order when sources disagree:

1. `AGENTS.md` and nested instructions govern how work is performed.
2. **GitHub #905** is the canonical program map and settled product model.
3. The claimed child issue is the executable scope and acceptance contract.
4. Current code, tests, CI, deployments, and migration evidence determine actual state.
5. **This document** is the current architecture and disposition record for the 2.0 release.
6. Earlier Myco plans and specs are lineage and research inputs, not current authority.

This document does not restate #905's live scope, dependencies, or status. GitHub is the live status source; this is the durable architecture and ledger.

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

Execution proceeds through #905's children #906–#928 under plan `0a5f6a8580788429`. This document's §7 rows name the owning child issue.

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

### 3.3 One server product, two adapters

Cloudflare and self-hosted Compose implement **one common server contract and shared core** with platform-specific adapters — not divergent products.

| | Cloudflare Deployment (**W**) | Self-hosted Deployment (**C**) |
|---|---|---|
| API + assets | Worker with static assets | Bun server container |
| Relational store | D1 | Embedded SQLite |
| Blob store | R2 | Local volume adapter |
| Vector store | Vectorize | Local SQLite vector adapter |
| Wake / schedule | Durable Object alarm + cron | In-process scheduler |
| Secret wrapping key | Secrets Store binding | Env or file (`secrets.env` idiom) |
| Harness | One container per run (#914, live) | Same harness image beside the server (**#913**) |
| Durable storage | Platform-managed | Mounted volume under Compose |

Shared behavior belongs in the common core; target-specific infrastructure, storage, wake, TLS/proxy, backup, and observability behavior belongs in adapters. **Neither target may silently lose a feature because the other implemented it first.** A ledger row naming a capability without its per-target mechanism is how one target never gets it.

Cloudflare is the primary real dogfood Deployment; self-hosted Compose receives equal release proof (#927).

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

### 3.4 Member Installation and the Member Service

The machine-side product contains the `myco` CLI, hooks, MCP bridge, spool, local registry/configuration, and — on long-lived developer machines — a resident **Member Service**. It owns **no vault and no dashboard** and is not the server-side capture or intelligence authority.

The Member Service inherits the 1.4 service's continuous-maintenance responsibility. **One idempotent reconciliation path** runs on install, start, update, repair, and relevant symbiont changes to upgrade Myco-managed global assets and **every locally registered Project**: configuration/schema revisions, launchers and runtime pins, hook and MCP registrations, skill registrations and symlinks, and generated assets. Each shared resource keeps its canonical writer. A failure in one Project is reported and retried without hiding it or blocking healthy Projects.

This is **not 1.4's daemon returning**: it holds no vault, serves no UI, and is never on capture's path — capture stays hook-invoked and write-ahead per the member seam (#901).

**Sandbox images ship the CLI, hooks, and injected credentials with no resident service** — their symbionts are fixed at build time and the container is short-lived.

### 3.5 Cutover

The transition is a **one-time, one-way migration**, not long-term coexistence or dual writing.

The installed 1.4 binary owns its existing `myco remove --yes` behavior (**Legacy Removal Boundary**). The 2.0 installer invokes it **without `--purge`**, verifies the old service and integrations are stopped, and preserves the full 1.4 home and data. It then installs the 2.0 Member Service, performs and verifies initial managed-asset reconciliation, runs `myco setup`, and migrates all **active** Project data to the configured Deployment.

Source data is never automatically deleted. Historical vectors and derived assets are rebuilt under the 2.0 schema. Already-archived 1.4 Projects, legacy topology/config/credentials, old vectors, and retired Canopy entries do not migrate.

The current both-mode dogfood (1.4 user-level hooks plus the 2.0 member project-local on this repo) is preserved until **#924** performs the cutover.

### 3.6 Agent task execution — how 1.4 drives tasks today, and the 2.0 mechanism on both targets

Recorded 2026-09-02 after #1045 S4 found the server titling a session with a direct model call. The account below is the ground every dispatch, scheduling and cost decision in 2.0 starts from; the principles at the end are Chris's, closed, and not re-opened by a slice.

**1.4 today — one daemon, on metal, driven by activity.** One scheduler job (`scheduled:tasks`) ticks on the PowerManager's clock and walks every project; each task filters itself on its own `runIn` states, its interval (divided by backlog tier), its accelerator, its `preCondition`, its `maxRunsPerDay`, `requiresTaskProvider` and `runWhenCold` (`packages/myco/src/daemon/task-scheduler.ts:168-360`, `task-scheduling.ts:843-914`). A kick is a one-shot bypass consumed on the next tick. Activity is the throttle: the global PowerManager resolves `active`/`idle`/`sleep`/`deep_sleep` from inactivity (5 m / 30 m / 90 m, `constants.ts:521-529`; `daemon/power.ts:236-308`), deep sleep stops the timer outright (`power.ts:335-340`), a per-project tracker applies the same thresholds (`project-power-state.ts:95-120`), a sleeping project simply fails every task's `runIn`, and a cold project (14 days) runs nothing but `runWhenCold`. Session-driven tasks are event-fired, not scheduled: the Stop hook dispatches `title-summary` fire-and-forget (`stop-processing.ts:641`, `trigger-title-summary.ts:65-116`), the prompt boundary fires it every `summary_batch_interval` human batches, `cortex-prompt-builder`/`cortex-instructions` fire behind `agent.event_tasks_enabled`, and `review-session` is manual. Concurrency is what one process tolerates: the JobRunner holds three slots in two fair lanes (`job-runner.ts:98-140`), the tick keeps an in-memory per-(grove, project, task) running set (`task-scheduler.ts:267,340-350`), the executor refuses a duplicate of the same task until its `timeoutSeconds + 300 s` (`executor.ts:87-124`), runs are detached, and there is no global run limit and no queue — work not admitted this tick is retried next tick. The provider resolves task-first then Deployment default (`config-resolver.ts:323-326`), and a missing key refuses the dispatch (`task-scheduling.ts:645-658`). This is sound on metal, where one person's presence bounds the cost.

**2.0 destination — a cloud Deployment serving many members, always on.** A Deployment is not one person's machine: members and partners work at all hours, work arrives from capture, from the dashboard and from the clock at once, and the harness runs each task in its own container precisely so that tasks are independent of one another. Cloud architecture manages that with a scheduler, a queue and constraints, and 2.0 does too. The mechanism, on both targets:

1. **Triggers.** Capture (a session's end → `title-summary`, `review-session`; a prompt boundary → the Cortex tasks), a member's or owner's ask (a dashboard control, a route, an MCP tool), and the wake tick (#1091 S3: `core/scheduled-tasks.ts` visits every Project the Deployment holds for every task `TASK_SCHEDULE` in `core/task-catalogue.ts` schedules, in the 1.4 gate order — the `agent.scheduled_tasks_enabled` switch, the Project's recency against `agent.scheduled_tasks_active_window_days` and `agent.cold_project_threshold_days`, the Project's capability, the task's `overlap` policy, the interval shortened by an accelerator tier, `runIn`, a named `preCondition`, `maxRunsPerDay` — and dispatches through the one dispatcher, attributed to the clock; a ceiling met is a `skipped` run row naming it. A task is scheduled only once the Deployment serves its tool surface: `container-smoke` daily while asleep is the first, the health probe 1.4 ran as `harness-health`; the rest are null until their children turn them on with the task file's block. The clock's runs call back to `MYCO_ORIGIN`, the origin the operator declared — rendered into the deploy config from the deployment record on W, an environment value on C — never one learned from a request's Host. The clock resolves one power state for the whole Deployment, not one per Project as 1.4 did: a Deployment in use anywhere is in use; a task that runs only while asleep waits for the whole Deployment to sleep.)
2. **The dispatcher** (`packages/myco-server/src/core/harness.ts`, landed by #1045 S4 with titling as its first consumer): one implementation for every trigger, in two steps so a caller with its own claim to make can prepare, claim, then launch. `prepareDispatch` takes admission from the catalogue (`core/task-catalogue.ts`; the container claims `captureDriven` for a provider-gated task and the capability name otherwise, from `MYCO_TASK_ADMISSION`), resolves the provider task-first as 1.4 does, and opens the credential; `launchDispatch` mints the run's credential, hands the parameters as `MYCO_TASK_PARAMS` (the container records them as `run_context`), and starts the container. The queue sits between the two once #1091 lands.
3. **The queue** (#1091 S2): a queued run is a run row — `agent_runs.status = 'queued'` with `queued_at`, `held_by` (the limit that holds it) and `dispatch_spec` (the launch it was asked for), no credential until it launches — so the Agent runs page, the run reads and retention all see it as a run. Limits are Settings leaves — `agent.limits.concurrent_runs`, `agent.limits.task_concurrent_runs`, `agent.limits.task_runs_per_hour` — unset meaning unbounded; the fleet is the fourth holder, from the deploy config. `admitDispatch` in `core/harness.ts` decides between `prepareDispatch` and `launchDispatch`; a dispatch past a limit is queued and wakes the Deployment, never refused. `drainQueue` runs on the wake tick and after every terminal write the update route lands, oldest first, preparing and admitting each row again as the load stands; a queued run keeps the Deployment awake. The fleet size is what the operator deployed (S4): `myco server config --fleet N` writes the deployment record, the renderer sets `max_instances = N` and `MYCO_FLEET = "N"` in the deploy config, and the dispatcher counts against `ServerEnv.fleet` like any limit — one number, one source, never also an owner leaf.
4. **The launch adapter**, the only per-target part: on **W** one Durable Object and one container per run (`platform/cloudflare/harness-container.ts`, hold renewal in `run-hold.ts`, `wrangler.toml` `max_instances`); on **C** a harness runner beside the server (#913 — today the Bun target has no `harnessLaunch` and every dispatch answers `harness_unavailable`, `platform/bun/env.ts:74-97`).
5. **The wake tick**, per §7.5: a Durable Object alarm with a cron floor on **W**, an in-process timer on **C**, both feeding one idempotent tick (`core/tick.ts`, #1091 S1) that resolves the power state (`core/power.ts`), runs the due jobs (`core/jobs.ts` + `core/jobs-run.ts`: run retention and the stale-run sweep today; the rest deferred to their owners by name) and drains the queue. An owner's `POST /api/wake` runs the same tick; a run inside its bound holds the Deployment at idle, a run past it holds nothing and is swept.
6. **The claim** (`core/runs.ts`): the run id, nothing more. The dispatcher writes the run's row `pending` with the dispatch's parameters as its context and the minted credential as `dispatched_by`; the runtime's claim moves that row to `running` for that credential alone, so what the run routes read about a run is always the server's word. The per-(project, task) single-flight carried from the 1.4 executor leaves the claim; overlap policy for a scheduled sweep that must not overlap itself is a per-task setting the dispatcher reads.
7. **Power policy stays**: nothing *scheduled* runs while a Deployment sleeps, and no alarm costs nothing; *requested* work (a session ending, a person asking) enqueues and runs regardless, and wakes the Deployment.

**Principles (Chris, 2026-09-02, closed):**
- Every agent task runs through the agent harness with the configured provider and credentials. Title and summary are no exception. There is no interim direct model call, on either target.
- The run is the unit of work: one run id, one container, any number at once across triggers, schedules, sessions and Projects.
- A constraint is configurable, never hard-coded. A limit means a queue, never a refusal.
- One core, two launch adapters; neither target loses the feature because the other landed it first (§3.3).
- Decisions about dispatch start from how 1.4 drives tasks today, and are recorded here before a slice builds on them.

**What 2.0 has and lacks against 1.4 (2026-09-02, after #1045 S4):** has — the catalogue and admission gates wired through the one dispatcher, per-task provider routing into the container, the run rows the dispatcher writes and the runtime's claim moves to running (idempotent for the dispatched credential, exactly once for any other id), resume and hold, one container per run on W, `afterResponse` for work past a request, a pure power policy and job registry, and titling as the first task dispatched on a session's end and on an owner's ask; lacks — a scheduler and wake delivery on either target, a queue and any configurable limit (the only limiter is `max_instances = 12`), a session-end path for any task but titling, run retention and cancellation, a self-hosted launch, and dispatch for the openai, openrouter, ollama and lmstudio providers (the dispatcher serves anthropic and openai-compatible). Owners: #1091 (queue, limits, wake tick, retention), #913 (self-hosted launch, the other providers), #915 (scheduling leaves).

## 4. Owning-surface vocabulary

Every ledger row carries one or more of these. This is the closed set the gate accepts.

| Code | Surface | Owns |
|---|---|---|
| **M** | Member Installation | CLI, hooks, MCP bridge, spool, member registry, capture, member credential |
| **MS** | Member Service | Resident local reconciliation: symbiont health, hook/MCP registration, managed assets, per-Project convergence |
| **Core** | Shared server core | Vault, query core, intelligence, task runtime, notifications, access grants — target-independent |
| **W** | Cloudflare adapter | Target-specific mechanism on Cloudflare |
| **C** | Self-hosted adapter | Target-specific mechanism on Compose |
| **UI** | Server dashboard | Human surface served by the Deployment |
| **MCP** | Server MCP surface | Normal member MCP and external read-only MCP |
| **—** | none | DROP rows only |

`Core` alone means the mechanism is identical on both targets. `Core + W/C` means the need is shared but the mechanism differs per target and **both must be named** before the row is implementable.

## 5. Actor × deployment target × lifecycle matrix

Actors follow [`actors-and-boundaries.md`](actors-and-boundaries.md): the **Myco agent** (internal harness), **Symbionts** (coding agents), and **Users** (humans). 2.0 adds **Operator** (Deployment infrastructure lifecycle) and **External Agent** (read-only MCP, non-member).

| Lifecycle stage | User | Symbiont | Myco agent | Operator | External Agent |
|---|---|---|---|---|---|
| **Install** | `myco` install script → CLI + hooks + Member Service (**M**, **MS**) | — | — | — | — |
| **Setup** | `myco setup` — create/connect Deployment, join, Default Deployment, verify capture (**M** → **Core**) | — | — | `myco server create` (**W**/**C**) | — |
| **Server operation** | — | — | — | `myco server update\|inspect\|rotate\|backup\|adopt\|restore\|remove\|github-app` (**W**/**C**; `github-app` registers the dashboard's sign-in app on GitHub from a manifest and installs its credentials) | — |
| **Enrollment** | Join with Enrollment Authority → Member Credential (**Core**) | — | — | Issues Enrollment Authority (**Core**) | Receives project-scoped read-only grant (**Core**) |
| **Capture** | — | Hooks write-ahead to spool, drain to Deployment (**M** → **Core**) | — | — | none |
| **Intelligence** | Views results (**UI**) | Reads via MCP (**MCP**) | Runs tasks in the harness container (**Core** + **W**/**C**) | — | none |
| **Recall** | — | `UserPromptSubmit` recall endpoint (**Core**) | — | — | Read-only project MCP (**MCP**) |
| **Admin** | Deployment Settings, enrollment, external grants, provider credentials — all members, flat (**UI**, **Core**) | — | — | — | none |
| **Local health** | `myco doctor` (**M**) | — | — | — | — |
| **Maintenance** | — | — | — | — | — |
| ↳ machine-side | Managed Asset Reconciliation, continuous (**MS**) | — | — | — | — |
| ↳ server-side | Retention, optimize, integrity, backup (**Core** + **W**/**C**) | — | — | — | — |
| **Backup/restore** | Backup from dashboard (**UI**) | — | — | Restore is a break-glass operator procedure (**W**/**C**) | — |
| **Project movement** | Project Binding change (**M**) | — | — | Project Reassignment (**Core**) | — |
| **Update** | `myco update` → Member Service reconciles (**M**, **MS**) | — | — | `myco server update` (**W**/**C**) | — |
| **Migration** | 1.4 → 2.0 one-time cutover (**M** + **Core**) | — | — | — | — |
| **Removal** | `myco remove` (member only; server destroyed by Operator) (**M**) | — | — | `myco server remove` (**W**/**C**) | — |

**Sandbox Runtime** is not a row: it is a **Member Runtime** acting as the same member, with the Install row's Member Service omitted and credentials injected.

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
| Local service = symbiont health (OPEN-10) | The **Member Service**'s role is materially larger: idempotent **Managed Asset Reconciliation** across global assets **and every locally registered Project** | Glossary "Managed Asset Reconciliation" |
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

Every row: an exact registry token, a disposition, an owning surface, and the child issue that carries it. `Blk` marks release-blocking (must close before `myco/v2.0.0`); `—` marks non-blocking follow-up.

Dispositions: **KEEP** — exists in 2.0 in recognisable form. **REPLACE** — the need survives, the mechanism changes; the replacement is named. **DROP** — the need itself disappears; a reason is required, and "no local daemon" is a reason only when the capability existed *to manage* the daemon.

### 7.1 CLI commands — `packages/myco/src/cli.ts`

| Command | Disposition | Surface | Blk | Replacement / reason | Owner |
|---|---|---|---|---|---|
| `member` | KEEP | M | Blk | Already the 2.0 surface; gains Deployment-aware join | #916 |
| `server` | KEEP | C | Blk | The 2.0 self-hosted operator surface; provisions and runs the Compose stack `host` no longer serves | #913 |
| `settings` | KEEP | M | Blk | Sandbox entry point; #927's proof runs through it | #917 |
| `hook` | KEEP | M | Blk | The capture entry point | #917 |
| `mcp` | KEEP | M, MCP | Blk | Retargeted at the Deployment | #921 |
| `tool` | KEEP | M, MCP | Blk | CLI mirror of the MCP surface | #921 |
| `version` | KEEP | M | Blk | | #917 |
| `update` | KEEP | M, MS | Blk | Member self-update; triggers Managed Asset Reconciliation | #922 |
| `doctor` | REPLACE | M | Blk | Checks member wiring, registry mode, credential liveness, spool depth, **and Deployment reachability from this machine**; absorbs `harness-health` | #917 |
| `remove` | REPLACE | M | Blk | Member uninstall only; a Deployment is destroyed by the Operator, not the CLI | #917 |
| `open` | REPLACE | M | Blk | Opens the Deployment dashboard URL | #918 |
| `search` | REPLACE | M, Core | Blk | Server-backed search + vector adapters | #921 |
| `vectors` | REPLACE | M, Core | Blk | Server-side vector search | #921 |
| `session` | REPLACE | M, Core | Blk | Server-backed read | #921 |
| `stats` | REPLACE | M, Core | Blk | Deployment quota/storage/schema health; today reads a local SQLite file | #922 |
| `logs` | REPLACE | M | Blk | Local log files under `MYCO_HOME` with a CLI view; server logs are a separate surface (**UI**) | #922 |
| `config` | REPLACE | M, Core | Blk | Two tiers: Member Settings local, Deployment Settings server-side | #915 |
| `setup-llm` | REPLACE | Core, UI | Blk | Deployment Settings — Intelligence Provider credentials | #915 |
| `setup-digest` | REPLACE | Core, UI | Blk | Deployment Settings — schedules and retention | #915 |
| `detect-providers` | REPLACE | Core | Blk | Server-side provider detection under Deployment Settings | #915 |
| `verify` | REPLACE | Core | Blk | Server-side provider connectivity check | #915 |
| `agent` | REPLACE | Core | Blk | The container-job harness runner | #919 |
| `task` | REPLACE | Core | Blk | Server-side task definitions and runtime | #919 |
| `upgrade` | REPLACE | M | Blk | Folds into `update` | #922 |
| `__apply-update` | REPLACE | M | Blk | Internal update orchestration retained under the 2.0 installer | #922 |
| `__restore-backup` | REPLACE | W, C | Blk | Restore becomes the `myco server restore` Operator path | #923 |
| `__finish-uninstall` | REPLACE | M | Blk | Internal teardown retained for member-only removal | #917 |
| `daemon` | DROP | — | Blk | There is no daemon. The Member Service is not a daemon: no vault, no UI, never on capture's path | #925 |
| `restart` | DROP | — | Blk | Nothing to restart; the Member Service is managed by `service` semantics folded into install/update | #925 |
| `service` | DROP | — | Blk | 1.4's platform service manages the daemon. The Member Service's lifecycle is owned by the installer | #917 |
| `subsystem` | DROP | — | Blk | Machine-global daemon ownership arbitration; no daemon to arbitrate | #925 |
| `grove` | DROP | — | Blk | Grove is deleted; Deployment is the boundary | #925 |
| `join` | DROP | — | Blk | Team Host enrollment retired; `member join` is the 2.0 path | #925 |
| `leave` | DROP | — | Blk | Team Host detach retired; `member leave` is the 2.0 path | #925 |
| `attach` | DROP | — | Blk | Team Host project routing retired; Project Binding replaces it | #925 |
| `detach` | DROP | — | Blk | Team Host project routing retired | #925 |
| `host` | DROP | — | Blk | Team Host serving retired; a Deployment is the server | #925 |
| `init` | DROP | — | Blk | Already a no-op stub — registration is automatic on first hook | #925 |

### 7.2 Dashboard routes — `packages/myco/ui/src/App.tsx`

The 1.4 URL shape is Grove- and machine-scoped (`/g/:groveSlug/...`, `/machine`). 2.0 is **project-first within one Deployment**, so every Grove-scoped and machine-scoped path drops as a *URL shape* even where the *page* is kept — the page's disposition is what the row records, and the redirect chains that exist only to forward 1.4 bookmarks drop with them.

| Route | Disposition | Surface | Blk | Replacement / reason | Owner |
|---|---|---|---|---|---|
| `/` | KEEP | UI | Blk | Root redirect into the project-first dashboard | #918 |
| `/onboarding` | REPLACE | UI | Blk | 1.4 onboards a local install; 2.0 onboards a member and a first Project | #918 |
| `/g/:groveSlug/p/:projectSlug` | REPLACE | UI | Blk | Project dashboard at a Deployment-relative project path; the Grove segment goes | #918 |
| `sessions` | KEEP | UI, Core | Blk | Read API shipped (#904); UI in #918 | #918 |
| `sessions/:id` | KEEP | UI, Core | Blk | Session detail — facts, children, transcript | #918 |
| `cortex` | KEEP | UI, Core | Blk | Digest, instructions, Canopy map | #919 |
| `skills` | KEEP | UI, Core | Blk | Needs the server-side skills tables | #919 |
| `agent` | KEEP | UI, Core | Blk | `agent_runs` is rows, not files | #919 |
| `agent/:id` | KEEP | UI, Core | Blk | Run detail with phases and write intents | #919 |
| `/settings` | REPLACE | UI, Core | Blk | Rebuilt against Deployment Settings + Member Settings; the four-tier scoped model does not survive | #915 |
| `/logs` | REPLACE | UI, Core | Blk | Server logs from emitted telemetry. 1.4's **local** Logs page does not port — local logs are CLI-only (**M**) | #922 |
| `/g/:groveSlug/operations` | REPLACE | UI, W, C | Blk | Backup/diagnostics/update, per-target mechanism | #923 |
| `/g/:groveSlug/dashboard` | REPLACE | UI | Blk | Grove dashboard folds into the Deployment status surface | #918 |
| `/machine` | REPLACE | UI | Blk | Machine tier is gone; the equivalent question ("which runtimes write here, are they alive?") is a Deployment members/runtimes view | #918 |
| `/system` | REPLACE | UI | Blk | Folds into the Deployment status surface | #918 |
| `/symbionts` | REPLACE | M, MS | Blk | Symbiont detection is a **machine** question — `doctor` and Member Service reconciliation, not a dashboard page | #917 |
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

### 7.3 MCP tools — `packages/myco/src/tools/definitions.ts`

The member's MCP bridge talks to the Deployment. External agents get a project-scoped read-only subset.

| Tool | Disposition | Surface | Blk | Replacement / reason | Owner |
|---|---|---|---|---|---|
| `myco_search` | REPLACE | MCP, Core | Blk | Server-side search + vector adapters | #921 |
| `myco_cortex` | REPLACE | MCP, Core | Blk | Digest, instructions, Canopy map/entry, notifications, maintenance summary, projects activity — all server-side; `canopy_entry` returns mechanical fields only once entry embeddings retire (#920) | #921 |
| `myco_sessions` | KEEP | MCP, Core | Blk | The query core already serves this shape | #921 |
| `myco_plans` | KEEP | MCP, Core | Blk | **Closes the one §8.4 parity miss** — MCP-written plans reach the server only here | #921 |
| `myco_spores` | KEEP | MCP, Core | Blk | Needs the server-side spores tables; `session_id` names the session a member's spore belongs to, or the session that retired one | #919 |
| `myco_skills` | KEEP | MCP, Core | Blk | Needs the server-side skills tables | #919 |
| `myco_agent` | KEEP | MCP, Core | Blk | Needs server-side `agent_runs` | #919 |

### 7.4 Agent tasks — `packages/myco/src/agent/definitions/tasks/`

Task YAML, the phased executor, turn budgets, model routing, and the `agent_runs` audit trail carry over unchanged, running inside the harness container.

| Task | Disposition | Surface | Blk | Replacement / reason | Owner |
|---|---|---|---|---|---|
| `digest-only` | KEEP | Core | Blk | Recall depends on it | #919 |
| `cortex-instructions` | KEEP | Core | Blk | Recall depends on it | #919 |
| `cortex-prompt-builder` | KEEP | Core | Blk | Recall depends on it | #919 |
| `skill-survey` | KEEP | Core | Blk | Skill lifecycle | #919 |
| `skill-generate` | KEEP | Core | Blk | Skill lifecycle | #919 |
| `skill-evolve` | KEEP | Core | Blk | Skill lifecycle | #919 |
| `extract-only` | KEEP | Core | Blk | Spore extraction | #919 |
| `title-summary` | KEEP | Core | Blk | Dispatched to the harness on a session's end and on an owner's ask, through the one dispatcher (§3.6); no direct provider call on the server — #1033's after-response call was a deviation, removed by #1045 S4 | #1045, #1091 |
| `review-session` | KEEP | Core | Blk | | #919 |
| `vault-evolve` | KEEP | Core | Blk | | #919 |
| `supersession-sweep` | KEEP | Core | Blk | Served on the harness on demand: a run holds the spore tools over run routes — an inventory of previews, one spore in full, create, and resolve — so a sweep never pulls a whole vault into a model's context. Carries no schedule; one waits on measurement of what a pass costs and finds | #1044 |
| `vault-seed` | KEEP | Core | Blk | | #919 |
| `canopy-map` | REPLACE | Core | Blk | Grows a scan/diff phase using normal harness code-exploration tools and content hashes; maintains the map as a living document. **Gated on #910's accepted content prototype** | #920 |
| `canopy-describe` | DROP | — | Blk | Per-file fan-out and entry embeddings retire. **Named cost:** semantic Canopy search ends and `canopy_entry` returns mechanical fields only | #920 |
| `harness-health` | DROP | — | Blk | Inspects a local harness — a machine question. Its checks move into `doctor` (**M**) | #917 |
| `container-smoke` | KEEP | Core | Blk | New in 2.0: the end-to-end proof for a server-dispatched containerized run — claim, harness, one report, terminal status. Server-dispatched only; carries no schedule | #914 |

### 7.5 Scheduled jobs — `packages/myco/src/constants/power-jobs.ts`

PowerManager keeps its policy; **waking is platform-specific** (Durable Object alarm + cron on W, in-process scheduler on C).

That division is the whole design, and it is worth stating why so it is not re-opened. `PowerManager` resolves four states (`active`/`idle`/`sleep`/`deep_sleep`) from registered assertions — the OS idiom of IOPMAssertion, systemd inhibit and wake locks — and computes an interval from them. Today that interval reaches a `setTimeout` (`packages/myco/src/daemon/power.ts`), which hands the resolved state to `JobRunner.dispatch`. **The timer is the only platform-specific part**: policy, states, assertions and job registry are shared, and a target supplies nothing but "wake me at this instant".

On the Worker that instant is a **Durable Object alarm**, not a cron trigger:

- An alarm takes an absolute time at **millisecond** precision and is re-armed on each fire — the same shape as the `setTimeout` it replaces. A cron expression bottoms out at one minute and cannot express an interval computed from assertions.
- **No alarm set means nothing runs.** That is exactly what `deep_sleep` means, and it costs nothing. A cron trigger fires whether or not there is work, which is the opposite of what a power manager is for.
- Cron triggers are capped **per account** (5 on the free plan, 250 on paid), so making them the primary waker would ceiling how many Deployments an account can host. Alarms carry no such cap.

A **low-frequency cron trigger is still configured, as a recovery floor**. An alarm is state held inside the Durable Object: if it is never armed — a defect, or a Deployment that has never taken a request — nothing ever wakes and the failure is *silent*. Cron is externally guaranteed and is the only thing that recovers that. It is insurance, not the mechanism.

Alarms may fire more than once, so **the tick must be idempotent**. The assertion model already satisfies this by construction — each evaluation re-probes its sources and recomputes the state rather than accumulating — and a gate must fail by name if a tick ever carries state between invocations.

The port is settled by **#1091** as `ServerEnv.wake` — "wake me soon", called by requested work — and the tick in `packages/myco-server/src/core/tick.ts`, which names its own next instant in its report; each target's clock arms that instant: `DeploymentClock` (a Durable Object alarm, `*/15` cron as the floor) on W, the process wake loop in `platform/bun/wake-loop.ts` on C. `POST /api/wake` runs the same tick on an owner's ask. The per-key `WakeScheduler` proposal is withdrawn: no consumer needed absolute instants by key.

| Job | Disposition | Surface | Blk | Replacement / reason | Owner |
|---|---|---|---|---|---|
| `embedding-reconcile` | REPLACE | Core, W, C | Blk | Server-side against Vectorize / SQLite vectors | #919 |
| `session-maintenance` | REPLACE | Core | Blk | Server-side session lifecycle | #919 |
| `log-retention` | REPLACE | Core | Blk | Server log retention; local logs retained by **M** | #922 |
| `agent-run-retention` | REPLACE | Core | Blk | Server-side | #919 |
| `notification-retention` | REPLACE | Core | Blk | Server-side | #922 |
| `auto-backup` | REPLACE | Core, W, C | Blk | Volume snapshot on C; owner-triggered R2 export on W | #923 |
| `database-optimize` | REPLACE | Core, C | Blk | SQLite `optimize` on C; D1 exposes no equivalent, so W reports quota/storage health instead | #922 |
| `database-integrity-check` | REPLACE | Core, C | Blk | SQLite integrity check on C; W reports schema/quota health | #922 |
| `canopy-background-scan` | REPLACE | Core | Blk | Scan/diff phase of the new map task | #920 |
| `release-provenance-reconcile` | REPLACE | Core | Blk | Server-side | #919 |
| `staging-gc` | REPLACE | M, Core | Blk | Member spool staging GC stays local (**M**); server-side blob staging GC is **Core** | #917 |
| `symbiont-detection` | REPLACE | MS | Blk | Continuous detection is the Member Service's job; absent in sandbox images | #917 |
| `managed-files-reconcile` | REPLACE | MS | Blk | Becomes Managed Asset Reconciliation across global assets and every registered Project | #917 |
| `self-reconcile` | REPLACE | MS | Blk | Folds into the one idempotent reconciliation path | #917 |
| `upgrade-auto-check` | REPLACE | MS | Blk | Member Service update check | #922 |
| `upgrade-adopt` | REPLACE | M, MS | Blk | Adopting a staged upgrade folds into `update` | #922 |
| `service-reconcile` | REPLACE | MS | Blk | Reconciles 1.4's platform service; becomes the Member Service's own lifecycle convergence | #917 |
| `capture-buffer-drain` | DROP | — | Blk | Capture is hook-invoked and write-ahead; the member drains its own spool with no scheduled job | #925 |
| `capture-only-notice-sweep` | DROP | — | Blk | Notices a degraded daemon-capture mode that no longer exists | #925 |
| `content-claim-expiry` | DROP | — | Blk | Content claims are a Team Host publication mechanism; retired with Team | #925 |
| `routed-transcript-cache-gc` | DROP | — | Blk | Routed capture is a Team Host mechanism; retired with Team | #925 |
| `routed-event-dedup-prune` | DROP | — | Blk | Routed capture is a Team Host mechanism; retired with Team | #925 |

### 7.6 Data classes — vault schema v76, `packages/myco/src/db/`

Disposition here is about the **data class**, and separately about **migration**: `MIGRATE` moves active Project data to the Deployment; `REBUILD` is derived data regenerated under the 2.0 schema; `DROP` does not migrate.

| Table | Disposition | Migration | Surface | Blk | Reason | Owner |
|---|---|---|---|---|---|---|
| `sessions` | KEEP | MIGRATE | Core | Blk | Core project intelligence | #924 |
| `prompt_batches` | KEEP | MIGRATE | Core | Blk | Already ingested by the 2.0 server | #924 |
| `session_myco_tool_calls` | KEEP | MIGRATE | Core | Blk | Tool-call history | #924 |
| `artifacts` | KEEP | MIGRATE | Core | Blk | Transcripts and responses | #924 |
| `attachments` | KEEP | MIGRATE | Core, W, C | Blk | Blob-backed; R2 on W, volume on C. Byte-lossless comparison is a #927 gate | #924 |
| `plans` | KEEP | MIGRATE | Core | Blk | | #924 |
| `spores` | KEEP | MIGRATE | Core | Blk | Server tables land in #919 | #924 |
| `resolution_events` | KEEP | MIGRATE | Core | Blk | Supersede/consolidate lineage | #924 |
| `spore_injections` | KEEP | REBUILD | Core | Blk | What the prompt hook was served, per (session, prompt); 1.4 carries it on `activities` | #1044 |
| `session_injections` | KEEP | REBUILD | Core | Blk | What a session was served once, per (session, kind); the plan nudge today. 1.4 carries it on `activities` | #1026 |
| `skill_records` | KEEP | MIGRATE | Core | Blk | | #924 |
| `skill_candidates` | KEEP | MIGRATE | Core | Blk | | #924 |
| `skill_lineage` | KEEP | MIGRATE | Core | Blk | | #924 |
| `skill_usage` | KEEP | MIGRATE | Core | Blk | | #924 |
| `digest_extracts` | KEEP | REBUILD | Core | Blk | Derived; regenerated under 2.0 | #924 |
| `digest_extract_revisions` | KEEP | REBUILD | Core | Blk | Derived | #924 |
| `cortex_instructions` | KEEP | REBUILD | Core | Blk | Derived | #924 |
| `canopy_maps` | KEEP | REBUILD | Core | Blk | Rebuilt by the new map task | #920 |
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
| `session_tombstones` | KEEP | MIGRATE | Core | Blk | Deletion records must survive migration | #924 |
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
| `okf_pages` | DROP | DROP | — | Blk | OKF was never proven against a consumer | #925 |
| `okf_page_revisions` | DROP | DROP | — | Blk | OKF | #925 |
| `okf_generations` | DROP | DROP | — | Blk | OKF | #925 |

### 7.7 Operational capabilities

Capabilities that are not a single registry token but must still carry a disposition and an owner.

| Capability | Disposition | Surface | Blk | Replacement / reason | Owner |
|---|---|---|---|---|---|
| Session, prompt, tool-call, response capture | KEEP | M, Core | Blk | Shipped; proven by the §8.4 parity run | shipped |
| Transcript capture and segmentation | KEEP | M, Core | Blk | Shipped | shipped |
| Attachment capture | KEEP | M, Core | Blk | Shipped | shipped |
| Plan capture from watched plan dirs | KEEP | M, Core | Blk | Shipped | shipped |
| Plan capture via `myco_plans` MCP | REPLACE | MCP, Core | Blk | MCP talks to the Deployment directly — the one §8.4 parity miss | #921 |
| Session lineage (parent/child detection) | KEEP | Core | Blk | Columns carried; populated by the member | shipped |
| Project admission policy (ignored/archived) | REPLACE | Core | Blk | Server-side `archived` Project state: refuses ingest with a named terminal refusal, hidden from default listings with explicit opt-in, all history and attribution preserved | #918 |
| Backup | REPLACE | Core, W, C | Blk | Volume snapshot on C; owner-triggered R2 export with lifecycle retention on W (D1's `db.dump()` is alpha-only, so W iterates and streams) | #923 |
| Restore | REPLACE | W, C | Blk | Break-glass Operator procedure via `myco server restore` on both targets — never a dashboard button | #923 |
| Diagnostic export bundle | REPLACE | M, Core | Blk | Local shape from **M**; server-side export from **Core** | #922 |
| Project movement between Deployments | KEEP | Core | Blk | Project identity and history survive movement | #923 |
| Project Reassignment | REPLACE | Core | Blk | Server-side correction of duplicate Project identities | #923 |
| Symbiont detection and hook installation | REPLACE | MS | Blk | Continuous on developer machines; absent in sandbox images | #917 |
| Managed Asset Reconciliation | REPLACE | MS | Blk | One idempotent path over global assets and every registered Project | #917 |
| Recall injection (`UserPromptSubmit`) | REPLACE | Core | Blk | Served by `POST /context/prompt`: the plan nudge and the session's unseen spores, answered after the prompt is spooled — ≤ 10 000 chars cut at a part boundary, < 2 s p95 | #921 |
| External read-only MCP for cloud agents | REPLACE | MCP, Core | Blk | Project-scoped read-only Access Grant; new in 2.0, replacing "no such capability" | #921 |
| HTTPS / trusted-proxy contract | REPLACE | W, C | Blk | Platform TLS on W; documented proxy contract on C | #909 |
| Update reliability | KEEP | M, MS | Blk | | #922 |
| Server logs / observability | REPLACE | Core, UI | Blk | From the telemetry the server already emits; `wrangler tail` remains the W operator view | #922 |
| Native Cloudflare intelligence provider | REPLACE | W | — | **Non-blocking follow-up** — the Intelligence Provider contract is provider-agnostic | #928 |

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

**Capability master gates are fail-closed and that is a mechanism, not a default.** Today `skills.enabled`, `vault_evolution.enabled`, `cortex.enabled` and `cortex.canopy.enabled` all default **`true`** in the schema, and `capabilityEnabled` returns `defaultEnabled ?? true` for an absent path (`config/capabilities.ts`). What actually makes a new project capture-only is a *write at provision time* — `reseedCaptureOnly()` seeding `false` for every gate (`vault/provision.ts`). On a Deployment, where Projects appear from a member's first write with no ceremony, the server-side predicate must therefore be the **inverse**: an absent row reads **disabled**. Otherwise every new Project silently acquires every cost-bearing capability, which is the auto-adoption #428 exists to prevent.

Four blocks hold dynamic children the schema cannot enumerate — `agent.tasks`, `notifications.domains`, `symbionts` and `release_provenance.package_map`. They are classified whole, as their own rows below, and the completeness gate collapses any leaf beneath them onto the block prefix.

| Leaf | Disposition | Tier | Surface | Reason | Owner |
|---|---|---|---|---|---|
| `version` | DROP | — | — | Schema version marker, not a setting | #925 |
| `config_version` | DROP | — | — | Migration mechanism, not a setting | #925 |
| `embedding.provider` | REPLACE | Deployment | Core | Which provider the Deployment embeds with | #915 |
| `embedding.model` | REPLACE | Deployment | Core | Model the Deployment embeds with | #915 |
| `embedding.prevent_deep_sleep` | REPLACE | Deployment | Core | Wake policy for the embedding job; a Deployment-side scheduling concern | #915 |
| `daemon.log_level` | KEEP | Member | MS | The Member Service's own log verbosity on this machine | #915 |
| `daemon.log_retention_days` | KEEP | Member | MS | Local log retention on this machine | #915 |
| `daemon.stale_session_threshold_ms` | KEEP | Member | MS | Local session-liveness heuristic for capture on this machine | #915 |
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
| `agent.harness` | REPLACE | Deployment | Core | Which harness the Deployment runs tasks under | #919 |
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
| `embedding.base_url` | REPLACE | Deployment | Core | Where embeddings are computed | #915 |
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
| `skills.enabled` | REPLACE | Project | Core | Capability master gate; per-Project admission, fail-closed when absent | #915 |
| `skills.confidence_threshold` | REPLACE | Deployment | Core | Advanced setting governed by the skills capability | #915 |
| `skills.usage_stale_days` | REPLACE | Deployment | Core | Advanced setting governed by the skills capability | #915 |
| `vault_evolution.enabled` | REPLACE | Project | Core | Capability master gate; per-Project admission, fail-closed when absent | #915 |
| `notifications.enabled` | KEEP | Member | M | Per-viewer delivery preference | #915 |
| `notifications.system_notifications` | KEEP | Member | M | Per-viewer OS notification preference | #915 |
| `notifications.default_mode` | KEEP | Member | M | Per-viewer delivery preference | #915 |
| `notifications.retention_days` | REPLACE | Deployment | Core | Prune window for Deployment-held notification records; no member owns it | #915 |
| `cortex.enabled` | REPLACE | Project | Core | Capability master gate; per-Project admission, fail-closed when absent | #915 |
| `cortex.instructions.inject_on_session_start` | REPLACE | Deployment | Core | Injection policy the Deployment applies | #919 |
| `cortex.instructions.inject_on_subagent_start` | REPLACE | Deployment | Core | Injection policy the Deployment applies | #919 |
| `cortex.digest.tier` | REPLACE | Deployment | Core | Digest size the Deployment generates | #919 |
| `cortex.digest.inject_on_session_start` | REPLACE | Deployment | Core | Injection policy the Deployment applies | #919 |
| `cortex.spores.inject_on_prompt_submit` | REPLACE | Deployment | Core | Applied by the Deployment on `POST /context/prompt` | #1026 |
| `cortex.spores.max_per_prompt` | REPLACE | Deployment | Core | Applied by the Deployment on `POST /context/prompt`, clamped to 0..10 | #1026 |
| `cortex.plans.inject_intent_nudge_on_prompt_submit` | REPLACE | Deployment | Core | Applied by the Deployment on `POST /context/prompt`, once per session | #1026 |
| `cortex.canopy.enabled` | REPLACE | Project | Core | Capability master gate; per-Project admission, fail-closed when absent | #915 |
| `cortex.canopy.refresh.background_enabled` | REPLACE | Deployment | Core | Deployment-side map refresh policy | #920 |
| `cortex.canopy.refresh.background_period_minutes` | REPLACE | Deployment | Core | Deployment-side map refresh schedule | #920 |
| `cortex.canopy.exclude.default_patterns` | REPLACE | Deployment | Core | Map scan exclusion applied Deployment-side | #920 |
| `cortex.canopy.exclude.patterns` | REPLACE | Deployment | Core | Map scan exclusion applied Deployment-side | #920 |
| `cortex.canopy.min_file_bytes` | REPLACE | Deployment | Core | Map scan threshold applied Deployment-side | #920 |
| `cortex.canopy.inject_on_pre_tool_use` | KEEP | Member | M | Decides whether THIS machine's hook injects; a member-side behaviour | #920 |
| `appearance.theme` | KEEP | Member | M | Per-viewer dashboard theme | #918 |
| `appearance.mode` | KEEP | Member | M | Per-viewer light/dark; Deployment-wide would flip every member's dashboard | #918 |
| `appearance.font` | KEEP | Member | M | Per-viewer dashboard typography | #918 |
| `appearance.density` | KEEP | Member | M | Per-viewer dashboard density | #918 |

**Project-tier `release_provenance.*` has no store yet, and that is a deferral rather than an oversight.** Step 6 builds `project_capabilities`, keyed on the four capability ids, and nothing else per Project — so the eight repo-specific `release_provenance` leaves are classified but not writable, and `setLeaf` refuses them. They are per-repository settings for a feature (#922 owns release provenance) whose per-Project store lands with the surface that configures it. The same rule as the two blocks below: a tier without a mechanism is recorded as such rather than assigned quietly.

Two further blocks are **not settled here**, and are marked so rather than assigned silently. `backup.*` describes Deployment backup policy but leads with a filesystem path that has no meaning on a Worker; #923 owns backup/restore and owns the per-target mechanism with it. `maintenance.*` is `PRAGMA optimize` and SQLite integrity checking, neither of which exists on D1 — a capability row without a per-target mechanism is how one target quietly loses a feature (§3.3), so it belongs with the self-hosted work in #913.

## 8. Release blockers and non-blocking follow-ups

Every row in §7 is `Blk` except one: **#928** (native Cloudflare intelligence-provider integration), which #905 records as explicitly non-blocking.

The release gate is **#927**. `myco/v2.0.0` publishes only after every release-scoped child #906–#926 is closed with merged, current evidence and #927's full matrix is satisfied on **both** targets.

## 9. The gate

A ledger with no gate goes stale the first time someone adds a CLI command.

`tests/meta/feature-ledger-completeness.test.ts` statically scans the six registries — CLI dispatch in `packages/myco/src/cli.ts`, routes in `packages/myco/ui/src/App.tsx`, `TOOL_*` constants in `packages/myco/src/tools/definitions.ts`, task YAML filenames, `POWER_JOB_NAMES` values, and `CREATE TABLE` names under `packages/myco/src/db/` — and asserts that **every token appears in a §7 table with both a disposition and an owning surface**, failing by name when either is missing.

The surface half is the one that matters most: a row with a disposition but no surface is how a capability ends up owned by nobody. That is the defect this whole ledger exists to answer.
