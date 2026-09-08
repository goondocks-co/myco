---
name: myco-server-debugging
description: >-
  Work out why a Myco deployment refused something, lost something, or stopped
  doing something. The server answers a caller's own fault as a terminal
  refusal carrying a named code, and its own faults as a retryable failure —
  telling those two apart is the first move in every investigation, because
  only one of them is worth retrying and only one of them is your bug.
when_to_use: >-
  Use when a deployment refuses a call, when sessions or events are not landing,
  when a scheduled job appears not to run, when a member cannot authenticate,
  or when someone reports that "the server is broken" without saying what it
  did. Also when reading server logs and needing to know what a code means.
allowed-tools: Read, Bash, Grep, Glob
user-invocable: true
---

# Debugging a deployment

## The distinction everything else hangs off

The server splits failures in two, and answers them differently on purpose:

| | Terminal refusal | Server-side failure |
|---|---|---|
| Status | 200, in the route's own refusal shape | 503, with a retry-after |
| Carries | a `reason` and a named `code` | the code `unavailable` |
| Means | the caller's request is wrong | the server or its storage is |
| Retry | never — nothing the caller sends differs next time | yes, and the client will |

**Establish which one you are looking at before anything else.** Debugging a terminal refusal as though it were an outage wastes the afternoon, and the reverse ships a bug.

The vocabulary of refusal codes is a fixed list. A caller's own text never becomes one, so a code you read in a log is always one the server chose.

## Reading the logs

Every telemetry event is a single JSON line on standard output. There is no second sink, no per-target emitter, and no structured pipeline — which makes the logs greppable and means the same line appears on both front doors.

- **On the Worker**, those lines land in the platform's logs; `wrangler tail` is the operator's live view.
- **On the binary**, they are the process's own standard output.

Every event has a `kind`. Refusals carry `reason`. Start by grepping for the kind, not for prose.

Events may carry classifiers, server-issued identifiers, the ids a member named its project and sessions by, or digests of caller identity. **They never carry a request body, a path, or an address** — a gate scans every emit call to keep that true. So if you are hoping the log will show you the payload, it will not, and that is deliberate.

## The codes you will actually meet

Grouped by what they tell you to do:

**The caller is missing something the transport requires.** A request with no project named, a credential with no machine identity, an unsupported protocol number. These are the three a client that is not a properly installed member hits first, and they fire before the body is read.

**The caller is asking for something outside its surface.** A run credential on a route that does not serve runs. A grant on a tool that is not on its allowlist. A bound principal naming a project other than its own. All terminal: the surface is not going to change on a retry.

**The invitation or credential is spent.** Unknown, used, expired, revoked, or one that names no project. Each is distinct on purpose, because the fix differs: a fresh invite, versus an administrator binding a project first.

**Two writers disagree about a row.** A conflict on an event id or a projection, or a transcript row whose stored content differs from what arrived. These are not errors in the usual sense — the stored version wins and the pass continues, and the event exists so a silent divergence becomes a visible one. If you are chasing "my write did not take", this is the family to grep.

**Something was deleted and stayed deleted.** A tombstoned session refuses re-ingest. That is the contract, not a bug: a person deleted it and live capture must not repopulate it.

## When a scheduled job seems not to run

The deployment has exactly one scheduler — the wake tick — and it is idempotent. Work through it in this order:

1. **Is the task scheduled at all?** Most tasks in the catalogue carry no schedule and run only when asked. A task with no schedule is not broken.
2. **Is it switched off?** A declaration that is switched off is absent from the clock's list rather than visited and skipped, so it will leave no trace of being considered.
3. **Was it admitted?** Every task names one admission gate — a project capability, an embedding provider, or a model provider. **A capability absent means disabled**, so a project that never turned anything on has nothing admitted. This is the single most common answer.
4. **Did it hit its ceiling?** Tasks carry a per-day cap. A capped task is skipped with a reason, not failed.
5. **Did it fail?** A failed job emits its own event. If you find neither a ran event nor a failed one, it was never admitted — go back to step 3.

## When events are not landing

Follow the refusal, not the symptom. The pipeline refuses in a fixed order, and each stage names itself: source identity, credential shape, authentication, protocol window, route kind, machine identity, project header, body, then project resolution. The first refusal in that order is the one to fix; anything later is invisible until it clears.

One asymmetry worth knowing: project resolution runs **last**, immediately before the handler, because it is the first step that can write. A deployment at its project ceiling answers a retryable failure rather than a terminal refusal — nothing the caller sends differs next time, so telling it the request was wrong would be a lie that costs the member its spooled event permanently.

## Health

The health route is public and takes no credential. It is the right probe for "is the deployment reachable from here", and it is what a client checks before serving its first request.

If health answers and everything else refuses, the problem is credentials or headers, not reachability. That single split saves more time than any other check here.
