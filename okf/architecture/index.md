# Architecture

* [Runtime & Daemon Authority](runtime-and-daemon.md) - Why the background daemon, not Claude Code hooks, is the single authority for Myco's capture, storage, and scheduled intelligence work — and the home/power/database boundaries that make that authority safe.
* [Session Capture Flow](session-capture-flow.md) - How a symbiont's hook events become durable prompt_batches and activities rows: hooks/client.ts's buffered-fallback contract, the Stop pipeline in daemon/stop-processing.ts, transcript mining in capture/transcript-miner.ts, and placeholder-title backfill in daemon/session-reenrich.ts.
