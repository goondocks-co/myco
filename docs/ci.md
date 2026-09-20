# Pull request checks

The CI workflow runs lint, the native build, four Node test shards, two DOM test
shards, three parity shards, container checks, and Windows contracts independently.
The `check` job requires every job to succeed, including every matrix entry.
Superseded pull request runs are cancelled; pushes to main are not cancelled.

Each Node shard owns whole phases from `scripts/run-bun-tests.mjs`. Shared-process
groups, isolated chunks, and solo files retain their isolation boundaries. DOM
files retain Bun's per-file isolation. Each parity shard boots its own self-hosted
and Cloudflare targets and runs its selected scenarios against both.

Run a shard locally:

```sh
MYCO_TEST_KIND=node MYCO_TEST_SHARD=1/4 npm test
MYCO_TEST_KIND=dom MYCO_TEST_SHARD=1/2 npm test
MYCO_PARITY_SHARD=1/3 npm run test:parity
```

Without those variables, the commands run their full suites. Do not run multiple
shards in the same checkout concurrently: the runner owns shared bundle/report
directories and swaps the Bun configuration for DOM tests. CI uses separate
runners and checkouts.

`node scripts/check-test-shards.mjs` audits the workflow's actual matrix against
test discovery and the full parity catalogue. Every test file and scenario must
appear exactly once, and the aggregate gate must depend on every job. Run this
audit without other tests running in the checkout.

`scripts/test-durations.json` stores approximate milliseconds measured from the
linked GitHub run. Only files taking at least one second are listed; other files
use a small default weight. Weights affect placement, never test inclusion.
New files and scenarios enter the shards automatically. Refresh slow-file and
scenario weights from CI logs when jobs become unbalanced. Test jobs publish
phase durations in their summaries and upload JUnit reports and logs.

Aim for PR feedback within five minutes. Compare completed workflow elapsed time,
including runner queues and the aggregate gate, rather than summing parallel job
durations. Splitting jobs adds setup work and may increase billed runner minutes.
