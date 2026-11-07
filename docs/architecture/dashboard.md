# Dashboard conventions

The Deployment's dashboard (`packages/myco-server/ui/`) is one React app on TanStack Query. These are the patterns a
new page follows. Each one has a gate.

## Build from the design system

Controls and patterns come from `ui/src/design` (`Card`, `ListRow`, `HealthDot`, `StatusChip`, `ReadState`, …),
imported through `ui/src/design/index.ts`. A missing primitive is added there, never inside a feature folder.
Copy is in the reader's words. `tests/meta/server-ui-vocabulary.test.ts` and `server-reader-vocabulary.test.ts` hold
every visible string to that.

## Live data: one heartbeat, marks, and nothing else on a clock

`ui/src/lib/live.ts` is the only place a refresh interval is set (`tests/meta/dashboard-live-refresh.test.ts`). A page
declares how fresh each read must be by spreading `live(...)` into `useQuery`:

| Freshness | Use it for | What it costs |
|---|---|---|
| `{ follows: ['runs' \| 'sessions' \| 'fleet'] }` | Any read that shows what is happening now: Today, Myco's work, sessions, status, Needs you, runners | Re-read only when the heartbeat says that mark moved. Never by the clock. |
| `{ whileMoving: (data) => boolean }` | One small read of one thing in motion, such as an open running run or an embedding switch under way | Every `MOVING_MS` (10 s) while its own answer says it moves. `quick` is every `QUICK_MS` (2 s), for a check a person just asked for. |
| `'heavy'` | Measures and anything else that aggregates long windows (`/api/kpis`) | Read once when shown. No clock, no tab-return refetch, no heartbeat. Only a person asks again. |
| `'still'` | A past window, which cannot change | Never re-read on its own. |

**The heartbeat** is `GET /api/work/now`, read by `LiveRefresh` (`ui/src/hooks/use-live.tsx`). It is mounted once, in
the shell, for the page's scope: the project in the path, or every project. It is read every `TICK_MS` (30 s), or every
`RUNNING_TICK_MS` (10 s) while something runs, and never while the tab is hidden. Its answer carries `marks`:

- `runs` moves when a run starts, finishes, queues or fails.
- `sessions` moves when capture arrives.
- `fleet` moves when a runner comes, goes, pauses or takes a run.

When a mark moves, `LiveRefresh` invalidates only the open queries that follow it.

**Per-tick read budget.** A visible page makes one heartbeat read per tick. That read is a set of bounded seeks with
tested ceilings (`tests/myco-server/work-now-read-ceilings.test.ts`). Measured on a store with 25,000 finished runs,
5,000 queued runs and 5,000 sessions: about 50–80 rows for one project, and about 480–560 for every project. The
ceilings are about 320 and 1,500.

A page may add at most one `whileMoving` read, and only for a single record in motion. Follower reads run only when
their mark moves, never every tick. A heavy read never runs on a tick. A page must not fire several heavy reads in
parallel on any trigger. On the owner's Deployment, Health's measures alone read about 4M rows beside eight other
reads, exceeded D1's per-database time budget, and made the other panels fail.

**Unattended pages.** `fetchJson` sends `x-myco-unattended: 1` when no one has used the dashboard for `PRESENCE_MS`
(a minute without a key, pointer, scroll or the tab coming back into view). The server leaves no activity stamp for
such a request (`core/activity.ts`). A page refreshing itself in front of no one therefore never keeps the
Deployment awake, and never starves work that waits for an idle Deployment.

## Activity: one read model, many scopes, one component

"What is Myco doing now" is answered by one server module, `src/read/work-now.ts` (`readWorkNow`). It takes a scope:
one project, or every visible project. It answers:

- **Running now:** each live run with its task, machine, model, start, and latest step. The step is worded by
  `@goondocks/myco-shared/step-words`, the same function the run panel uses.
- **Waiting:** queued and due work, each with the server's own reason. Reasons come from a queued run's stored holder
  (`holdSentence`), the fleet's current wait (`fleetWaits`, the rule the queue and claim decide by), learning's status
  line (`learningStatusLine`, also shown on Health), the curation daily limit, the code map's schedule, the rolling
  budget, and a backup holding the database.
- **Needs you:** failures with the failing run's own refusal text, a failing curation group with when Myco tries
  again, and a runner that cannot sign in. An item clears when a later run of the same task succeeds, the group is
  decided, or the runner's readiness changes.

The dashboard renders it with one component, `features/now/WorkNow.tsx`. It appears at the top of Myco's work for a
project or every project, and on Health for the whole Deployment. The UI never decides why something waits. It prints
`why`. A new reason is added in `read/work-now.ts`, next to the fact that decides it.
