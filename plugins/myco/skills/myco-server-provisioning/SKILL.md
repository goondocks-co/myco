---
name: myco-server-provisioning
description: >-
  Stand up, update, roll back and tear down a Myco deployment. There are three
  places one can run — this machine, a container bundle, and Cloudflare — and
  one set of verbs across them, with a target that is inferred from what is on
  disk and refuses to guess when the machine holds more than one. Covers the
  Cloudflare path in particular, where update waits for runs in flight and
  rollback exists.
when_to_use: >-
  Use when provisioning a deployment, deploying a new version, rolling one back,
  taking a backup, restoring one, rotating secrets, or removing a deployment.
  Also when a deploy appears to succeed and the running version does not change,
  or when a command refuses because the target is ambiguous.
allowed-tools: Read, Bash, Grep, Glob
user-invocable: true
---

# Running a deployment

## Three targets, one set of verbs

| Target | Is |
|---|---|
| local | this binary serving it on this machine |
| compose | a container bundle |
| cloudflare | the Worker |

The target is a flag. With no flag it is inferred from what is on disk, and **if the machine holds more than one deployment the command fails rather than guessing**. That refusal is a feature: guessing which deployment to update is the one mistake that cannot be undone by rerunning.

Ask what is there before you change anything. The status verb answers on all three targets, and on Cloudflare it reports both the deployment record and the version actually deployed.

## Provisioning on Cloudflare

One verb provisions everything: it creates the database and object storage, installs generated secrets, migrates, deploys, and writes the deployment record. It needs the account to act on, and a checkout to deploy from.

**The operator's machine needs Node and Wrangler.** That is the one place they are required, and only for this verb — nothing on a member or a worker host needs them. Treat that as a prerequisite to state up front rather than a surprise mid-command.

Account selection has a documented precedence rather than a prompt. If the account is ambiguous, name it explicitly instead of hoping the right one is picked.

## Updating

The Cloudflare update is not a plain push, and the difference matters:

1. It **waits for the runs the deployment has in flight** — queued as well as running, since a dispatched run whose host has not started is the one most easily lost.
2. A deployment **whose runs cannot be read refuses the deploy** rather than reading silence as quiet.
3. It then **watches the instances reach the pushed image** before returning, and records where they landed.
4. Pushing the image that is already running rolls nothing.

There is a flag to ship over whatever is running. Use it when you know what you are interrupting, not to get past a refusal you did not read.

The container target's update is different in kind: the container migrates on start, and a failed update returns to the previous version.

## Rolling back

**Rollback is a Cloudflare-only verb.** On any other target the command tells you so rather than doing something approximate. It returns the Worker to an earlier version, defaulting to the last one the deployment record names.

That default is the reason the record matters: a rollback with no recorded history has nothing to return to.

## Backup and restore

Backup and restore belong to the local and container targets. Restore replaces the data with the backup, so it drains first unless told not to.

Restore is a break-glass operator procedure, never a button. If you are reaching for it, say plainly what will be replaced before running it.

## Rotating secrets

Rotating generated secrets **ends every signed-in session**. Everyone signs in again. That is correct behaviour and it is disruptive, so say it before you do it, not after.

## Destroying

Destroy stops and removes the deployment. On Cloudflare it removes the Worker **only** — the data stands, and the flag that would remove data is refused on that target.

That asymmetry is deliberate and worth stating to whoever asked: on Cloudflare, "destroy" does not mean the data is gone, and someone who assumes it did will leave a database behind them.

## Before you run any of this

These verbs change infrastructure someone else may be using. Confirm the target, confirm the account, and say what will happen — which sessions end, which data is replaced, what stays behind — before the command, not in the summary afterwards.
