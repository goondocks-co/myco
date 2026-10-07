# Deployment storage cleanup

Schema 75 adds archive references, publication proofs and resumable cleanup state. Migrations create empty indexed tables and discriminators; they do not scan or rewrite historical bodies. The native server and D1 use the same schema statements.

`storage-content-cleanup` archives selected parsed/import event payloads and historical tool inputs larger than 2,048 UTF-8 bytes. Each conversion preserves the exact stored bytes, envelope hash, uploader, receipt time, event identity and existing projections. Archived event rows contain a valid JSON sentinel and an explicit format discriminator. Large tool inputs retain a byte-safe display prefix and their original byte count. New input writes use the same verified blob writer before publishing their prefix. Output previews keep their existing 4 KB bound and shape.

Publication requires a generation-owned reservation, a durable body PUT, a complete digest/size read-back, and a separately verified durable inventory receipt. R2's acknowledged PUT establishes durability. Native publication syncs the file and its directory entry; failure holds the original row. The atomic clear asserts the exact source revision and envelope identity, both held publication generations, the live cleanup checkpoint and the absence of a session tombstone. It commits references, lifecycle facts, the sentinel or prefix, and cursor progress together. A stale or failed assertion rolls back the whole transition. Retrying a completed transition does not convert it twice.

Bodies over the 1 MiB ordinary page target hash through persisted byte/SHA checkpoints. Source slices contain at most 1 MiB; source revision guards reject mixed revisions. Clearing follows only a complete body and receipt verification. Ordinary commits convert one row at a time within the 20-row ceiling. Each invocation admits at most 120 SQL statements, 60 blob calls and two seconds of new work. A query already in flight cannot be cancelled by wall admission. The wake counts statements, round trips and blob calls across its jobs, runs parsing first, preserves its live/repair shares, and gives archival only the remaining allowance. No additional timer is registered.

Primary-key tuple cursors bound historical identity pages. A durable queue covers new captures and imports behind the initial cursor. Completion follows an empty confirmation page, and new queued rows reopen work. The orphan sweep examines a fixed primary-key identity page, decides unreferenced objects through the shared release owner and commits its cursor; held archives do not turn its wake into a scan of all history. Newly registered uploads retain their reservation grace period while capture publishes references.

`retention.raw_days` controls the hot raw window, default 90 days, range 1–3650. Existing finite `retention.transcripts` values remain effective; an explicitly stored legacy zero holds archival. Finite writes converge to the canonical leaf through the settings authority. Raw event bodies and parsed transcript segments remain readable from their archived locators. Unparsed bytes, parser continuations and open recovery holds delay hot release. Processed rows and archived raw bytes remain retained indefinitely. The existing object store supplies the archive destination; this PR does not configure a separate storage class or external cold bucket.

| Reader | Representation after conversion |
| --- | --- |
| Lifecycle projections | Exact effective end time, title-only end flag and original prompt-origin scalar, including absent/null semantics |
| Raw event capability | Exact archive body after existing uploader admission; sentinel never returned |
| Processed full-input API | Complete inline field or integrity-checked blob backed by the exact processed-field proof |
| Tool children and dashboard | Display prefix, full UTF-8 byte count, explicit truncation and the existing Full input link |
| Raw blob/transcript API | Existing uploader-only admission and private/no-store response policy across hot and archived locators |
| Search | Existing processed text and proved text blobs; conversion does not rebuild or change FTS |
| Turns, KPIs and release provenance | Existing identities, counts, tool classifications and files affected |
| Additive backup/restore | Archive references and publication proofs; atomic row/reference/proof representation closure |
| Full recovery | Verified snapshot plus exact body/input/receipt object inventory; restore does not require the source bucket |
| Session deletion | Archive references, proofs, queues and scan checkpoints follow the session tombstone and release owner |

In-progress scan/sweep state stays private to migration work and is excluded from additive export. Completed references and their objects participate in recovery and reference holds independently of later transcript-pointer or incremental-backup work.

Rollback means pausing cleanup/retention and shipping a compatible fixed build. Keep schema 75, mixed-format readers, full-input proof checks, archive inventories and all object holds. There is no row-reversal operation. An older binary that interprets a sentinel or prefix as the full body cannot serve converted rows. Whole-snapshot recovery remains the existing separately verified operator operation.

Cleared logical bytes and reusable SQLite pages are distinct measurements. Conversion does not shrink the database file or run VACUUM. The committed dogfood-shaped fixture records page count and freelist count before conversion, after conversion and after similar captures reuse space. Hosted database size, production throughput and a separate cold-storage tier are outside that fixture's evidence.

The 24-row synthetic response fixture clears 2,882,378 inline bytes. At 4,096 bytes per page, conversion changes the freelist from 29 to 705 pages without changing the 1,159-page file: 676 pages (2,768,896 bytes) become reusable. Adding 24 similar captures then consumes that space and adds 32 pages, compared with the original 737-page population increase. This is local reuse evidence, not physical file shrinkage or hosted D1 billing evidence.

Measured archive registration/reference/proof payload, including their indexes, is 65,698 bytes, or approximately 2,737 bytes per converted event in that fixture. It exceeds the design's 384–768-byte planning range; per-event body and receipt registrations contribute to that overhead. The fixture does not validate the original aggregate storage forecast.
