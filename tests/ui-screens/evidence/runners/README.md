# Runners browser evidence

These are local, persisted synthetic fixtures served through the native front door and the built dashboard. Machine names are fixture labels, not observations of the live Deployments.

[Full light page](light-fleet.png) · [Full dark page](dark-fleet.png)

[Narrow light page](light-narrow.png) · [Narrow dark page](dark-narrow.png) · [Narrow light legacy](light-narrow-legacy.png) · [Narrow dark legacy](dark-narrow-legacy.png)

Health touch-size checks: [tablet light](admin-health-tablet-light.png) · [tablet dark](admin-health-tablet-dark.png) · [phone light](admin-health-phone-light.png) · [phone dark](admin-health-phone-dark.png) · [desktop light](admin-health-desktop-light.png) · [desktop dark](admin-health-desktop-dark.png).

| State | Light | Dark |
| --- | --- | --- |
| Busy without contact | [Screenshot](light-busy.png) | [Screenshot](dark-busy.png) |
| Online | [Screenshot](light-idle.png) | [Screenshot](dark-idle.png) |
| No signed-in agent | [Screenshot](light-empty.png) | [Screenshot](dark-empty.png) |
| No registered runners | [Screenshot](light-empty-fleet.png) | [Screenshot](dark-empty-fleet.png) |
| Settling | [Screenshot](light-settling.png) | [Screenshot](dark-settling.png) |
| Paused and draining | [Screenshot](light-paused.png) | [Screenshot](dark-paused.png) |
| Removed | [Screenshot](light-removed.png) | [Screenshot](dark-removed.png) |
| Offline | [Screenshot](light-stale.png) | [Screenshot](dark-stale.png) |
| Never contacted | [Screenshot](light-never.png) | [Screenshot](dark-never.png) |
| Unknown reports | [Screenshot](light-unknown.png) | [Screenshot](dark-unknown.png) |
| Failed read | [Screenshot](light-unavailable.png) | [Screenshot](dark-unavailable.png) |
| Member read-only | [Screenshot](light-member.png) | [Screenshot](dark-member.png) |
| Revoked member session | [Screenshot](light-revoked-session.png) | [Screenshot](dark-revoked-session.png) |
| Offline legacy worker in Health | [Screenshot](light-health-legacy.png) | [Screenshot](dark-health-legacy.png) |
| Expanded runner details | [Screenshot](light-details.png) | [Screenshot](dark-details.png) |
| Replacement review in Runners | [Screenshot](light-replacement-review.png) | [Screenshot](dark-replacement-review.png) |
| Replacement review at /device | [Screenshot](light-device-replacement.png) | [Screenshot](dark-device-replacement.png) |
| Forget confirmation | [Screenshot](light-forget-confirmation.png) | [Screenshot](dark-forget-confirmation.png) |

Regenerate after building the dashboard, from an isolated scratch working directory with isolated HOME and harness homes:

```sh
RUNNER_SHOTS_DIR=/your/scratch/screenshots bun run /path/to/myco/tests/ui-screens/runners.browser.ts
```

The browser checks every state, collapsed details, replacement previews, 390 px overflow and 44 px tap targets, member control absence, revoked-session refusal, unavailable reads, and forgetting in Health followed by disappearance from Runners. It closes its browser and native server.

[Mutation results](mutations.json): thirteen caught mutants, including the six correction mutants for contact history, replacement name and identity, malformed update metadata, member recredentialing, and the D1 read budget. Each source mutation was restored and followed by a passing baseline. The original successful-empty-fleet mutant ran in an isolated scratch copy.
