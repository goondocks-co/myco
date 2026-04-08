---
name: myco:wire-notification-emission
description: Use this skill whenever you are adding live notification output to a Myco domain — digest, skill lifecycle, sync, embedding, or any other subsystem — even if the user only says "hook up notifications for X" or "make X emit a banner." The full notification infrastructure (registry, API, UI hooks) already exists but zero domains are wired as emitters. This skill walks through the exact four steps needed to go from silent infrastructure to a working emitter: registering the type, emitting at the event point, verifying three-tier display resolution, and confirming React hook wiring on the UI side. Apply this skill even if the user doesn't explicitly ask for the full procedure — partial wiring (emit without register, or UI wiring without emission) is a common failure mode that this skill prevents.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Wire a Notification Emission Point into a New Domain

## When to Use

Apply this skill whenever you're wiring a new domain into Myco's notification system — even if the request is as simple as "make the digest task emit a notification when it's done." Zero domains currently emit notifications. The infrastructure is complete; nothing is wired. You are starting from scratch, not extending a working example.

**Triggers:** "hook up notifications for X", "make X emit a notification/banner", "add notification when X completes", "wire up notification for [domain]"

**Does not apply:** Modifying the notification API, schema, or registry infrastructure itself — those are architecture changes, not emission wiring.

---

## Step 1: Register the Notification Type at Domain Startup

In the domain's initialization code (wherever it runs at daemon startup), call `notificationRegistry.register()` once per notification type:

```typescript
notificationRegistry.register({
  type: 'myco.digest.completed',   // namespace: myco.<domain>.<event>
  defaultDisplay: 'banner',         // 'banner' or 'summary' — do not use 'toast'
  label: 'Digest Completed',        // human-readable name shown in the settings UI
  description: 'Fired when the digest task finishes writing a tier.',
});
```

**Naming convention:** Always `myco.<domain>.<event>` — e.g., `myco.skill.generated`, `myco.sync.conflict`, `myco.digest.completed`.

**Gotcha: `register()` must precede any `emit()` call.** The registry lookup inside `emit()` throws if the type was never registered. Daemon initialization order matters — register in the module's startup function, not lazily on first emit.

**Idempotent:** Safe to call on every daemon restart. The registry is in-memory and rebuilt each time, so duplicate calls after restart are not a concern.

There are 9 types registered across 4 domains: agents (2), sessions (2), skills (3), mycelium (2). All use the same `register()` pattern.

---

## Step 2: Emit at the Event Point

After the meaningful work completes, call `notificationService.emit()`:

```typescript
// Inside the function that completes the domain work:
await notificationService.emit({
  type: 'myco.digest.completed',
  payload: {
    tier: tierId,
    wordCount: result.wordCount,
  },
  // Omit `display` unless you have a specific reason to override the registry default
});
```

**Do not hardcode `display` in the emit call.** The three-tier priority chain resolves the display mode automatically (see Step 3). Hardcoding `display: 'banner'` bypasses the chain and prevents users from configuring notification behavior.

**Only set `display` at emit time if the notification must always be silent:**

```typescript
await notificationService.emit({
  type: 'myco.digest.heartbeat',
  payload: { ... },
  display: 'silent',  // Suppress banners for high-frequency background events
});
```

**Payload shape is flexible.** The `payload` field is untyped — pass whatever context the notification consumer needs. Keep it small; it's persisted to the `notifications` SQLite table with 30-day auto-pruning.

---

## Step 3: Verify Three-Tier Display Resolution

The notification system resolves the final display mode using this priority chain:

| Priority | Source | When it applies |
|----------|--------|-----------------|
| **1 (highest)** | Global UI setting | User has set a global override in Settings → Notifications |
| **2** | Registry `defaultDisplay` | The value you set in `register()` in Step 1 |
| **3 (lowest)** | Per-emit `display` override | Value passed in `notificationService.emit()` in Step 2 |

Higher priority wins. For most domains: set `defaultDisplay` in the registry (Step 1) and omit `display` in the emit (Step 2). The user's global setting will override your registry default.

**Valid display values:**
- `'banner'` — top-right stacked cards, max 3 visible, 8s auto-dismiss, slide-in animation
- `'summary'` — persistent right panel drawer (w-96, up to 50 items, bulk actions, escape-to-close)
- `'silent'` — no UI output; stored to the notifications table but not surfaced

**Note:** Banner notifications also appear in the summary panel. `summary` is a superset — all banner events are also stored and visible in the panel. If `defaultDisplay` is `'banner'`, users will see it in both places.

---

## Step 4: Confirm React Hook Wiring on the UI Side

The React notification layer uses three distinct hooks — each serves a different purpose and they are intentionally kept separate:

| Hook | Purpose | Notes |
|------|---------|-------|
| `useNotifications()` | Fetch the full notification list for the panel | Called when the notification drawer opens |
| `useUnreadCount()` | Poll the unread count for the header bell badge | Lightweight — polls `/api/notifications/unread-count` on an interval; does NOT fetch notification records |
| `useNotificationRegistry()` | Read declared notification types for the settings UI | Read-once; the registry is static after daemon startup |

**Why the split?** `useUnreadCount()` uses a lightweight count endpoint so the badge stays fresh without fetching 50+ notification records on every poll tick. `useNotificationRegistry()` reads declared types — it auto-generates per-domain toggles in Settings without requiring any hardcoded config sections.

For a new domain, verify:
1. The new notification type appears in the `useNotifications()` stream when `notificationService.emit()` is called
2. The unread badge count increments via `useUnreadCount()`
3. The type appears as a configurable option in Settings → Notifications (via `useNotificationRegistry()`)

---

## Common Pitfalls

**No working example exists.** Don't search the codebase for an existing domain that calls `emit()` — you won't find one. All 4 domains have registered types via `register()` but none have wired an emit point. You are implementing the first emitter.

**`register()` is not lazy.** The registry lookup on `emit()` throws if the type was never registered. Do not call `register()` inside the `emit()` path as a lazy fallback — declare all types at daemon startup.

**"toast" is not a valid display mode.** The two rendering modes are `'banner'` and `'summary'`. Using `'toast'` will fail silently with an unknown mode default — use the documented values.
