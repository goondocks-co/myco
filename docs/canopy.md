# Canopy

**Your agents stop reading every file blind.** Canopy keeps a fresh index of what's in your project — the exports, the imports, the top comment — and hands the agent that anatomy *before* it opens a file. The agent decides whether the full read is still worth it. Most of the time, it isn't.

Token-spend on speculative reads is one of the largest invisible costs in agent work. Canopy makes that cost visible and, more importantly, gives the agent the information it needs to choose differently.

## What you see

**Session detail — Canopy efficiency tile.** A new tile shows the net tokens Canopy saved during the session: how many files the agent could have re-read, how many it skipped after seeing the anatomy, and the tokens that would have flowed through the model otherwise.

**Tool-call rows — injection indicator.** Each Read tool call that received a Canopy injection shows a small badge with the injection cost. Click it to see the exact anatomy blob the agent saw at that moment — verbatim, no summarization. Full transparency.

**Session list — lifetime rollup.** A rollup tile across all sessions shows total tokens saved, average per session, and how often the agent chose to skip after injection.

**Cortex tab — your Canopy command deck.** The dashboard's Cortex tab gives you three views over the same index: an **Overview** with status and savings, an **Entries** browser (sortable, free-text searchable, with a slide-out detail panel and a one-click **Re-describe** for any file), and the **Map** sub-panel that holds the project's architectural overview. Refresh and Rebuild buttons are right there when you want to push the index forward.

The tiles hide themselves on sessions where Canopy wasn't active or the project hadn't been scanned yet — there's no "N/A" placeholder.

## What it knows

Canopy keeps an anatomy entry per file in your project:

- File size, line count, language
- Top-level exports (functions, classes, types, re-exports)
- Imported module names
- The leading docstring or top comment

This is **mechanical** — no LLM is involved. A scan of a typical project finishes in under a second; rescans run in milliseconds because only changed files are re-parsed.

The index updates in three ways:

1. **On agent edits.** When the agent writes or edits a file, that file is rescanned immediately so the next Read sees the current anatomy.
2. **On session start.** A delta scan runs in the background to catch changes made outside the agent (your editor, `git pull`, a teammate's branch).
3. **On a schedule.** A background rescan runs hourly by default so even quiet projects stay current.

## When Canopy injects

Canopy intervenes only on agent **Read** tool calls — never on edits, runs, or other tool work. It also stays out of the way when:

- The Read is targeted (the agent specified a line range — it already knows what it wants)
- The file is small (below 800 bytes by default — the anatomy is no cheaper than just reading)
- The agent isn't running under a symbiont that supports injected context
- Cortex has injection turned off for this scope

When all four conditions clear, Canopy sends the agent a few hundred tokens of anatomy. The agent then chooses: skip the full read because the summary already answers, or read anyway because it needs the body. Either choice is right — Canopy just makes it informed.

## Optional Tier 2 — LLM descriptions

The mechanical anatomy already answers most questions ("what does this file export?"). For richer one-line summaries ("this file orchestrates the auth flow during session resume"), Canopy can run an opt-in LLM pass over each file and store the description alongside the mechanical entry. The next injection then includes that one-sentence summary in addition to the exports list.

This is **off by default**. Enable it under Cortex → Canopy when you want it. Choose your reasoning tier (low / medium / high) and how many characters a description can be. Cheap models work well — the input is fixed and small, and the output is one sentence.

Descriptions stay fresh automatically: when a file changes, its description is regenerated next time the task runs.

## Project map — orient on demand

Beyond the per-file anatomy, Canopy synthesizes a single-page **project map**: a directory skeleton plus 4–8 domain clusters of representative files, each annotated with what it does. The map is the answer to "what is this project, and where do things live?" — the orientation a new contributor would get on day one.

Agents pull it via `myco_cortex` op `"canopy_map"`. One call returns the whole map (1.5K–3K tokens of markdown), letting an unfamiliar agent skip a half-dozen `Glob` and `Grep` calls before it even knows where to look. You see and refresh it from **Cortex → Canopy → Map**.

The map refreshes itself when the underlying file descriptions drift — and short-circuits silently when nothing has changed, so it costs nothing to keep on. Use **Rebuild** in the Map sub-panel to regenerate from scratch when you want a fully fresh take.

## Search by behavior, not keyword

Once LLM descriptions are on, every described file is also embedded for semantic search. Agents call `myco_search` with `type=canopy` to find files by what they *do*: "where does session capture happen?" returns the right file even if the words "session capture" appear nowhere in it.

The same results show up in the Cortex Operations page and as a **Canopy** facet in the dashboard's universal search — the agent's view and your view are the same view.

## Configuration

Everything is configurable at the project, machine, or organization scope through the Cortex settings page:

- **Collection** — which patterns to skip (`node_modules`, `.git`, build outputs, lockfiles by default), how often the background rescan runs
- **Injection** — turn it on or off, the size threshold below which anatomy is more expensive than the read itself
- **LLM descriptions** — enabled flag, reasoning tier, max description length, retry budget

Sensible defaults ship out of the box. Most projects never need to touch these.

## What Canopy is not

Canopy is **code intelligence, not a token-budget tool.** The token savings are an outcome, not the mission — the mission is teaching agents about your codebase so they navigate it like someone who's worked there for a while.

Canopy does **not**:

- Block tool calls when something fails — every failure path returns nothing and the agent proceeds normally
- Synchronize across machines — the index is per-project-per-machine, regenerated cheaply on each one
- Expand into a corrections layer — wrong injections don't get patched up; the agent sees what was scanned and chooses
- Run an LLM in the Read hot path — the LLM pass is a separate background task, only its output is read at injection time
