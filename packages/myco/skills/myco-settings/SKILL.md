---
name: myco-settings
description: >-
  Change a Myco deployment's settings safely, and add a new setting correctly.
  Deployment settings are one tier with one writer: every change admits the
  leaf, authorizes the actor, checks the leaf's own rule, persists it with its
  actor, and re-arms whatever schedule it moved — in that order, in one module.
  Bypassing that path is how one of those five steps quietly goes missing.
when_to_use: >-
  Use when changing a deployment setting, adding a new one, working out why a
  setting was refused, or wondering whether a value belongs in the deployment's
  settings at all. Also when a setting appears to save and change nothing, or
  when a capability seems off for a project that never turned it off.
allowed-tools: Read, Edit, Write, Grep, Glob
user-invocable: true
---

# Deployment settings

Myco 1.4 resolved settings across four tiers. 2.0 keeps two: what stays on the machine, and what the deployment holds. This skill is about the second.

## One writer, five steps, one order

Every write goes through the settings module, and it does five things in a fixed order:

1. **Admit the leaf** — is this a deployment-tier setting at all?
2. **Authorize the actor.**
3. **Check the leaf's own rule.**
4. **Persist it**, recording who changed it and when, inside a commit that re-checks the revision the change was made against.
5. **Re-arm** any schedule the change moved.

Every write carries the revision its caller read: `If-Match` with the leaf's `revision` from `GET /api/settings` (a Project's from `GET /api/projects/{id}/capabilities`). Absent is refused with 428; stale is refused with 409 naming the leaf, the actual and expected revision and the call to make next.

The order is the point. Splitting these across call sites is how three of the four eventually go missing on one path and nobody notices. A gate holds every write to that one module, keyed on the tables themselves, so a second writer fails the build rather than drifting.

**Never write the settings table directly.** If you find yourself reaching for the database, you are adding the second writer the gate exists to prevent.

## A leaf carries its own rule, as data

A leaf's rule is declarative data, not a validator function. Three shapes exist:

| Shape | Means |
|---|---|
| `{}` | no rule; any JSON value |
| `{ type: 'integer', min, max }` | a whole number in range |
| `{ type: 'markdown', maxBytes }` | text: a string, no ASCII control character but newline and tab, within a UTF-8 byte budget |

Data rather than a function because three consumers need to read it: the settings page renders a field from it, a gate reads it, and the writer enforces it. A function could serve only the last.

**Most leaves carry `{}`, and that is deliberate.** A leaf that shipped before rules existed keeps no rule, because giving it one now would refuse values a deployment already holds. Add a rule to an existing leaf only when you have checked what is already stored.

## Adding a setting

1. **Decide the tier.** Does the value describe the deployment, or this machine? Capture, spool and machine preferences never become deployment state.
2. **Add the leaf to the specs record**, with its rule if it has one. The list of deployment leaves is *derived* from that record, so a leaf cannot be named in one place and missing from the other.
3. **A gate holds that list against the architecture ledger.** A leaf with no ledger row fails it. That is the gate catching a setting nobody classified, which is exactly its job.
4. **Give it a rule if a wrong value would be expensive.** A byte cap on text a person edits; a range on a number that drives a schedule.
5. **If the setting moves a schedule, make sure the re-arm covers it.** Step 5 exists so a changed interval takes effect without a restart.

## Reading a setting

Absent is not zero, and the read side does not default for you. A leaf never written is simply absent from the map, and each reader layers its own default over that. When you add a reader, decide what absence means and say so where the default lives.

One reader is worth knowing by name: the session-start instructions template answers the empty string for absent, unparseable, or non-string. It never throws, because a deployment with a malformed row must still serve sessions.

## Refusals

These answer a fault in the caller's own request. A conflict is the one to re-read and repeat: the answer names the revision to send.

| Refusal | Means |
|---|---|
| not a deployment-tier leaf | the name is not a leaf this tier owns |
| unauthorized | the actor may not make this change |
| invalid value | the leaf's own rule rejected it, with a detail naming why |
| unknown capability | the capability name is not one of the three |
| conflict (409) | the leaf changed since the caller read it; nothing was saved, and the answer gives the leaf, its actual and expected revision and the next call |
| revision required (428) | the write sent no `If-Match`; nothing was saved |

A changed idle close does not rewrite sessions in the settings write: the commit records a generation, the catch-up rewrites deadlines in pages and activates it, and Settings shows what is configured, what is pending and what is in effect until then.

## Project capabilities

The three project capabilities are **Context for sessions**, **Code map** and **Learning**. All are **on by default**: a missing capability row means enabled. An explicit opt-out stays off, and archived projects are excluded from automatic work.

Enabling a capability does not register a runner or turn on scheduled work. Myco's agent work runs only on registered runners. **Work on a schedule** starts off. Projects with **Code map** on keep their map current after new capture, including during active work, within the refresh period and task limits. Repository tasks need a connected repository.

**Runs of one task at once** defaults to 2 across projects. Additional runs queue. First extraction of a large history ramps at two automatic runs a day until that initial history drains or the active window expires; recent live sessions have reserved daily slots. Use the settings module's effective capability read rather than testing for a stored row.

## The one setting people ask about

The session-start instructions template is text a person writes, capped at four kilobytes, served to every agent at the start of every session. It is not generated and nothing rewrites it.

It is keyed on the leaf name alone, so **one template serves every project on the deployment**. If a deployment hosts several projects with different needs, that is a limitation to know about before promising per-project guidance.
