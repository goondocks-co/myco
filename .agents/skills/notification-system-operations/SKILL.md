---
name: myco:notification-system-operations
description: |
  Use when extending the Myco notification system with a new domain, configuring
  notification modes, diagnosing missing or misbehaving notifications, or fixing
  React UI issues related to notifications — even if the user doesn't explicitly
  ask for notification system help. Covers: domain self-registration and default
  configuration; the mode resolution priority chain (payload > domain override >
  global default > registry default) and its critical gotcha; emission point
  discipline with a coverage checklist; the SystemNotifications.tsx banner-only
  filter requirement; dismissed-vs-deleted semantics and the full debug protocol;
  React Router same-URL navigation fix for notification clicks; and schema design
  with on-write pruning. Complements extend-myco-daemon (which covers wiring
  steps) with operational semantics and failure-mode playbooks.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Myco Notification System: Configuration, Wiring, and Debugging

This skill covers the operational semantics of the Myco notification system — the gotchas, configuration rules, and debug protocols a developer needs when extending, configuring, or diagnosing notification domains. For the mechanical wiring steps (registry → emission → display → React hook), see `extend-myco-daemon`. This skill is additive: it documents what goes wrong, how to configure correctly, and how to diagnose failures.

## Prerequisites

- The daemon is running and accessible.
- You understand basic notification domain wiring (see `extend-myco-daemon`).
- You have access to `src/daemon/` and `src/ui/` source trees.

## Procedure 1: Domain Registration and Defaults

Register a new notification domain using the self-registration API. The registry entry establishes the **lowest-priority fallback** defaults for the domain.

```typescript
// src/daemon/notifications/registry.ts (or domain-specific file)
notificationRegistry.register({
  domain: 'version_sync',
  defaultMode: 'banner',       // 'banner' | 'summary' | 'none'
  defaultTitle: 'Version Sync',
  defaultIcon: '🔄',
  description: 'Notifies when a version sync event occurs',
});
```

**Critical constraint:** Registry defaults are the LOWEST-priority fallback. Set `defaultMode` to a safe last-resort value. The mode resolution chain (Procedure 2) means users can override your defaults through config — but only if registry values don't accidentally win over global config.

Verify registration by checking the registry dump at daemon startup or via a debug endpoint. The domain should appear with your specified defaults.

## Procedure 2: Mode Resolution Chain (Critical Gotcha)

The notification mode for any emission resolves in this exact priority order, highest to lowest:

```
1. payload.mode        — per-emission override (highest priority)
2. domain override     — per-domain config in myco.yaml
                         (e.g., notifications.domains.version_sync.mode)
3. global default      — global config in myco.yaml
                         (e.g., notifications.defaultMode)
4. registry default    — value from notificationRegistry.register() (lowest priority)
```

**The gotcha shipped in production:** The original implementation evaluated `registry default > global default`, making project-level `notifications.defaultMode` settings completely inert. A user who configured `defaultMode: 'none'` globally would still receive banners from any domain whose registry default is `'banner'`.

When implementing or reviewing mode resolution, locate the resolver function (typically `src/daemon/notifications/resolver.ts`) and verify the fallback chain:

```typescript
function resolveMode(payload, domainConfig, globalConfig, registryEntry) {
  return (
    payload?.mode ??
    domainConfig?.mode ??
    globalConfig?.defaultMode ??
    registryEntry?.defaultMode ??
    'banner'  // hard fallback if all else is undefined
  );
}
```

If you see `registryEntry?.defaultMode ?? globalConfig?.defaultMode`, that is the bug — flip the order.

**Verification:** Set `notifications.defaultMode: 'none'` in `myco.yaml` and trigger a domain emission. If a banner still appears, the resolution chain is inverted.

## Procedure 3: Emission Point Discipline

Every state-transition code path that should generate a notification needs an explicit emission call. Missing emission points are the most common cause of "notifications never show up."

### Coverage checklist

For each notification domain, verify emission points exist at:

- [ ] The primary success path (e.g., sync completes)
- [ ] The error/failure path (if the domain notifies on failure)
- [ ] **Daemon restart / cleanup code** — this is a separate branch, frequently missed. Search shutdown and restart handlers explicitly; they are not covered by the main request handler path.
- [ ] Any async callback or event handler that transitions state outside the main request path

```typescript
// Example: daemon restart cleanup — the forgotten emission site
async function cleanupOnRestart() {
  // Emit BEFORE clearing state
  await notificationService.emit({
    domain: 'version_sync',
    title: 'Daemon restarted',
    body: 'Version sync state was reset.',
  });
  await clearSyncState();
}
```

### Finding missed emission points

```bash
# All files referencing the domain
grep -r "version_sync" src/daemon/ --include="*.ts" -l

# Files that actually call emit() for the domain
grep -r 'emit.*version_sync\|domain.*version_sync' src/daemon/ --include="*.ts" -l
```

Files in the first list but not the second are candidates for missing emission points.

## Procedure 4: SystemNotifications.tsx Banner-Only Filter

`SystemNotifications.tsx` (the browser notification bridge) **must** query only notifications with `mode: 'banner'`. Fetching all unread notifications is the wrong pattern.

**Why:** Summary-mode notifications are intended for the drawer/panel UI only. An all-unread query triggers browser popups for summary items, defeating the purpose of summary mode and creating noise.

```typescript
// Correct — filter for banner mode only
const { notifications } = useNotifications({ mode: 'banner', unread: true });

// Wrong — triggers browser notifications for summary items too
const { notifications } = useNotifications({ unread: true });
```

**When adding a new domain with `defaultMode: 'summary'`:** verify that this domain's notifications do NOT appear as browser popup notifications. If they do, SystemNotifications.tsx is missing the mode filter.

This is a recurring pattern failure. Any time you touch the notification query in SystemNotifications.tsx, confirm the `mode: 'banner'` filter is present. Leave a comment marking it as intentional.

## Procedure 5: Dismissed-vs-Deleted Semantics

Notifications are **never deleted** from the database. When a user dismisses a notification (clears the drawer), the row is marked `dismissed: true` and stays in the table.

**Implications:**
- An empty notification drawer does NOT mean no notifications were emitted.
- Queries for "active" notifications must filter `WHERE dismissed = false`.
- The default notification hook must exclude dismissed items.

```typescript
// Correct
db.query(`SELECT * FROM notifications WHERE dismissed = false ORDER BY created_at DESC`);

// Wrong — returns dismissed items as if they were active
db.query(`SELECT * FROM notifications ORDER BY created_at DESC`);
```

If a notification hook returns an empty array but you expect items, check the dismissed column before assuming an emission failure (see Procedure 6).

## Procedure 6: Notification Debug Protocol

When a notification is missing, misbehaving, or displaying incorrectly, follow this sequence:

### Step 1: Check dismissed state first

```bash
# In the daemon SQLite shell or via a debug endpoint
SELECT id, domain, title, mode, dismissed, created_at
FROM notifications
WHERE domain = 'version_sync'
ORDER BY created_at DESC
LIMIT 20;
```

If rows exist with `dismissed = true`, the notification was emitted but dismissed (by the user or by an automated cleanup). Not an emission failure.

### Step 2: Verify emission points

Trigger the state transition and watch daemon logs for an emission log line. If no log appears, the emission point is missing (Procedure 3).

### Step 3: Check mode resolution

If the row exists with `dismissed = false` but no notification appeared, check the `mode` column. If mode is `'summary'` when you expected `'banner'`, trace the resolution chain (payload → domain config → global config → registry default) to find the wrong value.

### Step 4: Check the banner filter

If mode is `'banner'` and the browser notification still didn't fire, verify that SystemNotifications.tsx queries with `mode: 'banner'` (Procedure 4).

### Step 5: Canonical smoke test

Use `restart-reason.json` → `version_sync` notification as the end-to-end smoke test for any new notification domain:

1. Write a `restart-reason.json` file with the appropriate payload.
2. Restart the daemon.
3. Confirm a `version_sync` notification appears in the drawer.
4. Confirm it appears as a browser notification only if mode resolves to `'banner'`.

This exercises the full path: emission on restart → mode resolution → storage → React hook → UI display.

## Procedure 7: React Router Same-URL Navigation Fix

When a notification click navigates to the URL the user is already on, React Router will NOT fire a navigation event — the location is current, so no re-render occurs and the page appears to do nothing.

**Fix:** Include a timestamp in `location.state` to force React Router to treat it as a distinct route entry even when the pathname is identical.

```typescript
// Notification click handler
function handleNotificationClick(notification: Notification) {
  navigate(notification.targetPath, {
    state: {
      notificationId: notification.id,
      navigatedAt: Date.now(),  // forces a distinct route entry
    },
  });
}
```

The destination component can read `location.state.navigatedAt` to detect notification-driven navigations and trigger side effects (scroll to item, refresh data, highlight row, etc.).

**When to apply:** Any notification that links to a page the user may already be viewing — common for session-level and graph-view notifications.

## Procedure 8: Schema Design with On-Write Pruning

The notifications table uses on-write pruning to bound its size. There is no cron job or background cleanup.

**How it works:** Each `INSERT` triggers a pruning step that deletes the oldest rows for that domain when the count exceeds the domain's configured limit.

```typescript
async function emitNotification(payload: NotificationPayload) {
  await db.insert('notifications', payload);

  const limit = getDomainLimit(payload.domain); // e.g., 100
  await db.run(`
    DELETE FROM notifications
    WHERE domain = ? AND id NOT IN (
      SELECT id FROM notifications
      WHERE domain = ?
      ORDER BY created_at DESC
      LIMIT ?
    )
  `, [payload.domain, payload.domain, limit]);
}
```

**Trade-offs:**
- ✅ No background job required; table stays bounded automatically.
- ✅ Simple to reason about — pruning is co-located with the write.
- ⚠️ High-frequency domains trigger pruning on every write. If pruning is a bottleneck, consider batching or periodic compaction.
- ⚠️ Pruned rows are permanently gone — dismissed items and old items share the same retention budget.

When registering a new domain, set a sensible per-domain row limit. Default to 50–100 rows for low-frequency domains.

## Cross-Cutting Gotchas

| Gotcha | Symptom | Fix |
|--------|---------|-----|
| Resolution chain inverted | Project-level `defaultMode` ignored | Verify `globalConfig` comes before `registryEntry` in the fallback chain |
| Empty drawer ≠ no emissions | Debugging emission when notifications were just dismissed | Check `dismissed` column before touching emission code |
| Restart cleanup missed | Notifications fire on normal use but not on daemon restart | Add explicit emission call in shutdown/restart handler, before state clear |
| Banner filter drift | Summary-mode items trigger browser popups | Re-add `mode: 'banner'` filter to SystemNotifications.tsx query |
| Same-URL navigation silently dropped | Notification click appears to do nothing | Add `navigatedAt: Date.now()` to `location.state` in navigate call |
