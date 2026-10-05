# Raw provenance backfill budget

The job drains 500-row pages, each with its existing atomic attribution/checkpoint
commit. A run reserves six statements per page (two reads, up to four writes),
stops after at most 20 pages / 120 statements, and has a 2,000 ms elapsed allowance.
Before starting another page it also reserves the longest page duration observed
in that run. Source transitions and empty pages consume the same reservation.
Errors propagate; the next run reads the last committed checkpoint.

## Local measurement

Measured on macOS arm64 using Wrangler 4.126.0 / local workerd D1. The historical
fixture spans two Projects, 340,205 events, 1,105 blobs, 1,005 transcripts and their
retained segments, 1,105 each of prompts, responses, tool calls and attachments,
and 205 plans. Tool calls have both input and output references. Rows are loaded
before schema 71, then migrated, so provenance is filled by the job rather than
by insertion triggers.

An explicit `wrangler dev` probe sampled 110 individual pages at each size across
all nine source kinds, with event cursors at the start, middle and end. Samples
include initial attribution and checkpoint replay; they are local timings, without
hosted network latency. D1's `meta.duration` records statement cost, and the
worker measures page elapsed time around both reads and the commit.

| Page size | Page median | Page p95 | Page maximum | Maximum D1 statement |
| --- | ---: | ---: | ---: | ---: |
| 100 | 2 ms | 17 ms | 20 ms | 18 ms |
| 500 | 3 ms | 21 ms | 24 ms | 21 ms |

A separate complete-fixture run through workerd D1 used production defaults and
fresh, successive pages. It completed in 36 job runs: median 294 ms, p95 535 ms,
maximum 574 ms, at most 120 statements per run. Among 681 event pages the median
was 15 ms, p95 28 ms and maximum 66 ms; maximum commit-statement duration was
15 ms. Full transcript pages took up to 9 ms. Earlier repeats under concurrent
test load measured up to 1,181 ms per run and 172 ms per statement.

The six-statement reservation caps a run at 10,000 source rows, 100 times the old
100-row run, even if the clock does not advance. The 2-second allowance is small
beside this Deployment's configured 60-second CPU ceiling and leaves time for
transcript parsing (its own 15-second / 500-call allowance) and other tick jobs.
The combined backfill/parser reservations are 620 queries, below paid Workers'
1,000-query invocation ceiling. Individual measured statements are well below
D1's 30-second query limit. See [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
and [Worker limits](https://developers.cloudflare.com/workers/platform/limits/).
These allowances target paid Worker/D1 invocations; these budgets are
not sized for the free plan's 50-query invocation ceiling.

The elapsed allowance controls admission of the next page, not cancellation of
an in-flight D1 request. Unexpected provider stalls can exceed it. Local
measurement does not establish hosted CPU usage, latency, quotas, or the time to
complete the existing owner's backlog.

## Repeatable gates

Use the repository test runner with all home and temporary-directory variables
pointing into an isolated scratch directory:

```sh
npm test -- tests/myco-server/raw-backfill.test.ts tests/myco-server/raw-backfill-runtime.test.ts
MYCO_BACKFILL_MEASURE=1 npm test -- tests/myco-server/raw-backfill-runtime.test.ts
npm run test:parity -- -t 'raw backfill'
```

The optional measurement emits per-source page/statement statistics; setting
`MYCO_BACKFILL_EVIDENCE` to an isolated file also saves every run's samples.
The normal fixture contains 10,205 events and every source kind, and must complete
within three job runs. The real wake-path scenario exercises both the shipped
native entry and Wrangler/D1, finishing its fixture within three wakes.

Interruption is injected before the second page commit. The gate serializes and
reopens SQLite, resumes from the committed page, changes the original credential's
identity, and replays a committed page. Existing attribution and row bytes must
remain identical. Budget gates independently exhaust elapsed and statement
allowances. Native/workerd parity compares final records and total changes,
allowing each target's elapsed clock to stop at different checkpoints per run.

| Mutation | Catching gate | Result |
| --- | --- | --- |
| Stop after one page | All-source fixture completes within three runs | Killed |
| Omit checkpoint update | Interrupted run resumes from its committed page | Killed |
| Replace attribution on conflict | Replay keeps the first attribution | Killed |
| Ignore elapsed allowance | Reserve page time before the elapsed deadline | Killed |
| Ignore statement allowance | Never exceed the statement allowance | Killed |
| Understate page statement cost | Event pages stay within the statement allowance | Killed |
| Native selects only one row per page | Native/workerd final totals and records agree | Killed |

Mutations use isolated copies of the core module with a test-only TypeScript
path override; the last mutation changes only the native import, leaving the
workerd bundle unchanged. The unmodified override control passes. Every mutant
exits nonzero at the named assertion, and all runs use `npm test`.
