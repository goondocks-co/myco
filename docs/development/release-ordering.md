# Release ordering

Publish the stable or next tag before deleting old prerelease tags. Removing a prerelease before its replacement exists must not force installed machines onto an older stable release.

Releases require green main-push CI on the exact tagged SHA. Alpha tags may be cut from main only after that gate passes. Keep the [plugin version preparation](plugin-versioning-1709.md) in the release preparation commit.
