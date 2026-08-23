# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`.
- **Read an issue**: `gh issue view <number> --comments`.
- **List issues**: use `gh issue list` with the appropriate state and label filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- **Close an issue**: `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Local outage fallback

If GitHub is unavailable, temporary issues may be written under `.scratch/<feature>/` using one Markdown file per ticket.

GitHub remains canonical. Do not maintain synchronized writable copies. When GitHub becomes available, reconcile temporary decisions into their GitHub issues and remove or archive the temporary files.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

The map is a single issue with child issues as decision tickets.

- **Map**: an issue labelled `wayfinder:map`, holding Destination, Notes, Decisions so far, Not yet specified, and Out of scope.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue. Where sub-issues are unavailable, add it to a task list in the map and put `Part of #<map>` at the top of its body.
- **Ticket labels**: `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- **Blocking**: use GitHub's native issue dependencies. Where unavailable, put `Blocked by: #<issue>` at the top of the child body.
- **Frontier**: the map's open, unblocked, unassigned child issues, in map order.
- **Claim**: assign the issue to the driving developer before starting work.
- **Resolve**: post the answer as a resolution comment, close the issue, and append a linked one-line gist to the map's Decisions-so-far section.
