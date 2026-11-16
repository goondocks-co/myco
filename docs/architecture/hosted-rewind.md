# Hosted rewind safety

`myco server rewind --target cloudflare --to <time>` refuses without changing local or hosted state. Safe in-place rewind is unavailable. It does not invoke Wrangler, even with `--yes`. Health reports that limitation and names `myco server restore --target cloudflare`. Native Deployments have no Time Travel; use their verified backups with `myco server restore --target local` in a fresh home. See [full recovery](../self-hosting.md#back-up-and-restore).

The CLI recognizes ISO 8601 instants with seconds and an explicit zone (`2026-11-16T10:30:00Z`, `2026-11-16T05:30:00-05:00`) and ten-digit Unix seconds. Missing or invalid times, future times, and times older than 30 days receive specific refusals. A valid time also receives an unavailable refusal; it is not an admitted recovery point. No confirmation is requested because nothing can be restored.

## Choosing recovery

A coordinated rewind would be appropriate for recent accidental edits or a bad deployment when the database and its serving Worker are compatible. It would discard everything captured after the selected instant. A verified full backup is needed for lost resources, older history, missing object bytes, or recovery into another Deployment. Worker rollback changes code only. The raw database command printed by updates is not a coordinated rewind.

D1 Time Travel restores the database in place, cancels in-flight queries and transactions, accepts timestamps or bookmarks, and returns the previous bookmark for undo. A timestamp resolves deterministically to a bookmark. It cannot clone a database or inspect a historical schema before restoring it. The documented operations provide no read of a historical schema; Myco therefore cannot infer compatibility from a timestamp alone. [Cloudflare Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

Paid Workers retain 30 days; Free retains 7. The limit is ten restores per ten minutes per database. Myco's 30-day object hold covers the maximum window, regardless of the account plan; it does not establish the account's available database history. [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Object lifetime

The Cloudflare blob adapter declares `releaseRetention: 'd1-time-travel'`. The object-release owner applies that policy both when draining and when deciding whether another immediate pass is due. Native stores retain their existing lifetime policy.

Every journaled physical object waits until the later of `object_releases.created_at + 30 days` and `retry_at`. A failed delete retains its journal row and retries without restarting the 30-day hold. An indexed due expression keeps held rows out of the active queue. `created_at` may already include another quarantine; the rewind hold is additional. The NEXT_REWIND schema step adds `idx_object_releases_retained_due` only: no trigger, row rewrite, constraint change or retirement.

| Deletion path | Ownership and hold |
| --- | --- |
| Replaced document chunks; session or transcript deletion; raw/content archive retirement; retired run bodies | Reference removal records release candidates. `release-queue` journals the unreferenced physical generation; the hosted drain holds it for 30 days. |
| Registered orphan sweep and store reconciliation | The same release journal and hosted hold. Store-walk quarantine is additional. |
| Aged upload reservations, consumed uploads, unresolved PUT settlement and abandoned backup publication | `object-lifecycle` journals bytes; the same hosted hold applies, even to bytes never published. |
| Backup retention | `backup-retention` journals the backup key before removing its catalogue row; the same hosted hold applies. |
| Unowned blob generations and vector page objects found by the store walk | `object-reconciliation` journals them; the same hosted hold plus store-walk quarantine applies. |
| A terminal member-write refusal after a private backup PUT | The publication or unresolved settlement intent remains owned until the clock journals its bytes; the same hosted 30-day hold applies. |
| Aborted recovery-staging copies and staging retention in `RecoveryProducer` | Separate recovery-bucket objects owned by the producer's Durable Object, not by D1. D1 Time Travel cannot restore producer history; this hold does not retain retired recovery artifacts. Keep verified backups independently. |

An open export hold still prevents releasing registered objects, leaving candidates until that hold settles. The rewind hold begins when those candidates are actually journaled. It survives process interruption in the database. It does not resurrect already-deleted bytes, and therefore does not promise 30 days of complete historical object coverage immediately after installation. R2 lifecycle policies or external deletion must not remove retained bytes.

Storage grows by the physical bytes released during the preceding 30 days, including generations of replaced content, deleted capture and expired backup objects. At a steady release rate of D bytes/day, expect approximately 30 × D additional bytes, plus pre-existing quarantines, retries and open export holds. Registered logical-byte counters exclude journaled objects; the hold is recorded in the release journal and policy, not in those counters. Bucket usage is the physical measure.

## Boundary before destructive rewind can ship

A backup hold protects deletion only. It neither pauses capture/MCP/admin writes nor drains registered runners and clock-launched work. The DeploymentClock retains launched promises, pacing, wake requests and persisted retry state outside D1; RecoveryProducer also retains its own state. D1 restore cancels current queries, but does not stop their callers issuing another write. Those capabilities need an external, durable maintenance fence with admission and drain acknowledgements before restore.

Existing hosted full recovery prepares a private SQLite copy, resets the object lifecycle and embedding epochs, then provisions fresh resources and a fresh Vectorize index. In-place rewind cannot reuse that publication procedure: a newer Vectorize index can contain entries absent from the older database, and existing Durable Objects retain their newer state. A reset must also retire copied active runs, claims, leases, upload authorities and holds, invalidate external indexing receipts, and restart work through each owner. Derived SQL counters restored in D1 remain at the database point; rebuilding arbitrary projections from source rows is the separate recovery rebuild work. No complete in-place coordinator or historical-schema probe exists.

| Interruption | Current command's state and next action |
| --- | --- |
| Before or during time validation / refusal | Nothing changed. Correct the time to inspect the refusal again, or use the printed full restore command with a verified artifact. |
| During the 30-day object hold | Bytes and journal row remain. The regular clock drain revisits them after the hold. |
| During or after an unacknowledged object delete | The journal row remains until acknowledgement. The regular drain retries the same immutable physical key. |
| Pause, restore, reset or resume | Unreachable: this command never enters a destructive phase. These interruption guarantees remain work for the coordinator; no normal-rewind success output is claimed. |

Live-only acceptance still needed for a future destructive implementation: account plan and oldest retained bookmark; historical Worker/schema compatibility; all writer and runner fences under concurrent traffic; actual D1 cancellation and lost restore responses; undo-bookmark recovery; Durable Object pause/reset across eviction and alarms; Vectorize retirement and reindexing; R2 reads of every reference after rewind; successful capture, search and Health after resume.
