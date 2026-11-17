# Hosted stored-data retention and database recovery

Cloudflare Time Travel can restore the D1 database alone. Myco does not yet coordinate that restore with its writers, runners, Durable Objects or external indexes, and exposes no rewind command. A database-only restore discards later database writes but leaves the rest of the Deployment at its newer state.

Hosted stored objects are held for 30 days after release, regardless of the Cloudflare plan. During that window, an older database can still read the physical objects it referenced before their registrations were removed. The hold protects those bytes; it does not make a database-only restore a coordinated Myco recovery.

Native Deployments have no Time Travel. Their backup artifacts are a separate recovery source. A hosted Deployment may have no complete recovery artifact: verify what exists and its coverage before choosing [full recovery](../self-hosting.md#back-up-and-restore).

## Choosing recovery

For a hosted Deployment, Time Travel is the everyday protection against a recent accidental edit or bad migration: any minute within 30 days on Workers Paid or 7 days on Free. A compatible Worker and coordinated treatment of the other state below are still required. A full recovery artifact, when one is available and verified, can recover lost resources, older history or missing object bytes into fresh resources. Worker rollback changes code only. Before advancing an existing database’s schema, Myco records a current restore point durably and refuses to advance if it cannot. The database command printed by updates restores D1 alone. Time Travel is in-place history tied to the database and account, not an independent copy; use a complete copy you hold for a lost database or account, or a move. See [the operator recovery choices](../self-hosting.md#back-up-and-restore).

D1 Time Travel restores the database in place, cancels in-flight queries and transactions, accepts timestamps or bookmarks, and returns the previous bookmark for undo. A timestamp resolves deterministically to a bookmark. It cannot clone a database. The documented operations provide no read of a historical schema; Myco therefore cannot infer compatibility from a timestamp alone. [Cloudflare Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

Paid Workers retain 30 days; Free retains 7. The limit is ten restores per ten minutes per database. Myco's 30-day object hold covers the maximum window, regardless of the account plan; it does not establish the account's available database history. [Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Object lifetime

The Cloudflare environment declares the required `releaseRetention: 'd1-time-travel'` policy. Content measurement carries it with the environment, independently of wrapped blob stores. The object-release owner applies that policy both when draining and when deciding whether another immediate pass is due. Native environments declare `journal-due`, retaining their existing lifetime policy.

Every journaled physical object waits until the later of `object_releases.created_at + 30 days` and `retry_at`. A failed delete retains its journal row and retries without restarting the 30-day hold. An indexed due expression keeps held rows out of the active queue. `created_at` may already include another quarantine; the 30-day hold is additional. The NEXT_REWIND schema step adds `idx_object_releases_retained_due` only: no trigger, row rewrite, constraint change or retirement.

| Deletion path | Ownership and hold |
| --- | --- |
| Replaced document chunks; session or transcript deletion; raw/content archive retirement; retired run bodies | Reference removal records release candidates. `release-queue` journals the unreferenced physical generation; the hosted drain holds it for 30 days. |
| Registered orphan sweep and store reconciliation | The same release journal and hosted hold. Store-walk quarantine is additional. |
| Aged upload reservations, consumed uploads, unresolved PUT settlement and abandoned backup publication | `object-lifecycle` journals bytes; the same hosted hold applies, even to bytes never published. |
| Backup retention | `backup-retention` journals the backup key before removing its catalogue row; the same hosted hold applies. |
| Unowned blob generations and vector page objects found by the store walk | `object-reconciliation` journals them; the same hosted hold plus store-walk quarantine applies. |
| A terminal member-write refusal after a private backup PUT | The publication or unresolved settlement intent remains owned until the clock journals its bytes; the same hosted 30-day hold applies. |
| Aborted recovery-staging copies and staging retention in `RecoveryProducer` | Separate recovery-bucket objects owned by the producer's Durable Object, not by D1. D1 Time Travel cannot restore producer history; this hold does not retain retired recovery artifacts. Keep verified backups independently. |

An open export hold still prevents releasing registered objects, leaving candidates until that hold settles. The 30-day hold begins when those candidates are actually journaled. It survives process interruption in the database. It does not resurrect already-deleted bytes, and therefore does not promise 30 days of complete historical object coverage immediately after installation. R2 lifecycle policies or external deletion must not remove retained bytes.

Storage grows by the physical bytes released during the preceding 30 days, including generations of replaced content, deleted capture and expired backup objects. At a steady release rate of D bytes/day, expect approximately 30 × D additional object bytes, plus journal and index metadata, pre-existing quarantines, retries and open export holds. Registered logical-byte counters exclude journaled objects; the hold is recorded in the release journal and policy, not in those counters. Bucket usage is the physical measure. Health uses the target already loaded by its status request to describe the hold. It shows no held amount: the existing measurements count registered bytes, and release journal rows contain physical keys rather than byte sizes. No status query, object-store scan or per-object size request is added.

## Boundary before destructive rewind can ship

A backup hold protects deletion only. It neither pauses capture/MCP/admin writes nor drains registered runners and clock-launched work. The DeploymentClock retains launched promises, pacing, wake requests and persisted retry state outside D1; RecoveryProducer also retains its own state. D1 restore cancels current queries, but does not stop their callers issuing another write. Those capabilities need an external, durable maintenance fence with admission and drain acknowledgements before restore.

After a database-only restore, the serving Worker may expect a different schema, restored active claims and leases may disagree with attached runners, and the clock and recovery producer keep their newer scheduling state. Vectorize can retain entries whose source rows no longer exist in D1.

Existing hosted full recovery prepares a private SQLite copy, resets the object lifecycle and embedding epochs, then provisions fresh resources and a fresh Vectorize index. In-place rewind cannot reuse that publication procedure: a newer Vectorize index can contain entries absent from the older database, and existing Durable Objects retain their newer state. A reset must also retire copied active runs, claims, leases, upload authorities and holds, invalidate external indexing receipts, and restart work through each owner. Derived SQL counters restored in D1 remain at the database point; rebuilding arbitrary projections from source rows is the separate recovery rebuild work. No complete in-place coordinator or historical-schema probe exists.

The object hold itself survives interruption: the journal row and bytes remain while held, and an unacknowledged delete retains its journal row for the regular drain to retry. A future coordinated operation still needs a recoverable operation journal across pause, restore, reset and resume; none of those phases is implemented today.

Live-only acceptance still needed for a future destructive implementation: account plan and oldest retained bookmark; historical Worker/schema compatibility; all writer and runner fences under concurrent traffic; actual D1 cancellation and lost restore responses; undo-bookmark recovery; Durable Object pause/reset across eviction and alarms; Vectorize retirement and reindexing; R2 reads of every reference after rewind; successful capture, search and Health after resume.
