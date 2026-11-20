# OpenTelemetry ingestion

An administrator creates a named telemetry key under **Settings → Sign-in and access → Telemetry keys**.
The dashboard shows the endpoint base and the OTLP headers list `Authorization=Bearer%20<key>` once.
Send uncompressed OTLP/HTTP JSON to that base plus `/v1/traces`, `/v1/logs` or `/v1/metrics`.
Keys contain 256 random bits; only SHA-256 digests are stored. There are at most 64 key records.
A revoked record can be removed after its background cleanup completes.

The shared Deployment core serves native and Cloudflare requests. The existing `/v1/*` asset-forwarding
rule adds no binding or paid surface. Member, runner and symbiont MCP credentials cannot manage these keys.

## Wire contract and isolation

The receiver accepts OTLP/HTTP JSON: hexadecimal ids, lowerCamelCase fields, integer enums, and uint64
nanosecond timestamps as decimal strings or nonnegative safe integer numbers. Current epoch nanoseconds
usually exceed JavaScript's safe integer range and need strings. Successful exports answer 200 with `{}`;
partial trace acceptance answers 200 with decimal-string `partialSuccess.rejectedSpans` and a bounded reason.
Missing, wrong or revoked keys receive 401, malformed envelopes 400, and bodies over **1 MiB** 413.
The body bound applies while streaming, including requests without Content-Length. Senders should batch
below it; the worked sender's ordinary batches are far smaller. Ingestion never redirects.

The source limiter bounds unauthenticated traffic. Each key then admits at most **60 requests per minute**,
before drawing from the existing Deployment bucket of 300 requests per minute. A key over its own limit
cannot drain that Deployment bucket. Exhausted rate limits answer 429 with `Retry-After: 60`.
Each key reserves **781 retained spans**, one share of the 50,000-span Deployment ceiling. Its row in
Settings shows use, quota and the full-quota state. Its quota refusal is named in the OTLP response.
The 512-span trace cap counts only the presenting key's spans. Another key cannot consume that share.

At most 256 spans per request are retained; the compact insert payload is at most 1,500,000 bytes.
Conversation ids retain the capture limit of 128 characters. Attribute lists have at most 128 entries; names have at most
256 UTF-8 bytes and attribute text 1024. Nested values have bounded depth and collection sizes. Invalid
or oversized attributes reject their span, including unknown attributes; admissible unknown attributes
are discarded. No span is silently truncated. A retained span may last at most **one hour**.
Logs and metric points are counted and discarded. Counters use hourly buckets for the last day; the first
bucket can include the preceding partial hour. Newly retained ids increase accepted counts; retries do not.
Malformed envelopes and over-limit streams have no known rejected-span count.

## Stored facts

A span retains trace/span/parent ids, name, kind, service name/version, start/end nanoseconds and millisecond
windows, conversation id, agent name, operation, provider, requested/response model, input/output/cache-read/
cache-write/reasoning token counts, `vcs.repository.url.full`, `vcs.ref.head.name`, numeric status, key id and
receipt time. Events, links, status messages, resource instance identities and original bodies are discarded.
The immutable key is `(trace_id, span_id)`; its first accepted key owns it. Different keys may contribute
other spans to the trace. The request inserts all its spans in one statement. Maintained key and trace-key
counters enforce quotas without counting the held trace for every incoming span.

Spans and derived facts expire after 30 days of receipt time, in bounded housekeeping pages. Matching waits
at most seven days after new trace input for a missing named session; unmatched named spans are then dropped.
A fully settled trace has no recheck deadline. A pending wait has one expiry deadline, rather than a polling
schedule. A new span or an indexed dependency notification from capture makes relevant work due. Session
starts, branch changes and live turn publication notify only the ids or repository/ref/time windows they affect.
The wake handles bounded trace/key partitions and bounded ancestor walks across keys. Identical resolutions
and supporting-key references are not rewritten. No pass chains itself merely to recheck unchanged traces.

Only a request retaining a new span schedules an after-response wake, using capture's deferred-work path.
Validation failures, empty exports, immutable retries, logs and metrics do not wake the clock.

## Lineage and invocations

Only standard attributes and parentage participate:

- **Exact:** conversation B under an ancestor carrying different conversation A reports A → B. Each id must
  resolve unambiguously across Projects. Cycles and ancestry beyond 32 spans supply no parent.
- **Inferred:** an `invoke_agent` span without its own conversation id can match by normalized repository,
  head ref and a session or live turn start within **two seconds** of its start. Candidate reads use indexed
  time windows and stop at 513 turn witnesses; overflow refuses inference. Zero candidates give no match.
  A stored link may break a tie only among candidates already inside this span's window. A worker launched
  ten minutes later receives its own invocation; an old link never extends the window.
- **Precedence and disagreement:** captured `BAGGAGE` wins; exact telemetry outranks inferred telemetry.
  If strongest reports name different parents, no parent is selected. The Lineage tab lists the disagreeing
  reports. Every reported edge and invocation names the administrator's key label; service.name is shown
  separately as a sender claim. Inferences say “Probably started by”.

Cross-Project metadata is read only from the caller's canonical visible Project set. A link to a session
outside that set appears as an unavailable session, without its id, Project, title, prompt, agent or times;
the traversal does not continue through it.

`core/telemetry-invocations.ts` exports `invocationsForSession(db, projectId, sessionId, cursor?)`, a 200-fact
page ordered by `(startAt, traceId, spanId)`, with `{ rows, nextCursor }`. Facts include canonical span/key ids,
the administrator's key label, claimed service, agent, sender times and exact/inferred match strength.
The dashboard-authorized `GET /api/projects/{projectId}/sessions/{sessionId}/invocations` uses this same reader;
pass its opaque nextCursor back as `?cursor=`. An ingest key cannot use it.
`invocationForTurn` matches a turn's **start** within two seconds of one span's start. Any ambiguous match
returns no invocation. Duration or overlap cannot attribute a whole session to one span. Two seconds admits
ordinary synchronized-clock skew; larger clock errors leave a turn unattributed. This is the separate
turn-origin lane's read seam and does not change captured prompts or replies.

## Revocation, recovery and security

Revocation immediately ends authority by updating one key row. Readers ignore that key and any resolution
whose recorded supporting keys include it, including dependencies through stored links and ancestor walks.
The wake then invalidates dependent resolutions and removes spans in bounded pages, regardless of their
former wait state. Other keys' affected facts are re-derived from remaining live evidence or removed.
Cleanup is asynchronous; the key record becomes removable when its references and counters are gone.

The portable backup format omits telemetry keys, spans and derived state. A restore into a **new
Deployment** therefore has no telemetry keys: an administrator creates new keys and reconfigures senders.
A Project restore into the same Deployment leaves its Deployment-local telemetry untouched.

An ingest key can assert links between any two existing sessions on the Deployment, including across Projects,
and can submit misleading times or service claims. It grants no reads, creates no session, changes no Project,
assigns no human identity and overrides no captured baggage. The administrator's key label identifies the
source of each assertion. Keep it separate from member, runner and editorial credentials.
The worked sender now puts the lead's id in standard `gen_ai.conversation.id`. It should supply worker ids
whenever known. Models use `gen_ai.request.model`; private attributes are not read. Span links do not
substitute for ancestor parentage.
