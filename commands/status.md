---
name: myco-status
description: Show Myco vault health, stats, and any pending issues
---

# Myco Status

Check and report:

1. **Vault health** — does `.myco/` exist with expected structure?
2. **Index status** — is `index.db` present? How many notes indexed?
3. **Pending buffers** — any unprocessed event buffers? (indicates LLM backend was unavailable)
4. **Intelligence backend** — is the configured LLM backend reachable?
5. **Stats** — total sessions, plans, memories, team members
6. **Recent activity** — last 3 sessions with summaries

Read the config from `.myco/myco.yaml` and query the index to build this report.
