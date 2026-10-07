# Storage cleanup packing validation

The fixture uses 1,000 events with these UTF-8 payload cohorts: 350 × 549 B,
190 × 1,470 B, 78 × 2,376 B, 98 × 3,361 B, 261 × 4,895 B, 16 × 10,805 B,
6 × 26,896 B and 1 × 127,417 B. Its 90 tool inputs comprise 72 × 4,000 B,
16 × 7,000 B and 2 × 18,000 B. The independent input-only fixture places one
eligible input among every ten identities, using the same eligible size cohorts.

`tests/myco-server/storage-cleanup-volume.test.ts` measures each phase separately
with SQLite `dbstat`, including every table and index. These are occupied record
bytes, rather than a prediction from cleared source bytes or a claim of physical
database file shrinkage. Negative net bytes indicate savings.

| Phase / fixture | Converted rows | Bundles | Entries / bundle | Net bytes | Net bytes / converted row |
| --- | ---: | ---: | ---: | ---: | ---: |
| 0: tool inputs, mixed fixture | 90 | 7 | 12.8571 | -220,374 | -2,448.600 |
| 1: events, mixed fixture | 1,000 | 41 | 24.3902 | -2,535,062 | -2,535.062 |
| 0: sparse input-only fixture | 90 | 7 | 12.8571 | -231,125 | -2,568.056 |

The gates require at least 12 entries per input bundle, 20 per event bundle and
negative occupied byte changes for each phase and the independent input cohort.
Small cohorts that cannot cover metadata plus the 20% admission margin stay
inline with `retained-inline:net-gain` recorded in the omissions ledger.

## Upgrade and authority gates

The resume test stamps a populated fixture at schema 75, persists phase 0 with a
cursor and counters, creates old singleton bundles and a converted row ahead of
the cursor, then applies the emitted schema-76 migration and drains the job.
It compares the saved state before and after migration, the existing bundles,
row locators and proofs, and reads every old full input. Schema 76 adds only
`idx_storage_cleanup_queue_packing`; it does not reset state or rewrite archives.

Admin pause and resume use the declared route authorization policy and the
shared atomic member write guard. Tests cover rightful admin access, member and
anonymous refusals, malformed bodies, demotion at write execution, pause between
identity pages, and pause after preparation before adoption. Capture remains
admitted while cleanup is paused. Admin status bounds the database read to 101
identities and traverses 250 stale omissions without counting absent sources.

The compiled macOS ARM64 binary serves the cleanup scenario through real HTTP.
The browser verifies the displayed preview and Full input link for an archived
tool attached to a prompt. The operator backup/restore commands recover exact
full bytes with the source server stopped and its blob directory removed; raw
archive access remains uploader-scoped after recovery.

## Bounded progress reporting

Bundle admission reserves the two final pending-status statements alongside
publication, adoption and disposal, including checkpointed oversized bodies.
The regression fixture has three eligible inputs in one session followed by
298 small and three eligible inputs in another session. Under the default
120-statement and 60-blob limits, cleanup reports three committed conversions
and pending work, leaves no prepared bundle, and finishes the remaining three
on the next invocation. Through the real tick, the job remains in the draining
set with a 2,000 ms next wake and reports its committed progress without failure.

## Mutation results

Each mutation ran in an isolated source copy against the packing and inherited
cleanup tests. The baseline passed. All mutations below failed behavioral gates.
The status-page mutation initially survived; observing the actual database result
size strengthened the gate, and the rerun caught it.

| Mutation | Gate that caught it | Result |
| --- | --- | --- |
| Publish each identity page | Sparse cross-page packing | Killed |
| Bypass net admission | Retained-inline admission | Killed |
| Remove 20% margin | Positive estimate below required margin | Killed |
| Remove queue session ordering | Interleaved session identities | Killed |
| Bypass pause admission | Cross-page and post-publication pause | Killed |
| Admit members to admin control | Actor refusal | Killed |
| Bypass source CAS | Concurrent source and event mutation | Killed |
| Accept publication without durability acknowledgement | Readable but unflushed objects | Killed |
| Bypass digest read-back | Same-sized body/receipt corruption | Killed |
| Mix uploader evidence | Project/session/uploader purity | Killed |
| Retain omissions after archival | Omission lifecycle and visibility | Killed |
| Bypass statement admission | Invocation and enclosing budgets | Killed |
| Reset persisted seek cursor | Mid-run resume | Killed |
| Bypass checkpoint revision | Atomic stale-checkpoint rejection | Killed |
| Remove status query row bound | Actual examined database page size | Killed |
| Omit final pending-status reservation | Bounded progress return and continued tick draining | Killed |

These fixtures and fault injections do not measure hosted D1 savings or prove
vendor crash behavior. Hosted Deployment state is untouched. Native power-loss
testing and a production-sized hosted measurement remain outside this lane.
