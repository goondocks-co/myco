# Deployment recovery artifacts

`myco server backup --target local|cloudflare --to <directory>` captures the selected Deployment without applying migrations. The local target uses SQLite `VACUUM INTO`, including committed WAL data. The Cloudflare target uses the operator's existing Wrangler login and an explicitly bound D1 database; it exports ordinary tables and `sqlite_sequence`, reconstructs the source's indexes, views, triggers and external-content FTS indexes, and refuses schema drift. Cloudflare temporarily pauses database queries during its export. R2 objects stream through the operator process using an in-memory credential obtained with `wrangler auth token --json`; credential disk logging is disabled, redirects are refused and a rejected credential is refreshed at most once per object.

Both targets use one artifact writer. The directory contains:

- `myco.sqlite`: a closed database snapshot, checked for integrity, foreign keys and required captured-content references.
- `blobs/<project>/<sha256>`: every object registered in that snapshot, verified against its size and digest.
- `blobs/backups/<filename>.jsonl`: every backup catalogued in that snapshot, including pinned backups. The writer checks its catalogued size and records a SHA-256 digest for subsequent resume and offline verification.
- `recovery.json`: source target and identity, schema version, capture timestamps, database digest, blob totals, the operator's configuration record and required independent credentials.

Cloudflare provisioning and rendered bindings use the record's Worker, database, bucket, vector-index and wrapping-secret names. Existing records that omit `vectorIndexName` or `wrapKeySecretName` retain the default names. A recovery record can name separate resources; the record must also name the recovery destination's URL rather than the original live route. Choosing those resources does not copy data, recover credentials or rebuild their contents.

The manifest advances from `snapshot` to `content` to `complete`. A failed copy stays incomplete. Running the same command against the same source and directory resumes the saved snapshot and verifies existing bytes before reusing them. A completed artifact is verified without refreshing its contents; use a new directory for another recovery point. A different source or an unrelated nonempty directory is refused. One process holds the destination lock at a time.

New artifacts use `myco-recovery/2` and include digests for catalogued backup objects. Existing `myco-recovery/1` artifacts remain readable and retain their original coverage. Verification reports when a legacy artifact's database contains backups whose object bytes are outside that coverage; use a new destination to capture them. It does not silently upgrade or modify a completed legacy artifact. Backup catalog rows alone do not preserve the downloadable artifacts.

`complete` means the data artifact passed verification. It does not establish that independent credentials exist, that an external vector index has been rebuilt, or that a replacement Deployment works. Keep the original wrapping key, session secret and GitHub application credentials in separate secure recovery storage. Wrangler credentials stay on the operator's machine and are not copied into the artifact or Deployment. The database itself contains private project data and encrypted settings; treat the directory as private.

Native recovery writes into a fresh `MYCO_HOME`:

```sh
MYCO_HOME=/path/to/fresh-home myco server restore --target local \
  --from /path/to/recovery-artifact --secrets-from /path/to/independent-secrets.env \
  --port 8787 --yes
```

The separate credentials file uses `NAME=value` lines for `SECRET_WRAP_KEY`, `SESSION_SECRET`, `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`. Keep it outside the data artifact. Recovery verifies that the wrapping key opens every stored credential; it never generates a replacement key. An existing destination, incomplete artifact, missing backup coverage or unreadable credentials is refused. Data copies use the common artifact owner, and configuration is published only with the verified volume. A failed unpublished attempt can be retried; it leaves the source intact. A process killed during staging can leave a private `.local-restore-*` directory beside the destination; the next attempt uses a fresh staging directory.

The recovered native endpoint uses loopback and the selected port. `recovered-from.json` records the source snapshot, whose database digest predates any derived-state reset or startup migrations. Native vectors remain in their copied SQLite table. Hosted snapshots have external vectors, so their readiness receipts and indexing cursors are reset through the embedding owner. The reset preserves knowledge and source revisions, but does not establish semantic-search readiness: native embedding execution is not yet bound ([#1286](https://github.com/goondocks-co/myco/issues/1286)). Starting the destination is separate: `MYCO_HOME=/path/to/fresh-home myco server run --target local` applies pending migrations and starts serving. Configure the GitHub application's callback for the recovered endpoint before testing owner sign-in.

Native lifecycle mutations and the serving process share a volume lease. An operator cannot migrate, remove, rewrite configuration or recover under a process holding that volume. Recovery refuses an existing directory even when no process holds it. Cloudflare replacement restore remains unfinished and explicitly refuses that target; Compose retains its existing procedure. Owner-dashboard additive artifact restore uses the server backup core and is a separate operation. Acceptance still requires source-preserving recovery on the required targets, exact records and blob bytes, independent credential recovery and actual UI/MCP reads before an artifact can authorize a migration-bearing update.
