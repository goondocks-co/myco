---
name: myco:ui-development-and-visual-identity
description: |
  Procedures for building, maintaining, and extending Myco's React daemon UI: the v7 component-composition system (AccentSurface/Panel primitives, page-wide selection state, master-detail and slideout layouts), the Grove-owned appearance system (6 themes, light/dark/system mode, three-role fonts, density), project-scoped request context, auth-gated attachments, and the Team Host degraded-presentation family for attached (hosted) projects. Use when building or troubleshooting UI components, extending the theme/appearance system, wiring project-scoped data, or presenting attached-project degradation, even if the user doesn't explicitly ask for UI development guidance.
managed_by: myco
user-invocable: true
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# UI Development and Visual Identity System

The daemon UI lives in `packages/myco/ui/` (Vite + React + Tailwind, react-router).
It is built on the v7 "Tactile Research" design system: a 6-theme appearance
model and a small set of composition primitives under
`packages/myco/ui/src/components/ui/`. Build new surfaces by composing those
primitives — do not reinvent card chrome, loading gates, or layout shells.

## Prerequisites

- A running daemon (the UI reads/writes through its HTTP API).
- Node.js with npm workspaces; the UI is its own workspace under `packages/myco/ui`.
- Familiarity with `packages/myco/ui/src/components/ui/` (primitives) and
  `packages/myco/ui/src/hooks/` (data hooks over `usePowerQuery`).

## Procedure A: Component Composition (v7 primitives)

Every card/panel derives from **`AccentSurface`**
(`components/ui/accent-surface.tsx`) — the v7 signature chrome (2px coloured
top stripe, `surface-container-low` bg, `outline-variant` border, 12px radius).
Its `accent` is `sage | ochre | terra | outline`. **`Panel`**
(`components/ui/panel.tsx`) wraps `AccentSurface` with a standard
`eyebrow`/`title`/`actions`/`footer` header and a `tone` (`sage | ochre | terra`).

Other primitives in `components/ui/`: `Surface`, `PageContainer`, `PageHeader`,
`SectionHeader`, `Eyebrow`/`IconEyebrow`, `DefRow`, `Badge`, `StatCard`/`MetricCard`,
`SlideoutDetailPanel`, `MasterDetailSplit`, `Pagination`, `PageLoading`, and the
status pills (`daemon-status-pill`, `cortex-status-pill`, `git-identity-pill`).

**Gate loading/error with `PageLoading`** (`components/ui/page-loading.tsx`):
`<PageLoading isLoading={...} error={...}>{children}</PageLoading>` renders a
spinner, a "Failed to connect to daemon" state, or the children — never
hand-roll these three states.

### Exemplary compositions (copy these, verify before citing)

- **`components/grove/DaemonStatusCard.tsx`** — the minimal card recipe:
  `Panel tone="sage"` + `IconEyebrow` + a `<dl>` of `DefRow`s + a `Badge`.
  Read this first when building any status/summary card.
- **`pages/MachineDashboard.tsx`** — page assembly: a `PageContainer` +
  `PageHeader` stacking self-contained cards (`Surface level="low"`, a local
  `Stat` sub-component, `dl` grids). Cards own their own data hook
  (`useDaemon`) and their own loading fallback.
- **`pages/Logs.tsx`** — **page-wide selection state** precedent: a single
  `selectedEntry` state drives both the row highlight (`selectedId` passed into
  the table) and a `SlideoutDetailPanel`; re-clicking the selected row toggles
  it closed. It also hydrates initial filter/selection state from URL query
  params (`new URLSearchParams(window.location.search)`) for deep links. Follow
  this shape for any list-plus-detail page: one selection state at the page,
  passed down as `selectedId` + `onSelect`.

### New component recipe

1. Compose from `AccentSurface`/`Panel` and the existing primitives; match an
   exemplar above rather than inventing chrome.
2. Read data through a hook in `components/ui/hooks/` built on `usePowerQuery`;
   gate rendering with `PageLoading` (or a card-local `if (!data)` fallback).
3. Use theme tokens (`text-on-surface`, `text-on-surface-variant`, `bg-surface-*`,
   `border-outline-variant`, `text-sage`/`text-ochre`) — never hard-coded hex.
4. Keep selection/detail state at the page and pass `selectedId`/`onSelect` down.

## Procedure B: Project-Scoped Data and Selection

Pages that need a project context use the durable selection model in
`packages/myco/ui/src/hooks/use-project-selection.tsx`:

- **`useProjectSelection()` / `useActiveProjectSelection()`** — read the active
  `ProjectSelection | null` from context/durable store.
- **`ProjectSelectionBoundary`** — sets the selection for its subtree. Its
  `persist` prop (default `true`) controls whether entering the boundary writes
  the durable last-known project. Pass **`persist={false}`** for read-only route
  params (redirect targets, machine-scoped pages viewing a specific project) so
  a non-user-facing navigation never clobbers the user's intentional pick.
- **`GlobalSelectionBoundary`** — wraps machine-scoped pages; deliberately sends
  **no** project context headers so they operate machine-wide.
- **`requestContextHeadersFromSelection()`** (`lib/selection.ts`, called by
  `lib/api.ts` on every request) injects **`x-myco-grove-id` / `x-myco-project-id`**
  from the active selection. This is the sole request-scoping mechanism — never
  suppress it.
- **`OperationsScopePill`** (`components/operations/`) — the scope affordance for
  headers of pages where scope is user-selectable.

**Project switcher** — `components/ProjectSwitcher.tsx` is the real switcher.
It reads `useProjectSelection()`, `useGroves()`, and `useProjectsActivity()`,
sorts projects by recent activity, and navigates via the `lib/selection.ts`
path helpers (`projectPath`, `projectRouteSuffix`, `selectionFromLast`) — it does
**not** read route params directly. Reuse those helpers rather than string-building
routes.

**Two bug patterns to avoid:**

1. **Reading route params instead of the durable selection** — the page renders
   the route's project while the durable selection (and therefore the request
   headers) holds a different one. Fix: read `useActiveProjectSelection()` and
   let the boundary wire the selection.
2. **A non-user navigation firing `persist={true}`** — a redirect/background
   route entry overwrites the user's durable project. Fix: `persist={false}` on
   any boundary not driven by an explicit user project-pick.

## Procedure C: Auth-Gated Attachments

Attachment bytes come from a bearer-gated daemon route
(`/api/g/:groveId/p/:projectId/attachments/:file`). A bare `<img src>` cannot
send the `x-myco-auth` header, so always use
`components/ui/attachment-image.tsx`:

```tsx
import { AttachmentImage, useAttachmentObjectUrls } from '../ui/attachment-image';

<AttachmentImage filePath={attachment.file_path} alt="attachment" />
const urls = useAttachmentObjectUrls(attachments.map(a => a.file_path)); // lightbox/raw
```

`AttachmentImage` fetches with the token and renders a blob object URL, resolving
the (Grove, project) scope from the active selection. Never render
`<img src={attachment.file_path}>` — it silently renders a broken image or an
auth-error body as binary garbage.

## Procedure D: Appearance and Theme System

Appearance is **Grove-owned config** (not a local file): the
`AppearanceProvider` (`providers/appearance.tsx`) reads it via `useScopedConfig`
and applies it with `applyAppearance` from `lib/appearance-apply.ts`. Four axes,
whose enum values are the single source of truth in
`packages/myco/src/config/appearance-values.ts`:

- **`theme`** — `sage | moss | terracotta | dusk | plum | slate` (6 themes).
- **`mode`** — `light | dark | system` (toggles the `.light` class on `<html>`).
- **`font`** — `default | geist-mono | system | sf-mono | fira-code | jetbrains-mono`,
  each a three-role stack applied as `--font-heading` / `--font-ui` / `--font-data`
  (the `default` stack is the three-font system: Newsreader / Inter / JetBrains Mono).
- **`density`** — `compact | normal | comfy`, scaling `--density` and root font-size.

Each theme is a CSS file in `packages/myco/ui/src/themes/` defining custom
properties under `:root[data-theme="<name>"]` (dark) and
`:root[data-theme="<name>"].light` (light) — `--primary`, `--on-primary`,
`--secondary`, `--tertiary`, etc. Shared accents live in `themes/_shared-accents.css`.

**Adding a theme:**

1. Create `packages/myco/ui/src/themes/<name>.css` with both the base and
   `.light` blocks (mirror `themes/sage.css`).
2. Add `<name>` to `APPEARANCE_THEMES` in
   `packages/myco/src/config/appearance-values.ts`.
3. Import the CSS in `packages/myco/ui/src/index.css`.
4. Add a `public/favicon-<name>.svg` — `applyAppearance` swaps the favicon per theme.

## Procedure E: Master-Detail and Slideout Layouts

**`MasterDetailSplit`** (`components/ui/master-detail-split.tsx`) is a responsive
shell, not a spacing knob. Real props: `master`, `detail`, `hasSelection`,
optional `onCloseMobileDetail`, `railMinWidthPx`/`railMaxWidthPx`, and the
`masterAriaLabel`/`detailAriaLabel` landmarks. On desktop it renders a fixed-width
rail plus a flex detail pane; on mobile it swaps to a single pane with a Back
button. **The detail pane owns its gutter** (`p-6`) so every consumer renders
flush to the divider — leaf pages must not add their own outer padding.

For a list page where the detail is an overlay rather than a side-by-side pane,
use **`SlideoutDetailPanel`** driven by a page-level selection state — see
`pages/Logs.tsx` (Procedure A).

## Procedure F: Team Host Degraded Presentation (attached/hosted projects)

When a project is **attached** (served by a Team Host), some daemon routes refuse
locally-scoped work. There are exactly **two refusal flavors**, both classified
once in `packages/myco/ui/src/lib/degrade.ts` — never re-derive a check against
`ApiError.body` in a hook or component.

**1. Capability degraded (409) → uniform "unavailable" surface.**
A `degrade`-stamped route (git status, Canopy, release provenance, backup/embedding
mutations, Grove lifecycle) 409s with `{ error: 'capability_unavailable_hosted',
capability, message }`. Detect with `hostedDegradedInfo(err)`; render
**`HostedUnavailable`** (`components/ui/hosted-unavailable.tsx`), whose `variant`
is `panel` (replaces a whole section body) or `inline` (fits inside an existing
card/row). The copy comes from `hostedUnavailableMessage(info)` — never render the
server `message` verbatim.

**2. Attached tenancy pending (404/500) → behave-like-local empty.**
Before an attached project's first forwarded capture registers it host-side,
serve-stamped knowledge reads 404 with `{ error: 'unknown_tenancy' }` (and a
residual carve can 500 with `attached_config_failed`). Detect with
`isAttachedTenancyPending(err, selection)` and map the query to its **existing
empty shape** with `resolveAttachedEmpty(result, selection, empty)` — the same
zero-state a brand-new local project renders. Empty means empty: reuse the hook's
own zero object/list (see the `EMPTY_DATABASE_DETAILS` pattern in
`hooks/use-database-details.ts`), never a bespoke "hosted" placeholder.

**Exactly-two-knob suppression rule.** On the classified refusal, set only two
React Query knobs — `retry: false` and `refetchInterval: false` — and only for
that refusal (keyed off the same detector). **Never touch
`refetchOnWindowFocus` / `refetchOnMount` / `retryOnMount`: those are the recovery
path.** Once registration lands, a page reload or re-selection re-mounts the query
and it repopulates. Reference implementations:

- `hooks/use-git-identity.ts` — the 409 pattern:
  `refetchInterval: (q) => hostedDegradedInfo(q.state.error) ? false : POLL...`
  and `retry: (n, err) => hostedDegradedInfo(err) ? false : n < 3`.
- `hooks/use-database-details.ts` — the tenancy pattern: the same two knobs keyed
  on `isAttachedTenancyPending`, wrapped in `resolveAttachedEmpty`.

**Classifier precision is load-bearing.** Real outages must keep real error
presentation: a host outage (`host_unreachable` 503, `host_auth_rejected` 502),
any relay 5xx, a network error that never became an `ApiError`, any *other* 404,
and every refusal on a **non-attached** project all classify as false. Do not widen
the detectors to "any 409" or "any 404" — that silently hides genuine failures
behind a fake empty page.

**Membership copy vocabulary** (`lib/membership-copy.ts`; the copy doctrine is
recorded as a Myco decision spore — search "UI copy user vocabulary" to retrieve
it): map known failure codes to **user-outcome** sentences that
reference the UI's own affordances ("its host card has a Detach control"), not the
daemon's CLI-voiced message or raw error codes. Host-facing surfaces carry **zero
"grove" strings** — the only permitted use is the member's *own* local Grove picker
(`LOCAL_GROVE_PICKER_LABEL = "Show under"`). Proactive suppression that keys on the
attached selection directly (not an error response) gets its own plain line — e.g.
`BACKUPS_HOSTED_LIST_NOTICE`, which replaces the localhost-only backups *list* so it
never shows the member's local backups as if they were the team project's.

Provenance for the above (verify against source, not this list): the classifier and
shared empty mapper landed in T4a (`0cec8e1b`); the attached knowledge-read hooks in
T4bcd (`b1949b43`); the Operations/Canopy/provenance `HostedUnavailable` wiring in
T5a–d (`3df07097`, `e30785f6`, `d9ee7493`, `e3c59411`).

## Cross-Cutting Gotchas

### Appearance paints from a pre-bootstrap cache
`applyCachedAppearance()` (`lib/appearance-apply.ts`) replays the last-applied
values from `localStorage['myco-appearance']` synchronously in `main.tsx` before
React mounts, so the chosen theme paints on the first frame. When developing
themes, browsers cache CSS aggressively — hard refresh (Cmd+Shift+R).

### UI workspace install in worktrees
Each git worktree needs its own `npm install` in `packages/myco/ui` (and the UI
build must run before dogfooding a worktree daemon). Follow the **`dogfood-worktree`**
skill rather than a bespoke setup script — the worktree's runtime does not travel
with `git worktree add`.

### Layout primitives own spacing
`MasterDetailSplit`'s detail pane and `Panel`'s body own their gutters. Leaf pages
must not apply conflicting outer margin/padding — it double-pads or breaks the
flush-to-divider alignment.

### Request context headers are `x-myco-*-id`
Grove/project scoping rides on **`x-myco-grove-id` / `x-myco-project-id`**, injected
by `requestContextHeadersFromSelection()` in `lib/api.ts` — not slug headers. A page
that bypasses the selection model (or a machine-scoped page that forgets
`GlobalSelectionBoundary`) leaks or omits the wrong scope.

### Navigate via react-router, not `window.location`
Use `useNavigate`/`useLocation`/`useSearchParams` for navigation and URL state so
`MemoryRouter` (tests, embedded contexts) works. Reading `window.location.search`
once for initial deep-link hydration (as `pages/Logs.tsx` does) is fine; driving
navigation off `window.location` is not.

### Attachment routes are auth-gated
Never render attachment images with a bare `<img src>` — use `AttachmentImage`
(Procedure C). The route requires `x-myco-auth`, which an `<img>` can't send.

### Durable selection vs route selection
Route params change every navigation; the durable selection persists until the user
picks a new project. Machine-scoped pages wrap with `GlobalSelectionBoundary` (no
project headers); a specific-project view that must not overwrite the user's pick
uses `ProjectSelectionBoundary persist={false}`.

### UI embed build order is strictly sequential
`build:ui` must run before `codegen`, which must run before `build:binary`
(`packages/myco/package.json`: `build:ui && codegen && … && build:binary`). The
`codegen` step runs `packages/myco/scripts/gen-ui-assets.ts`, which reads the
Vite-compiled output and generates `packages/myco/src/ui-assets.generated.ts` — the
file that embeds the React bundle into the binary. If codegen runs before the Vite
build, it emits a stale/empty asset map and silently ships a binary with no UI.
Always run the full `npm run build`.
