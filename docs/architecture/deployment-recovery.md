# Deployment recovery artifacts

`myco server backup --target local|cloudflare --to <directory>` captures the selected Deployment without applying migrations. The local target uses SQLite `VACUUM INTO`, including committed WAL data. The Cloudflare target uses the operator's existing Wrangler login and an explicitly bound D1 database; it exports ordinary tables and `sqlite_sequence`, reconstructs the source's indexes, views, triggers and external-content FTS indexes, and refuses schema drift. Cloudflare temporarily pauses database queries during its export. R2 objects stream through the operator process using an in-memory credential obtained with `wrangler auth token --json`; credential disk logging is disabled, redirects are refused and a rejected credential is refreshed at most once per object.

Both targets use one artifact writer. The directory contains:

- `myco.sqlite`: a closed database snapshot, checked for integrity, foreign keys and required captured-content references.
- `blobs/<project>/<sha256>`: every object registered in that snapshot, verified against its size and digest.
- `recovery.json`: source target and identity, schema version, capture timestamps, database digest, blob totals, the operator's configuration record and required independent credentials.

Cloudflare provisioning and rendered bindings use the record's Worker, database, bucket, vector-index and wrapping-secret names. Existing records that omit `vectorIndexName` or `wrapKeySecretName` retain the default names. A recovery record can name separate resources; the record must also name the recovery destination's URL rather than the original live route. Choosing those resources does not copy data, recover credentials or rebuild their contents.

The manifest advances from `snapshot` to `content` to `complete`. A failed copy stays incomplete. Running the same command against the same source and directory resumes the saved snapshot and verifies existing bytes before reusing them. A completed artifact is verified without refreshing its contents; use a new directory for another recovery point. A different source or an unrelated nonempty directory is refused. One process holds the destination lock at a time.

`complete` means the data artifact passed verification. It does not establish that independent credentials exist, that an external vector index has been rebuilt, or that a replacement Deployment works. Keep the original wrapping key, session secret and GitHub application credentials in separate secure recovery storage. Wrangler credentials stay on the operator's machine and are not copied into the artifact or Deployment. The database itself contains private project data and encrypted settings; treat the directory as private.

The native local and Cloudflare full-replacement restore command remains unfinished and explicitly refuses those targets. Compose retains its existing restore procedure. Owner-dashboard additive artifact restore uses the server backup core and is a separate operation. Acceptance requires a source-preserving recovery into a disposable destination, exact records and blob bytes, independent credential recovery and actual UI/MCP reads before this artifact can authorize a migration-bearing update.
