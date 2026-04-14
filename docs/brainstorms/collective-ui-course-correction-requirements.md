---
date: 2026-04-13
topic: collective-ui-course-correction
---

# Collective UI Course Correction

## Problem Frame
The hosted Collective UI in `packages/myco-collective/ui/` currently behaves like a separate product instead of an extension of Myco. It uses a bespoke shell, one-off tokens, and hardcoded component styling while the daemon UI in `packages/myco/ui/` already defines the visual and interaction language users associate with Myco. The result is a functional but off-brand operator surface where layout quality is inconsistent, long content stresses the composition, and the core search flow returns raw JSON instead of an interface that helps an operator understand, compare, and act on results.

This correction needs to make the Collective UI feel like the same product family as the daemon UI while preserving a Collective-specific accent palette and hosted-product identity.

## Requirements

**Design System Alignment**
- R1. The Collective UI must adopt the same application-shell patterns as the daemon UI: persistent left navigation, collapsible shell behavior where appropriate, shared spacing rhythm, page header hierarchy, and familiar panel/card structure.
- R2. The Collective UI must stop depending on page-local hardcoded visual values for core surfaces, text, borders, radii, and controls. Its theme must be expressed through reusable Myco-style tokens, with a Collective-specific palette layered on top.
- R3. Authentication, loading, empty, and error states must look and read like Myco product surfaces rather than a separate microsite.
- R4. Collective-specific visual differentiation is allowed, but it must come from palette, highlights, and content treatment rather than a separate component language.

**Layout Robustness**
- R5. Primary pages in `packages/myco-collective/ui/src/pages/` must hold their layout at standard desktop and mobile widths without controls or content running outside their containers.
- R6. Long project names, URLs, hashes, and result metadata must wrap, clamp, truncate, or scroll intentionally instead of breaking card layouts.
- R7. Forms, summaries, and list/detail surfaces must use consistent field sizing, action placement, and vertical rhythm across Dashboard, Projects, Settings, and Search.

**Search Experience**
- R8. Search must become the main operator workflow, not a transport-debug screen. The primary result presentation must be readable result cards or rows with clear titles, source context, project attribution, relevance cues, and lightweight previews.
- R9. Search must preserve the Collective contract around partial failure: failed workers remain visible and attributable without blocking successful results.
- R10. Raw JSON must be demoted to a secondary inspection path, such as an expandable details panel, inspector drawer, or explicit “view raw record” affordance.
- R11. Search results must support fast operator scanning across projects, with grouping, ordering, and metadata that make project-level differences obvious.
- R12. Collective search should use a hybrid master-detail pattern: aggregated results stay on the search surface, while additional record detail opens in a contextual inspector or slide-out when available.
- R13. When a result has a meaningful project-local destination, the Collective UI should expose that as a secondary deep-link action rather than making it the only way to inspect the hit.

**Delivery and Verification**
- R14. The redesign must be verified in-browser against the daemon UI shell and against the Collective UI at desktop and mobile widths before shipping.
- R15. The work must happen in a dedicated worktree and remain isolated from unrelated monorepo changes until the hosted UI correction is ready.

## Success Criteria
- The Collective UI is immediately recognizable as Myco when viewed beside the daemon UI.
- Operators can navigate the Collective UI without encountering overflow, broken sizing, or visibly mismatched components.
- Search results are understandable without reading raw JSON first.
- Operators can inspect a result in-place without losing their cross-project search context.
- Partial failures remain visible without dominating the search surface.
- Desktop and mobile browser checks pass for auth, dashboard, projects, settings, and search.

## Scope Boundaries
- No auth model change is required; the existing bearer-token flow stays in place unless UI polish reveals a minor presentation issue.
- No new Collective feature areas are required beyond the existing auth, dashboard, projects, settings, and search surfaces.
- Backend contract changes are out of scope unless the current search payload is missing a minimal field required to render usable result cards.
- This effort is not a ground-up rebrand for Myco; it is a design-system alignment and operator UX correction.

## Key Decisions
- Design-system convergence comes first: the Collective UI should borrow from `packages/myco/ui/` before inventing new component patterns.
- The Collective keeps a warmer hosted-control-plane palette, but the underlying UI language remains Myco.
- Search redesign should prioritize readable summaries and operator workflows, with raw records available only as a secondary inspection path.
- Collective search should use an in-place inspector as the default detail affordance because the user is browsing across teams and projects, not operating inside a single project context.
- Deep links into project-local destinations should be offered when available, but they should be additive actions from the inspector rather than the primary interaction model.
- Browser validation is part of the feature, not an optional cleanup step.

## Dependencies / Assumptions
- `packages/myco/ui/` is the current source of truth for Myco shell, tokens, and common interaction patterns.
- The current Collective API can already supply enough information to render better result cards, or can be extended with small response-shaping changes if a specific field is missing.
- The worktree `codex/collective-ui-course-correct` is the execution branch for this effort.

## Outstanding Questions

### Resolve Before Planning
- None.

### Deferred to Planning
- [Affects R1,R2][Technical] Should the first pass extract shared shell primitives between `packages/myco/ui/` and `packages/myco-collective/ui/`, or should Collective first adopt the daemon patterns locally and deduplicate after the design stabilizes?
- [Affects R8,R10,R11,R12,R13][Technical] Does the current `collective_search` response already provide enough typed metadata for both a proper result card and an in-place detail inspector, or should the plan include a minimal response-normalization layer in the Collective UI?
- [Affects R14][Needs research] What is the thinnest repeatable browser-verification workflow for the hosted Collective UI once the local redesign is implemented?

## Next Steps
-> `/ce:plan` for structured implementation planning
