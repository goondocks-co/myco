# Deployment storage cleanup

Schema 75 adds session archive bundles, compact row locators, publication proofs and resumable cleanup state. Migrations create empty indexed tables and discriminators; they do not scan or rewrite historical bodies. Native SQLite and D1 use the same schema statements.

`storage-content-cleanup` archives parsed/import event payloads and historical tool inputs larger than 2,048 UTF-8 bytes. A bundle contains at most 20 entries and ordinarily at most 1 MiB of body bytes from one Project, session and uploader evidence class. The existing session indexes supply tuple pages before eligibility filtering. Each entry records its identity, source envelope, revision, byte offset, length and digest. Concatenated exact bodies precede a JSON inventory footer and a fixed-length footer-size trailer. Body and receipt registrations, proofs and provenance are shared by the page. Events and tool calls retain integer bundle and entry locators, without a per-entry archive table or index.

New large inputs publish verified complete bytes before their byte-safe display prefix. Bounded cleanup combines recent captured input bundles, atomically updates their locators and journals superseded objects through the release owner. Output previews retain their existing 4 KB bound. Event identity, uploader, receipt time, envelope hash and processed projections remain intact.

Publication requires a generation-owned reservation, a durable body PUT, complete digest/size read-back and a separately verified durable inventory receipt. R2's acknowledged PUT establishes durability. Native publication syncs the file and directory entry; failure holds the original row. The clear transaction checks every source revision, uploader evidence, both registered publication generations, the live cleanup checkpoint and session tombstone absence. It publishes bundle locators, lifecycle facts, sentinel or prefix and cursor progress together. Retrying a committed transition does not clear it twice.

Oversized individual bodies hash through persisted byte/SHA checkpoints, reading at most 1 MiB per scan pass. Their final hash incorporates the inventory footer from the saved state; publication streams the exact source once. Each job admits at most 120 SQL statements, 60 blob calls and two seconds of new work. Already running calls cannot be cancelled by admission. The enclosing wake counts actual operations, runs parsing first and preserves capture, live parsing and repair shares. No additional timer is registered.

A durable queue covers captures behind the initial cursor. Its input work can inspect one forward session page and one preceding singleton to combine recent inputs. Completion follows an empty confirmation page; queued writes reopen work. Raw event age scans use a separate committed session tuple cursor and wrap after an empty page. No raw event catalogue row is needed: events retain their own uploader and provenance revision. The orphan sweep uses fixed primary-key pages, the shared release owner and a committed cursor. Held archives do not expand the number of identities examined per wake.

`retention.raw_days` controls the hot raw window: default 90 days, range 1–3650. Existing finite `retention.transcripts` values remain effective, and an explicitly stored legacy zero holds archival. Settings authority guards policy changes. Raw events and parsed transcript segments remain readable after archival. Unparsed transcript bytes, continuations and open recovery holds delay hot release. Processed rows and archived bytes remain retained indefinitely.

| Reader | Archived representation |
| --- | --- |
| Lifecycle projections | Effective end time, title-only end flag and prompt-origin scalar retained on events, including absent/null behavior |
| Raw event capability | Exact entry after historical uploader and current membership admission; internal bundle objects are refused by generic raw blob routes |
| Processed full-input API | Verified complete bundle entry or supported legacy inline/proved-blob representation |
| Tool children and dashboard | Byte-safe prefix, full UTF-8 byte count, truncation and Full input link |
| Raw transcript API | Uploader-only admission and private/no-store policy for hot or archived segments |
| Search, turns, KPIs and release provenance | Existing processed text, identities, counts, classifications and file facts |
| Additive backup/restore | Bundle/proof closure, exact object and entry verification, ID remapping and atomic adoption |
| Full recovery | Snapshot and complete verified bundle/receipt object inventory, independent of the source store |
| Session deletion | Bundle holds, proofs, queues and checkpoints follow the session tombstone and release owner |

A request scope caches verified bundle bytes while resolving several entries. Every raw entry retains its own admission; caching does not grant access to another entry. Snapshot and recovery publication verify all represented entries, including a locator that points to the wrong valid entry. Private scan/sweep cursors are excluded from additive export.

Rollback means pausing cleanup/retention and shipping a compatible fixed build. Keep the schema, mixed-format readers, inventories and object holds. There is no row-reversal operation. An older binary that treats a sentinel or prefix as the complete body cannot serve converted rows.

Cleared bytes, metadata and physical pages are distinct measurements. Cleanup reports `cleared_bytes` with a conservative `metadata_added_bytes` estimate covering registrations, proofs, provenance, indexes and locators. The representative fixture independently counts occupied record payloads across every table and index through SQLite `dbstat`, and checks page release and reuse. Conversion does not shrink the file or run VACUUM. Local projected net changes do not establish hosted file sizes, throughput or billing.
