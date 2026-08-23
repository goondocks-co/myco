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

**Membership is flat in the initial release:** every joined member has equal full application access across the Deployment. A narrow step-up credential may protect sensitive infrastructure administration without creating a role hierarchy.

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
| Harness | Cloudflare container infrastructure (**pending #908**) | Same harness image |
| Durable storage | Platform-managed | Mounted volume under Compose |

Shared behavior belongs in the common core; target-specific infrastructure, storage, wake, TLS/proxy, backup, and observability behavior belongs in adapters. **Neither target may silently lose a feature because the other implemented it first.** A ledger row naming a capability without its per-target mechanism is how one target never gets it.

Cloudflare is the primary real dogfood Deployment; self-hosted Compose receives equal release proof (#927).

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
| **Server operation** | — | — | — | `myco server update\|inspect\|rotate\|backup\|adopt\|restore\|remove` (**W**/**C**) | — |
| **Enrollment** | Join with Enrollment Authority → Member Credential (**Core**) | — | — | Issues Enrollment Authority (**Core**) | Receives project-scoped read-only grant (**Core**) |
| **Capture** | — | Hooks write-ahead to spool, drain to Deployment (**M** → **Core**) | — | — | none |
| **Intelligence** | Views results (**UI**) | Reads via MCP (**MCP**) | Runs tasks in the harness container (**Core** + **W**/**C**) | — | none |
| **Recall** | — | `UserPromptSubmit` recall endpoint (**Core**) | — | — | Read-only project MCP (**MCP**) |
| **Admin** | Deployment Settings, enrollment, external grants — all members, flat (**UI**, **Core**) | — | — | Step-up credential for sensitive infrastructure (**Core**) | none |
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
| `myco_spores` | KEEP | MCP, Core | Blk | Needs the server-side spores tables | #919 |
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
| `title-summary` | KEEP | Core | Blk | | #919 |
| `review-session` | KEEP | Core | Blk | | #919 |
| `vault-evolve` | KEEP | Core | Blk | | #919 |
| `supersession-sweep` | KEEP | Core | Blk | | #919 |
| `vault-seed` | KEEP | Core | Blk | | #919 |
| `canopy-map` | REPLACE | Core | Blk | Grows a scan/diff phase using normal harness code-exploration tools and content hashes; maintains the map as a living document. **Gated on #910's accepted content prototype** | #920 |
| `canopy-describe` | DROP | — | Blk | Per-file fan-out and entry embeddings retire. **Named cost:** semantic Canopy search ends and `canopy_entry` returns mechanical fields only | #920 |
| `harness-health` | DROP | — | Blk | Inspects a local harness — a machine question. Its checks move into `doctor` (**M**) | #917 |

### 7.5 Scheduled jobs — `packages/myco/src/constants/power-jobs.ts`

PowerManager keeps its policy; **waking is platform-specific** (Durable Object alarm + cron on W, in-process scheduler on C).

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
| Recall injection (`UserPromptSubmit`) | REPLACE | Core | Blk | Server endpoint, < 2 s p95, ≤ 10 000 chars | #921 |
| External read-only MCP for cloud agents | REPLACE | MCP, Core | Blk | Project-scoped read-only Access Grant; new in 2.0, replacing "no such capability" | #921 |
| HTTPS / trusted-proxy contract | REPLACE | W, C | Blk | Platform TLS on W; documented proxy contract on C | #909 |
| Update reliability | KEEP | M, MS | Blk | | #922 |
| Server logs / observability | REPLACE | Core, UI | Blk | From the telemetry the server already emits; `wrangler tail` remains the W operator view | #922 |
| Native Cloudflare intelligence provider | REPLACE | W | — | **Non-blocking follow-up** — the Intelligence Provider contract is provider-agnostic | #928 |

## 8. Release blockers and non-blocking follow-ups

Every row in §7 is `Blk` except one: **#928** (native Cloudflare intelligence-provider integration), which #905 records as explicitly non-blocking.

The release gate is **#927**. `myco/v2.0.0` publishes only after every release-scoped child #906–#926 is closed with merged, current evidence and #927's full matrix is satisfied on **both** targets.

## 9. The gate

A ledger with no gate goes stale the first time someone adds a CLI command.

`tests/meta/feature-ledger-completeness.test.ts` statically scans the six registries — CLI dispatch in `packages/myco/src/cli.ts`, routes in `packages/myco/ui/src/App.tsx`, `TOOL_*` constants in `packages/myco/src/tools/definitions.ts`, task YAML filenames, `POWER_JOB_NAMES` values, and `CREATE TABLE` names under `packages/myco/src/db/` — and asserts that **every token appears in a §7 table with both a disposition and an owning surface**, failing by name when either is missing.

The surface half is the one that matters most: a row with a disposition but no surface is how a capability ends up owned by nobody. That is the defect this whole ledger exists to answer.
