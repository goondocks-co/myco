# Storage cleanup verification: issue 1679

Schema 75 follows `origin/main` schema 74 at `afdcedb4137e3335412d23e1d3ce6ffc46469a3b`. Steps 1–74 remain frozen. The implementation archives exact stored bytes without transcript reconstruction or the future pointer writer and backup scheduler. Rollback pauses work and retains schema, compatible readers and held archives; there is no row reversal.

All runtime checks use private scratch homes and temporary roots. No hosted migration, cleanup, backup or restore was run. Runtime fixtures used neither production vaults nor shared daemons or real harness credentials.

## Fixture measurements

The committed `storage-cleanup-volume.test.ts` fixture converts 24 synthetic response rows and clears **2,882,378 inline bytes**. SQLite uses 4,096-byte pages:

| Stage | File pages | Free pages |
| --- | ---: | ---: |
| Empty schema | 421 | 0 |
| Populated | 1,158 | 29 |
| Converted | 1,158 | 705 |
| 24 similar new captures | 1,190 | 29 |

Conversion makes **676 pages / 2,768,896 bytes reusable**. The database file does not shrink. Subsequent captures add 32 pages instead of the initial population's 737-page increase. No VACUUM or fresh-database cutover runs.

Archive registration/reference/proof payload, including indexes, measures **65,698 bytes / 2,737 bytes per event**, exceeding the design's 384–768-byte planning range. This fixture does not establish the design's aggregate storage forecast. The sample retains 24 event refs, 24 raw refs and 48 durable body/receipt proofs.

One local sample counts 1,072 SQL statements, 388 round trips and 96 blob calls across all bounded wakes. Its wall time is 112.4 ms; separately measured process CPU is 133,444 user and 3,372 system microseconds. Timing is descriptive, not a throughput guarantee or hosted CPU measurement. Wall admission cannot cancel an already running query.

## Controls and runtime checks

The strengthened focused control passed 204 tests across cleanup, input storage, raw-window authority, real workerd orphan sweeping, wake ordering and parser fairness. The native durability/raw archive/orphan control passed 19 tests. The final query-plan control passed 15 tests and the final measured-volume/workerd fixtures passed 2 tests.

Full `npm test` passed all three built-in shards, covering 920 source test files, including all 77 meta files. An initial shard hit an unchanged process-observation helper race: the PID vanished between `kill(pid, 0)` and `ps`. The matched focused rerun and the affected full shard rerun passed. The compiled-binary smoke passed all 66 assertions. It includes the built dashboard's truncated input and Full input link, real HTTP search/privacy/archival, operator CLI backup/restore and source-object unavailability during recovery. Native and workerd use the same parity scenario and schema; the final matched scenario passed 106 assertions, including new input spills and conversion of a legacy full inline input (172 assertions including the compiled smoke).

`npm run lint`, `npm run -s check` in `packages/myco-server`, and `make build` passed. The build includes the repository checks, full tests, generators, dashboard and compiled native binary verification. The final fetch/rebase left the branch based on the same schema-74 commit, and the carried binary/runtime parity smoke was repeated after that rebase.

## Mutation results

**47 final mutants killed; no final survivors or equivalent mutants.** Every source mutation was restored byte-for-byte before the next run. Each mutant ran with `npm test -- <focused committed gate>`. Initial survivors exposed missing fixture conditions (a full tuple page, imported lifecycle ownership, and a tombstone arriving after publication); the strengthened controls passed before valid reruns. An initial receipt mutation that also removed bindings was discarded. The final character-cap mutation preserves the UTF-8 overflow condition while using character slicing.

| Mutant | Source | Failing committed gate | Result |
| --- | --- | --- | --- |
| `unflushed-put-admitted` | [registered-content.ts](../../packages/myco-server/src/core/registered-content.ts) | [archive-before-clear storage cleanup > requires durable publication even when unflushed objects are immediately readable](../../tests/myco-server/storage-cleanup.test.ts) | killed |
| `size-only-readback` | [registered-content.ts](../../packages/myco-server/src/core/registered-content.ts) | [archive-before-clear storage cleanup > verifies the bytes again when reusing a same-sized registered archive](../../tests/myco-server/storage-cleanup.test.ts) | killed |
| `key-size-only-reuse` | [registered-content.ts](../../packages/myco-server/src/core/registered-content.ts) | [archive-before-clear storage cleanup > verifies the bytes again when reusing a same-sized registered archive](../../tests/myco-server/storage-cleanup.test.ts) | killed |
| `receipt-evidence-bypass` | [event-content.ts](../../packages/myco-server/src/core/event-content.ts) | [archive-before-clear storage cleanup > keeps a released archive generation inadmissible even after successful read-back](../../tests/myco-server/storage-cleanup.test.ts) | killed |
| `body-evidence-bypass` | [event-content.ts](../../packages/myco-server/src/core/event-content.ts) | [archive-before-clear storage cleanup > keeps a released archive generation inadmissible even after successful read-back](../../tests/myco-server/storage-cleanup.test.ts) | killed |
| `checkpoint-guard-bypass` | [storage-cleanup.ts](../../packages/myco-server/src/core/storage-cleanup.ts) | [archive-before-clear storage cleanup > refuses a stale checkpoint and a source mutation after publication atomically](../../tests/myco-server/storage-cleanup.test.ts) | killed |
| `source-revision-guard-bypass` | [event-content.ts](../../packages/myco-server/src/core/event-content.ts) | [archive-before-clear storage cleanup > refuses a stale checkpoint and a source mutation after publication atomically](../../tests/myco-server/storage-cleanup.test.ts) | killed |
| `tombstone-guard-bypass` | [event-content.ts](../../packages/myco-server/src/core/event-content.ts) | [archive-before-clear storage cleanup > refuses a tombstone that arrives after body and receipt publication](../../tests/myco-server/storage-cleanup.test.ts) | killed |
| `preview-cap-2049` | [tool-input.ts](../../packages/myco-server/src/core/tool-input.ts) | [tool input storage > keeps inline inputs through 2048 UTF-8 bytes and spills complete larger inputs](../../tests/myco-server/tool-input-storage.test.ts) | killed |
| `character-input-cap` | [tool-input.ts](../../packages/myco-server/src/core/tool-input.ts) | [tool input storage > keeps inline inputs through 2048 UTF-8 bytes and spills complete larger inputs](../../tests/myco-server/tool-input-storage.test.ts) | killed |
| `preview-returned-as-full` | [processed.ts](../../packages/myco-server/src/read/processed.ts) | [tool input storage > keeps inline inputs through 2048 UTF-8 bytes and spills complete larger inputs](../../tests/myco-server/tool-input-storage.test.ts) | killed |
| `processed-proof-bypass` | [processed.ts](../../packages/myco-server/src/read/processed.ts) | [archive-before-clear storage cleanup > archives a legacy large input, retains complete facts and output bytes, and refuses a missing full proof](../../tests/myco-server/storage-cleanup.test.ts) | killed |
| `files-from-prefix` | [projections.ts](../../packages/myco-server/src/ingest/projections.ts) | [tool input storage > keeps inline inputs through 2048 UTF-8 bytes and spills complete larger inputs](../../tests/myco-server/tool-input-storage.test.ts) | killed |
| `output-preview-1024` | [index.ts](../../packages/myco-server/src/ingest/parsers/index.ts) | [tool input storage > preserves the 4096-character output prefix and tool attribution while archiving inputs](../../tests/myco-server/tool-input-storage.test.ts) | killed |
| `raw-uploader-bypass` | [raw-resources.ts](../../packages/myco-server/src/core/raw-resources.ts) | [archive-before-clear storage cleanup > keeps exact UTF-8 spelling, projections, privacy and a behind-cursor import without transcript reconstruction](../../tests/myco-server/storage-cleanup.test.ts) | killed |
| `sentinel-returned-as-body` | [event-content.ts](../../packages/myco-server/src/core/event-content.ts) | [archive-before-clear storage cleanup > seeks the next Project even when its event id sorts before the previous Project cursor](../../tests/myco-server/storage-cleanup.test.ts) | killed |
| `wall-clear-after-deadline` | [storage-cleanup.ts](../../packages/myco-server/src/core/storage-cleanup.ts) | [archive-before-clear storage cleanup > holds clearing when a publication consumes the wall allowance, then resumes](../../tests/myco-server/storage-cleanup.test.ts) | killed |
| `disabled-statement-reserve` | [storage-cleanup.ts](../../packages/myco-server/src/core/storage-cleanup.ts) | [archive-before-clear storage cleanup > shares remaining invocation admission and refuses disabled statement and blob reserves](../../tests/myco-server/storage-cleanup.test.ts) | killed |
| `disabled-blob-reserve` | [storage-cleanup.ts](../../packages/myco-server/src/core/storage-cleanup.ts) | [archive-before-clear storage cleanup > shares remaining invocation admission and refuses disabled statement and blob reserves](../../tests/myco-server/storage-cleanup.test.ts) | killed |
| `tuple-project-boundary` | [storage-cleanup.ts](../../packages/myco-server/src/core/storage-cleanup.ts) | [archive-before-clear storage cleanup > seeks the next Project even when its event id sorts before the previous Project cursor](../../tests/myco-server/storage-cleanup.test.ts) | killed |
| `early-page-completion` | [storage-cleanup.ts](../../packages/myco-server/src/core/storage-cleanup.ts) | [archive-before-clear storage cleanup > seeks the next Project even when its event id sorts before the previous Project cursor](../../tests/myco-server/storage-cleanup.test.ts) | killed |
| `unbounded-source-page` | [event-content.ts](../../packages/myco-server/src/core/event-content.ts) | [resumable content scan > streams historical bodies in byte pages no larger than one MiB](../../tests/myco-server/content-scan-checkpoint.test.ts) | killed |
| `missing-live-import-queue` | [schema-v75.ts](../../packages/myco-server/src/db/schema-v75.ts) | [archive-before-clear storage cleanup > keeps exact UTF-8 spelling, projections, privacy and a behind-cursor import without transcript reconstruction](../../tests/myco-server/storage-cleanup.test.ts) | killed |
| `archived-end-facts-bypass` | [projections.ts](../../packages/myco-server/src/ingest/projections.ts) | [archive-before-clear storage cleanup > retains absent and null origin, title-only ends and end-first lifecycle ordering](../../tests/myco-server/storage-cleanup.test.ts) | killed |
| `archived-title-only-facts-bypass` | [projections.ts](../../packages/myco-server/src/ingest/projections.ts) | [archive-before-clear storage cleanup > retains absent and null origin, title-only ends and end-first lifecycle ordering](../../tests/myco-server/storage-cleanup.test.ts) | killed |
| `archived-prompt-origin-bypass` | [projections.ts](../../packages/myco-server/src/ingest/projections.ts) | [archive-before-clear storage cleanup > retains absent and null origin, title-only ends and end-first lifecycle ordering](../../tests/myco-server/storage-cleanup.test.ts) | killed |
| `restore-closure-bypass` | [backup.ts](../../packages/myco-server/src/core/backup.ts) | [refuses an artifact missing its archive reference or receipt proof before inserting the event](../../tests/myco-server/archive-backup.test.ts) | killed |
| `restore-atomic-closure-bypass` | [event-content-restore.ts](../../packages/myco-server/src/core/event-content-restore.ts) | [rolls back a newly inserted event when its reference cannot match the destination](../../tests/myco-server/archive-backup.test.ts) | killed |
| `late-success-trigger-order` | [storage-cleanup.ts](../../packages/myco-server/src/core/storage-cleanup.ts) | [tool input storage > finishes clearing a legacy full input when a late success arrives after its proof](../../tests/myco-server/tool-input-storage.test.ts) | killed |
| `orphan-outer-bound-runtime` | [retention.ts](../../packages/myco-server/src/ingest/retention.ts) | [workerd D1/R2 sweeps all-held pages, a sparse orphan, and a late orphan behind the cursor](../../tests/myco-server/orphan-sweep-runtime.test.ts) | killed |
| `manual-actor-guard-bypass` | [member-write-store.ts](../../packages/myco-server/src/auth/member-write-store.ts) | [refuses a raw-window edit when its actor is revoked at commit and preserves legacy policy](../../tests/myco-server/settings-api.test.ts) | killed |
| `restore-live-actor-bypass` | [restore-authorization.ts](../../packages/myco-server/src/core/restore-authorization.ts) | [a transfer after restore admission rolls back the first guarded data batch](../../tests/myco-server/restore-authority.test.ts) | killed |
| `cleanup-before-live-parser` | [tick.ts](../../packages/myco-server/src/core/tick.ts) | [the power state a tick resolves > runs housekeeping at every depth but deep sleep: a Deployment in use is swept too](../../tests/myco-server/tick.test.ts) | killed |
| `repair-steals-live-budget` | [parse.ts](../../packages/myco-server/src/ingest/parse.ts) | [repair lane priority > rotates repair cursors while live and imported transcripts remain pending under calls pressure](../../tests/myco-server/transcript-parse.test.ts) | killed |
| `scan-instead-of-tuple-seek` | [storage-cleanup.ts](../../packages/myco-server/src/core/storage-cleanup.ts) | [archive-before-clear storage cleanup > seeks the next Project even when its event id sorts before the previous Project cursor](../../tests/myco-server/storage-cleanup.test.ts) | killed |
| `fixture-cleared-bytes-counter` | [storage-cleanup.ts](../../packages/myco-server/src/core/storage-cleanup.ts) | [measures exact cleared bytes and page reuse for a dogfood-shaped response history](../../tests/myco-server/storage-cleanup-volume.test.ts) | killed |
| `automatic-vacuum` | [storage-cleanup.ts](../../packages/myco-server/src/core/storage-cleanup.ts) | [measures exact cleared bytes and page reuse for a dogfood-shaped response history](../../tests/myco-server/storage-cleanup-volume.test.ts) | killed |
| `native-file-fsync` | [blobs.ts](../../packages/myco-server/src/platform/bun/blobs.ts) | [blob publication durability > acknowledges native publication after syncing the file and its directory entry](../../tests/myco-server/native-blob-durability.test.ts) | killed |
| `native-final-directory-fsync` | [blobs.ts](../../packages/myco-server/src/platform/bun/blobs.ts) | [blob publication durability > acknowledges native publication after syncing the file and its directory entry](../../tests/myco-server/native-blob-durability.test.ts) | killed |
| `orphan-outer-page-bound` | [retention.ts](../../packages/myco-server/src/ingest/retention.ts) | [bounds examined identities with all-held pages and reaches a sparse orphan at the tail](../../tests/myco-server/orphan-sweep.test.ts) | killed |
| `orphan-fresh-upload-grace` | [retention.ts](../../packages/myco-server/src/ingest/retention.ts) | [keeps a recent upload available for its event until the reservation window passes](../../tests/myco-server/orphan-sweep.test.ts) | killed |
| `raw-source-revision` | [raw-archive.ts](../../packages/myco-server/src/core/raw-archive.ts) | [refuses stale event source revision and a due hint newer than the raw age window](../../tests/myco-server/raw-archive.test.ts) | killed |
| `raw-receipt-proof` | [raw-archive.ts](../../packages/myco-server/src/core/raw-archive.ts) | [keeps a parsed segment hot when its prepared receipt loses proof before clear](../../tests/myco-server/raw-archive.test.ts) | killed |
| `raw-parser-hold` | [raw-archive.ts](../../packages/myco-server/src/core/raw-archive.ts) | [advances a bounded due cursor past held rows to a sparse eligible event](../../tests/myco-server/raw-archive.test.ts) | killed |
| `raw-recovery-hold` | [raw-archive.ts](../../packages/myco-server/src/core/raw-archive.ts) | [holds a parsed transcript source throughout an active recovery hold](../../tests/myco-server/raw-archive.test.ts) | killed |
| `raw-age-hold` | [raw-archive.ts](../../packages/myco-server/src/core/raw-archive.ts) | [refuses stale event source revision and a due hint newer than the raw age window](../../tests/myco-server/raw-archive.test.ts) | killed |
| `raw-tuple-cursor` | [raw-archive.ts](../../packages/myco-server/src/core/raw-archive.ts) | [advances a bounded due cursor past held rows to a sparse eligible event](../../tests/myco-server/raw-archive.test.ts) | killed |

## Evidence limits

This is a dogfood-shaped synthetic fixture, not a production-data cleanup. Local native/workerd parity and the fault model do not prove hosted D1 size, billing, CPU or latency; real R2 durability rests on its acknowledged-PUT contract. File and directory sync faults are injected, not physical power-loss tests. Native Windows storage durability is not established by the macOS smoke. Historical snapshots, exports and backups are preserved; this change does not rewrite them. The separate pointer and incremental/cold-tier PRs remain subsequent work.
