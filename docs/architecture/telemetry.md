# OpenTelemetry ingestion

An administrator creates a named telemetry key under **Settings → Sign-in and access → Telemetry keys**.
The dashboard shows the endpoint base and an OTLP headers list, `Authorization=Bearer%20<key>`, once.
Send uncompressed OTLP/HTTP JSON to that base plus `/v1/traces`, `/v1/logs` or `/v1/metrics`.
Keys contain 256 random bits; only their SHA-256 digests are stored. There are at most 64 key records.
A revoked key's record can be removed to make room for another.

The receiver runs in the shared Deployment core behind both native and Cloudflare HTTP entry points.
It adds no Cloudflare binding or paid surface. The existing asset forwarding list includes `/v1/*`.
No member, runner or symbiont MCP surface administers telemetry keys.

## Wire contract

The receiver follows the [OTLP/HTTP JSON encoding and response contract](https://opentelemetry.io/docs/specs/otlp/):
hexadecimal trace and span ids, lowerCamelCase fields, integer enums and decimal-string nanosecond timestamps.
An empty successful export returns HTTP 200 with `{}`. Partial trace acceptance returns HTTP 200 with
`partialSuccess.rejectedSpans` as a decimal string and a bounded reason. It never silently truncates a span.

Missing, wrong or revoked keys receive 401; malformed envelopes receive 400; a body over 10 MiB receives 413;
an exhausted request bucket receives 429 with `Retry-After: 60`. No ingestion response redirects or identifies
a held Project or session. The existing source and token limiters bound requests: telemetry has separate
source, per-key and Deployment buckets, with the configured token limit of 300 requests per minute on both targets.

Ten MiB accommodates a sender's complete ten-MiB signal queue; a larger queued batch must be split.
At most 256 spans per request and 512 spans per trace are retained. The compact insert batch is capped
at 1,500,000 UTF-8 bytes, below [D1’s 2-MB string limit](https://developers.cloudflare.com/d1/platform/limits/). Extra spans are explicitly rejected.
Attribute lists have at most 128 entries; names have at most 256 UTF-8 bytes and attribute text at most 1024.
Nested AnyValues have bounded depth and collection sizes. An invalid or oversized attribute rejects its span,
including an unknown attribute that exceeds admission limits. Unknown attributes within bounds are discarded.
Conversation ids use capture's own 128-character bound, including its non-UUID identifiers.

Logs and metric points are accepted and counted, then discarded. They create no content records.
Counters are hourly buckets for the last day; the first bucket can include the preceding partial hour.
Accepted span counts count newly retained ids, so retries do not increase them. Rejections count rejected
records reported to senders. Malformed envelopes have no known span count.

## Stored facts and ownership

Each span retains only trace id, span id, parent span id, name, kind, service name/version, start/end
nanoseconds and millisecond windows, conversation id, agent name, operation name, provider, requested/response
model, input/output/cache-read/cache-write/reasoning token counts, `vcs.repository.url.full`,
`vcs.ref.head.name`, and the numeric status code. Events, links, status messages, resource instance identities,
unknown attributes and original request bodies are discarded. The worked sender exports no prompts or replies.

The immutable primary key is `(trace_id, span_id)`. Its first accepted key owns the row; another key cannot
replace or claim it. Multiple services and keys may contribute different spans to one trace. A transactional
counter caps the Deployment at 50,000 spans; a full store still acknowledges an already retained retry.
The request inserts its spans in one statement, with maintained counters and trace revisions in that batch.

The existing wake registry owns reconciliation and expiry. Spans and their invocation/lineage assertions expire
after 30 days of Deployment receipt time, in bounded housekeeping pages. Matching revisits a bounded trace page
for seven days after its latest new span; a later new span re-arms that trace. Spans naming a session that has not arrived
unambiguously within that wait are dropped. Reconciliation commits only against the trace revision it read.
There is no raw telemetry archive. Portable Project exports omit these Deployment-local keys and facts;
full Deployment recovery carries them with the rest of its database.

Every resolution stores the canonical `(Project id, session id)` pair and the span/key that asserted it.
Foreign keys require both sessions to exist and remove assertions when their source span or session is removed.
Revocation atomically removes the key's spans and dependent assertions, then ends its authority. It also removes
assertions from other keys that relied on one of its ancestor spans. Existing captured baggage is untouched.

## Session lineage and invoked turns

Only standard OpenTelemetry attributes and parentage participate:

- **Exact:** a descendant's `gen_ai.conversation.id=B` and its nearest differently named ancestor's
  `gen_ai.conversation.id=A` establish A → B. Both ids must resolve unambiguously across the Deployment's
  Projects. Missing ancestors, ambiguous ids, cycles and ancestry beyond 32 spans supply no link.
- **Inferred:** an `invoke_agent` operation without a conversation id may match the ancestor's child by
  standard repository URL, head ref and start time. Repository identity uses capture's existing remote
  normalization. Exactly one other live session whose session start or live turn start is within two seconds
  of the invocation start supplies an inferred assertion. Zero or multiple candidates supply none.
  Later sends reuse exactly one stored link for the same lead, GenAI agent name, normalized repository and
  head ref; multiple linked candidates refuse attribution. A missing link falls back to the bounded time window.
  Session starts use a repository/branch/time seek; turn starts use a Project/time seek capped at 513 witnesses.
  Overflow refuses inference. The same predicate checks uniqueness inside the resolution write.
- **Precedence:** captured `BAGGAGE` wins over telemetry; an exact telemetry link wins over an inferred link.
  The existing Lineage reader includes these stored edges across Projects. The dashboard labels the service
  that reported them and says “Probably started by” for an inference.

An operation with `gen_ai.operation.name=invoke_agent` and a resolved session stores an invocation window,
regardless of span name or service name. It says a program invoked that session, with its GenAI agent name
and service identity. It does not identify a person.

`core/telemetry-invocations.ts` exposes `invocationsForSession(db, projectId, sessionId, cursor?)`, returning
`{ rows, nextCursor }` ordered by sender start time, trace id and span id. Follow the cursor to null.
Each fact names the key, service, agent, sender start/end milliseconds and exact/inferred match.
`invocationForTurn(facts, { startAt, endAt })` prefers real overlap, then permits two seconds of clock skew,
prefers exact evidence and refuses an ambiguous attribution. Two seconds allows ordinary synchronized-clock
skew while limiting attribution to a nearby turn. Larger clock errors remain unattributed.
This is the seam for the separate turn-origin implementation.
The dashboard-authorized `GET /api/projects/{projectId}/sessions/{sessionId}/invocations` reads that same page;
pass its opaque `nextCursor` back as `?cursor=` to continue. A telemetry key cannot use this read endpoint.

## Sender requirements and security

A sender must put the lead's conversation id in **standard** `gen_ai.conversation.id` on an ancestor span.
The worked sender now supplies that standard lead attribute on command spans. Invocation spans should carry the worker's
conversation id whenever known. Otherwise repository, head ref and timestamps can support only the explicitly
labelled inference. A worker model selector in a private attribute is not read: use `gen_ai.request.model`.
Span links cannot substitute for ancestor parentage in this contract.

An ingest key holder can assert relationships between any two already captured sessions on this Deployment,
including across Projects, or submit a misleading invocation window. Those assertions are attributable to
the key and service, bounded, revocable and visibly reported evidence. They grant no read access, create no
session, move no session to another Project, assign no human identity and change no captured prompt or reply.
Only a linked administrator can create, revoke or remove key records through the existing dashboard authority
and same-origin protections. Keep a telemetry key separate from member, runner and editorial access keys.
