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
4. **Persist it**, recording who changed it and when.
5. **Re-arm** any schedule the change moved.

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

Four, and none is retryable — each names a fault in the caller's own request:

| Refusal | Means |
|---|---|
| not a deployment-tier leaf | the name is not a leaf this tier owns |
| unauthorized | the actor may not make this change |
| invalid value | the leaf's own rule rejected it, with a detail naming why |
| unknown capability | the capability name is not one of the four |

## Project capabilities

Capabilities are the other half of this module, and they have one property worth stating loudly: **absent means disabled**.

A project appears the first time a member writes, with no provisioning moment. If an absent row meant enabled, every new project would silently acquire every cost-bearing capability the moment it appeared. So a capability is on only when a row says so, and the report of a project's capabilities defaults every missing row to off.

That is the inverse of the 1.4 local behaviour. If you are porting logic that assumed a default of enabled, it is wrong here.

## The one setting people ask about

The session-start instructions template is text a person writes, capped at four kilobytes, served to every agent at the start of every session. It is not generated and nothing rewrites it.

It is keyed on the leaf name alone, so **one template serves every project on the deployment**. If a deployment hosts several projects with different needs, that is a limitation to know about before promising per-project guidance.
