# Migrating from OAK to Myco

Myco is a new, independent project originally inspired by ideas explored in [OAK](https://github.com/goondocks-co/open-agent-kit). The two share no code, but if you used OAK on a project, your captured history is valuable — and Myco can take it as a seed.

This guide covers the one-time import: pull your OAK history into a Myco vault so Myco can build on top of it from day one.

> **Note:** the import is one-way and partial by design. It carries forward the parts of your OAK history that translate cleanly to Myco's model, and lets Myco's own intelligence pipeline regenerate everything else from scratch.

---

## What you'll need

- A project that has either:
  - A live OAK install with `<project>/.oak/ci/activities.db`, **or**
  - At least one OAK backup file under `<project>/oak/history/<machine-id>.sql`.
- Myco installed and running. The global install (`npm install -g @goondocks/myco` or the install script) is sufficient — the daemon auto-registers projects into your default Grove the first time an agent fires a hook. If you want the import to land in a project-local vault rather than the Grove's database, opt in explicitly with `myco init --project <path>` in that project first.

You don't need to remove OAK before running the import. OAK and Myco coexist — they each manage their own hooks, MCP servers, and configuration, and neither touches the other's. You can clean up OAK whenever you like (see "Cleaning up OAK" below).

---

## What gets imported

Myco brings forward the parts of OAK that map cleanly onto its own model:

- **Sessions** — every OAK session becomes a Myco session, with the original session id, agent, project root, timestamps, and parent-session lineage preserved.
- **Session summaries and titles** — the LLM-generated summary and title from each OAK session are kept verbatim. These are the one piece of OAK-generated intelligence you keep; Myco re-embeds them into its search index.
- **Prompts** — every prompt batch is preserved: the user prompt, the response summary, classification, timing, and the parent-prompt link.
- **Tool-call history** — every activity OAK recorded (tool name, input, output summary, files touched, timing, errors) is imported into Myco's `activities` table.

Imported sessions, prompts, and activities are flagged as **unprocessed** so Myco's Vault Evolve task treats them as fresh raw material and generates Myco-quality spores from them.

## What does NOT get imported

- **OAK memory observations** — these were OAK's already-extracted insights. Their quality bar is below Myco's; importing them would create cleanup work for Vault Evolve. Myco regenerates better spores from the raw history instead.
- **OAK embeddings** (`chroma.sqlite3`) — Myco uses its own embedding pipeline; everything that needs embeddings gets re-embedded after import.
- **OAK-internal data** — agent run logs, scheduler state, governance audit, team-sync state. None of this maps onto Myco.
- **OAK Agents and Skills definitions** — Myco's agent and skill systems are different. You'll set those up fresh.

---

## Running the import

The migration script lives in the Myco repo. You don't need to clone it — fetch it directly with `curl` and run it with [Bun](https://bun.sh) (which Myco uses internally and is already on your machine once Myco is installed).

### Step 1 — Download the script

```bash
curl -fsSL \
  https://raw.githubusercontent.com/goondocks-co/myco/main/scripts/migrate-from-oak-to-myco.ts \
  -o /tmp/migrate-from-oak-to-myco.ts
```

### Step 2 — Run it

The script picks its source automatically:

1. If `<project>/.oak/ci/activities.db` exists, it's used directly.
2. Otherwise, the most recent `*.sql` backup in `<project>/oak/history/` is loaded into a temporary SQLite database and used as the source.
3. You can override either with `--source <path>` (live SQLite DB) or `--backup <path>` (SQL file).

```bash
# Auto-detect source — run from inside your project
bun /tmp/migrate-from-oak-to-myco.ts --target ./.myco/myco.db

# Explicit live database
bun /tmp/migrate-from-oak-to-myco.ts \
  --source ./.oak/ci/activities.db \
  --target ./.myco/myco.db

# Explicit backup file
bun /tmp/migrate-from-oak-to-myco.ts \
  --backup ./oak/history/<machine-id>.sql \
  --target ./.myco/myco.db
```

A `--dry-run` flag is available to preview row counts without writing.

The import is **idempotent** — running it twice on the same source produces zero new rows the second time. Safe to re-run if interrupted.

When you're done, delete `/tmp/migrate-from-oak-to-myco.ts`.

---

## Why backups are a first-class source

OAK preserves backups under `oak/history/` (not the `.oak/` directory) and most projects commit this folder to git. That means:

- Backups survive `oak remove` — `oak remove` only deletes `.oak/` and OAK's agent integrations.
- Backups survive a fresh clone — a teammate cloning the repo can run the migration even on a machine that never had OAK installed.
- If you've already removed OAK from a project, you can still migrate from the backup file in git history.

The migration script accepts SQL backups directly, so you don't need OAK installed to import.

---

## What Myco does after the import

Once the import finishes, Myco picks up the new content automatically:

1. **Vault Evolve** runs against the imported sessions, prompts, and tool-call history and generates fresh spores at Myco quality.
2. **Embeddings** for the imported session summaries and titles are generated by Myco's embed task on its next run.
3. **Search and entity retrieval** start surfacing your OAK history through Myco's tools (`myco_search`, `myco_sessions`, `myco_spores`, `myco_plans`, etc.) as soon as the embeddings land.

You don't need to trigger any of this manually — it happens on Myco's normal schedule. If you want to force it, the relevant tasks are runnable from the Myco UI.

---

## Migration log

Every import run writes an entry to `oak_import_log.json` in the same directory as the target Myco vault DB. The log records:

- When the import ran.
- Which source was used (live DB or which backup file).
- Row counts read from OAK and inserted into Myco for sessions, prompts, and activities.
- The agent-name translation table used (e.g. OAK's `claude-code` → Myco's `claude-code`).
- Any agent names that didn't match Myco's known symbionts.
- Warnings and errors.

Re-running the import appends a new entry to the same log file.

---

## Cleaning up OAK

After the import succeeds, you can remove OAK at your leisure:

```bash
oak remove
```

This removes OAK's hooks, MCP server registrations, skills, and the `.oak/` configuration directory. It preserves `oak/` (constitution, RFCs, plans, history backups). It does **not** touch anything Myco-managed.

You can leave OAK installed if you want — Myco doesn't conflict with it — but most users will want a clean Myco-only setup once the migration is verified.

---

## Troubleshooting

**The import says zero rows were inserted.**
This is expected on a re-run — the import is idempotent. If it's the first run, check that the source database or backup file contains data.

**`UNIQUE constraint failed` errors.**
Usually means a previous run partially completed. Re-run the import — the idempotency guards skip already-imported rows. If it persists, check `oak_import_log.json` for warnings and inspect the failing row.

**No source found.**
The script couldn't find `.oak/ci/activities.db` or any `*.sql` file in `oak/history/`. Pass `--source` or `--backup` explicitly.

**An OAK agent name didn't translate.**
Check the `unmapped_agents` field in the log. The session was imported with the OAK name passed through verbatim. If you want it under a Myco symbiont name, update the row manually with SQL or wait for a future script update.

**Imported sessions don't appear in search results.**
Search uses embeddings, which run on a schedule. Wait for the next embed task or run it manually from the Myco UI.

**I don't see any spores generated from the imported content.**
Vault Evolve runs on a schedule. Trigger it manually from the Myco UI to generate spores immediately. Imported sessions and prompts are flagged unprocessed so Vault Evolve will pick them up.

**I want to undo the import.**
The cleanest path is to restore your Myco vault DB from a backup taken before the import. There's no first-class "uninstall" — the imported rows look like normal Myco rows once they're written.

---

## Doing it twice (multiple OAK projects)

Each OAK project has its own activity database and backup directory. Run the import once per project, against the corresponding Myco vault. Don't mix multiple OAK databases into a single Myco vault — sessions in different projects share id space and may collide.
