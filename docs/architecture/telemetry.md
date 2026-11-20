# OpenTelemetry ingestion

An administrator creates a named key under **Settings → Sign-in and access → Telemetry keys**.
The dashboard shows the endpoint base and the OTLP header list `Authorization=Bearer%20<key>` once.
Keys contain 256 random bits; only SHA-256 digests are stored. A key accepts ingestion and grants no reads.
At most eight keys are live. Revoked records remain until their bounded cleanup finishes and an administrator removes them.

## Wire contract

Send uncompressed OTLP/HTTP JSON to `POST /v1/traces`, `/v1/logs` or `/v1/metrics`.
Batch below **1 MiB**; the worked sender's ordinary batches are far smaller. The bound counts streamed bytes,
including requests without Content-Length. Logs and metrics are validated and discarded without durable counters.

Unsupported paths, methods, content types and content encodings are refused before any limiter.
Missing, wrong or revoked keys receive 401; malformed bodies receive 400; over-limit bodies receive 413.
The source bucket bounds unauthenticated traffic. The authenticated per-key bucket admits 300 requests/minute
before the shared Deployment bucket of 600 requests/minute. Both use the existing rate-limit bindings and
write no D1 rows. Exhausted buckets answer 429 with `Retry-After: 60`. No ingest answer redirects.

Trace exports answer 200 with `{}`, or decimal-string `partialSuccess.rejectedSpans` and a bounded reason.
At most 256 spans per request are retained. Attribute lists have at most 128 entries; names have at most
256 UTF-8 bytes and attribute text 1024. Nested values have bounded depth and collection sizes. Invalid or
oversized attributes reject the span, including unknown attributes; admissible unknown attributes are dropped.
The compact insert payload is at most 1,500,000 bytes. Conversation ids have at most 128 characters.

Ids are hexadecimal; fields are lowerCamelCase and enums are integers. Nanosecond timestamps accept decimal
uint64 strings or nonnegative safe integer numbers. Current epoch nanoseconds exceed JavaScript's safe
integer range and require strings. Span times must be from 2020 through one day after receipt, with end
at or after start. There is no duration limit. A long lead span can supply ancestry to its children.

## Storage, quota and work

A compact span retains its key, trace/span/parent ids, name, kind, service name/version, start/end nanoseconds
and milliseconds, conversation id, agent name, operation, provider, requested/response models, token counts,
standard repository URL/head ref, numeric status, receipt time and the latest end time in its received batch.
Events, links, status messages, resource instance identities, unknown attributes and original bodies are discarded.

Span identity is **(key, trace id, span id)**. A retry preserves that key's first immutable row.
Another key presenting the same trace/span ids stores independent rows. Its evidence cannot shadow the first key.
The trace allowance is 512 spans per key.

The 50,000-span Deployment cap is divided by the number of live keys: one key receives 50,000 spans and
eight receive 6,250 each. Issuing or revoking a key changes the share immediately. Existing spans are preserved
when a share shrinks; an over-quota key accepts no new spans until its retained use falls below its share.
Settings shows retained use, quota, exhaustion and the corresponding approximate daily allowance over 30 days.
A quota refusal states use and quota and advises waiting for retention or reducing live senders.

Spans and derived facts expire after 30 days of receipt, in bounded housekeeping pages. Unknown named sessions
wait at most seven days after new trace input. Settled partitions have no polling deadline. New spans and
dependency notifications mark work due. Notifications include session arrival or deletion and tombstones.

One work row gates housekeeping. An idle pass reads that row and returns without writes or per-key scans.
The tick omits the telemetry job while no key exists or no work is due. A due partition wakes through the
after-response path only when the work flag transitions from settled to due. Further requests behind that
pending work do not make more clock calls. Telemetry does not stamp interactive activity.

Accepted/rejected span counters use hourly buckets for the last day; the first bucket can include a preceding
partial hour. New retained ids increase accepted counts; retries do not. Rejecting exports persist their exact
rejection count. Last-used timestamps change at most once per minute. Empty exports, identical retries,
malformed bodies, logs and metrics write no telemetry rows.

## Derivation and display

Every derivation uses one key's spans and stored links:

- **Exact:** conversation B under an ancestor carrying different conversation A reports A → B. Each id must
  resolve unambiguously across Projects. Cycles and ancestry beyond 32 spans supply no parent.
- Within one key, the latest consistent report supplies its parent. Across keys, different parents
  disagree. No disputed parent is selected; the list names the child, parent,
  key label and the service name as a sender claim. Captured `BAGGAGE` always wins.

Lineage reads use the caller's canonical visible Project set. A hidden endpoint is an unavailable placeholder
without its id, Project, title, prompt, agent or times; traversal stops there.

`invocationsForSession` serves a cursor page through the Project-scoped `GET …/sessions/{id}/invocations` API.
Its cursor includes key identity. Exact invocation facts are listed on the session with their own sender times,
key label, service name and agent name. They do not change turn origins. Captured launch lineage assigns the
opening turn to another agent and excludes it from person turns; later turns retain their transcript origin.

Myco resolves spans only by `gen_ai.conversation.id`. Repository, ref, timing and ordering cannot establish
identity: a live launch arrived 3.1 seconds after its span while a later message arrived within 1.1 seconds.
A time window missed the launch and selected the message. Harness startup speed is not evidence, so Myco
uses no inferred matches or time-based turn attribution. A named session not yet captured resolves when it arrives.

Settings shows receipt minus the newest span end in the latest newly retained batch. This signed measurement
includes both sender clock error and delivery delay; it is not a clock correction or a matching rule.

## Revocation, recovery and trust

Revocation immediately ends the key's authority. Readers ignore its facts before cleanup runs.
Housekeeping removes that key's resolutions and spans in bounded pages. Another key's evidence is independent.

An administrator-issued key can report misleading links or times between existing sessions. A conflicting key
can remove, never replace, another key's displayed parent by creating disagreement. Captured
`BAGGAGE` is immune. Revoking the conflicting key restores the remaining result. Labels are visible to members
who can see the session. Keys create no session, move no Project and attribute no work to a person.

Portable backups omit telemetry keys, spans and derived state. A restore into a new Deployment requires new
keys and sender configuration. A Project restore into the same Deployment leaves Deployment-local telemetry alone.

The worked sender supplies the lead's standard `gen_ai.conversation.id`; it should supply worker ids whenever
known. Requested models use `gen_ai.request.model`. Private attributes and span links are not matching rules.
