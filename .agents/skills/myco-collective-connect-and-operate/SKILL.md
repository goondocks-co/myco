---
name: myco:myco-collective-connect-and-operate
description: |
  Use this skill when bootstrapping a Myco Collective instance, connecting an
  existing project to a live Collective, managing admin token lifecycle,
  verifying Collective health and identity, using collective_* MCP tools,
  setting up the local dev proxy (make collective-ui-dev), enforcing design
  system compliance for Collective UI, or running the V1 integration gate
  checklist. Covers: CLI bootstrap, project connection and config scoping
  (home-scoped ~/.myco-collective/<name>/ vs project-scoped .myco/team/),
  admin token rotation across team workers, the deploy → upgrade → verify
  cycle, collective_* vs org_* MCP tool distinctions, Vite proxy setup, and
  integration gate. Activate even if the user only asks to "connect to
  Collective" or "check Collective status" without mentioning the full
  workflow.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Myco Collective: Connect, Verify, and Operate

Myco Collective is the org-level intelligence layer: a Cloudflare Worker + D1
+ Vectorize + KV deployment that federates knowledge across multiple projects
and machines. This skill covers operational procedures after infrastructure is
deployed — connecting projects, managing tokens, verifying correctness, using
MCP tools, and maintaining the Collective UI design system. For Worker
deployment mechanics (Wrangler, KV provisioning, wrangler.toml), see
`cloudflare-worker-infrastructure-lifecycle`.

## Prerequisites

- A running Collective Worker (deployed via `myco collective create` or manual
  Wrangler deploy)
- `myco` CLI installed and at least one project initialized with `myco init`
- Admin token available from `~/.myco-collective/<name>/config.json`
- Node 18+ and `make` available for local dev proxy work

---

## Procedure 1: Bootstrap a New Collective (CLI Only)

Collective bootstrap is **CLI-only** — the same pattern as `myco init` and
`myco team deploy`. Do NOT attempt to bootstrap from the daemon UI.

```bash
myco collective create <name>
```

This creates:
- A Cloudflare Worker named after `<name>`
- D1 database, Vectorize index, and KV namespace
- Home-scoped config at `~/.myco-collective/<name>/config.json`

After bootstrap, always run the verification protocol (Procedure 4) before
connecting any projects. A Worker that returns the wrong `collective_name`
needs an upgrade before use.

---

## Procedure 2: Connect a Project to a Collective

Each project that joins a Collective gets its own connection entry. Config
splits across two scopes — understanding this boundary prevents the most
common operational mistakes:

| Scope        | Location                                      | Contains                                      |
|--------------|-----------------------------------------------|-----------------------------------------------|
| Home (machine-wide) | `~/.myco-collective/<name>/config.json` | Worker URL, admin token, operator settings   |
| Project      | `.myco/team/config.json`                      | Project-specific Collective reference         |

**Steps:**

1. Confirm the Collective Worker URL and token from the home-scoped config:
   ```json
   {
     "workerUrl": "https://my-collective.workers.dev",
     "adminToken": "<token>"
   }
   ```

2. Connect the project:
   ```bash
   myco collective connect <name>
   ```
   This writes `.myco/team/config.json` with the Collective reference.

3. Verify the connection responds correctly (see Procedure 4).

**Config scoping invariant**: `myco.yaml` holds static project config only.
Collective operator config (Worker URL, admin token) is home-scoped and
machine-wide. `.myco/secrets.env` is for project-scoped API keys only — admin
tokens do NOT belong there.

---

## Procedure 3: Admin Token Lifecycle

Admin tokens authenticate Collective API calls. They live at the home-scoped
config, not in any project file.

**Canonical token location:**
```
~/.myco-collective/<name>/config.json
```

**Not** `.myco/secrets.env` — that file is reserved for project-scoped keys.

### Rotating a Token

1. Generate a new token via the Collective admin UI or API.
2. Update `~/.myco-collective/<name>/config.json` on **every machine** that
   uses this Collective.
3. Check `.myco/secrets.env` for a stale `MYCO_COLLECTIVE_TOKEN` entry — this
   leftover survives the home-scoped refactor and shadows the correct value.
   Remove it if present.
4. Confirm each team Worker's KV binding has been updated. Stale tokens in KV
   bindings fail silently with 401.
5. Verify the rotation succeeded: `myco collective status`

### Token Format Gotcha

The UI token input expects the **plain token value** — no `Bearer ` prefix.
Pasting `Bearer <token>` makes the reveal state appear correct but all API
calls will return 401. Strip the prefix before saving.

---

## Procedure 4: Verification Protocol

Run this sequence after every deploy, upgrade, or token change. Order matters —
verify after upgrading, not before.

```bash
# Step 1: CLI health check
myco collective status

# Step 2: HTTP health endpoint
curl https://<worker-url>/health

# Step 3: Identity verification (critical)
curl -H "Authorization: Bearer <token>" \
  https://<worker-url>/api/auth/verify
```

The `/api/auth/verify` response must include a deployment-specific name:

```json
{ "collective_name": "OSS Collective" }
```

If `collective_name` returns the generic `"Myco Collective"`, the Worker is
running with default branding. The `COLLECTIVE_NAME` environment variable was
not set, or the Worker predates the branding feature and needs an upgrade:

```bash
# Upgrade cycle
wrangler deploy
wrangler secret put COLLECTIVE_NAME   # enter "OSS Collective" (or your name)

# Re-verify — must see deployment-specific name
curl -H "Authorization: Bearer <token>" https://<worker-url>/api/auth/verify
```

**Deploy → upgrade → verify** is the required cycle. Running verify before
the upgrade gives stale results from the cached Worker bundle.

---

## Procedure 5: Using collective_* and org_* MCP Tools

The Collective exposes two tiers of MCP tools. Confusing the tiers is a
common source of "where are my tools?" debugging sessions:

| Tier           | Tool prefix   | Accessed via                                     |
|----------------|---------------|--------------------------------------------------|
| Project-local  | `collective_*`| The LOCAL MCP server (same as all project tools) |
| Cloud org-level| `org_*`       | Dedicated cloud-facing Collective MCP endpoint   |

**`collective_*` tools** appear when the project is Collective-connected. You
do NOT need a separate cloud connection — they proxy through the local daemon.
If they are missing, the project is not connected: check `.myco/team/config.json`.

**`org_*` tools** live on the dedicated Collective MCP endpoint for
cross-project org operations. The endpoint URL and a copy-ready Claude agent
configuration snippet are on the **Settings → MCP** page in the Collective UI.
This is the primary Collective feature surface — do not look for it in the
main dashboard widget.

---

## Procedure 6: Local Dev Proxy Setup

When developing Collective UI locally, always use the `make collective-ui-dev`
target rather than pointing Vite directly at a local Wrangler instance.

```bash
make collective-ui-dev
```

This starts Vite with a proxy to the **live** Cloudflare Worker. Rationale:
the live Worker has real data and established auth; local Wrangler has neither.

**Config resolution:**
1. Reads Worker URL from `~/.myco-collective/<name>/config.json` (defaults to
   the `oss` named config if no name is set)
2. Override with `COLLECTIVE_UI_PROXY_TARGET` for local Wrangler testing:
   ```bash
   COLLECTIVE_UI_PROXY_TARGET=http://127.0.0.1:8787 make collective-ui-dev
   ```

Use the override only when explicitly testing unreleased Worker changes against
a `wrangler dev` session. For all other UI development, default to the live
Worker so you work against real data.

---

## Procedure 7: Design System Compliance for Collective UI

The Collective UI is **not** a separate editorial product. It shares the daemon
design system exactly. Two documented drift incidents have occurred; treat
canary signals as blockers, not cosmetic issues.

**Required tokens and patterns:**
- CSS tokens: sage, ochre, terracotta (from daemon design system)
- App shell: solid structural sidebar — same grammar as the Team UI
- Type scale: dense, not editorial (no large base font)

**Canary signals that drift has occurred:**
- Brown or warm palette replacing sage/ochre/terracotta
- Bubble-bordered or pill-shaped navigation
- Large base font (editorial/marketing style)
- Layout that diverges from the daemon app shell

**Correction approach:** replace palette with charcoal and green accents; adopt
the solid structural sidebar from Team UI; tighten type scale for density.
Do not accumulate further drift once a canary signal appears — course-correct
in the same PR.

---

## Procedure 8: V1 Integration Gate Checklist

Before promoting the Collective to production team use, verify all integration
points. This is the Teams Gate (decision `a317226c`).

- [ ] **Machine ID keying** — D1 and Vectorize records are keyed by machine
      ID; confirm no cross-project data contamination in query results
- [ ] **Federation scope** — write from Project A, confirm the record is NOT
      visible in Project B's query results
- [ ] **Cross-machine visibility** — Machine A writes a record → Machine B
      reads it via MCP (the core value proposition of the Collective)
- [ ] **Backup/restore bootstrap** — new team member runs `myco restore` →
      Collective connection re-established without manual config steps
- [ ] **Token round-trip** — rotate admin token → propagate to all Workers →
      confirm all API calls succeed
- [ ] **MCP endpoint reachability** — `org_*` tools surface correctly on the
      dedicated MCP Settings page in the Collective UI

Do not mark the Collective production-ready until all items pass.

---

## Cross-Cutting Gotchas

**Stale token in `.myco/secrets.env`**: After the home-scoped config refactor,
`.myco/secrets.env` may still hold a `MYCO_COLLECTIVE_TOKEN` entry. Current
code ignores it, but it causes confusion during debugging. Remove it.

**`Bearer` prefix breaks auth silently**: The token input field in Collective
UI settings expects the raw token — no `Bearer ` prefix. The field will show
the value as valid but every API call will 401.

**`collective_*` tools require no separate cloud connection**: They appear
automatically when `.myco/team/config.json` exists and the project is
connected. Missing tools almost always mean a disconnected project, not a
cloud MCP issue.

**Always verify after upgrading, not before**: Running `/api/auth/verify`
against an unupgraded Worker returns stale identity. The deploy → upgrade →
verify sequence is mandatory.

**`myco doctor` after connection**: Installation audits have surfaced redundant
UI package entries post-connect. Run `myco doctor` after connecting a project
to a Collective to catch installation anomalies before they cause silent
failures downstream.
