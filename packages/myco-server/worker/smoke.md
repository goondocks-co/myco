# Smoke — procedure and last observed output

The procedure is run from `packages/myco-server/worker` against `wrangler dev` with a local D1, and again against the deployed Worker with the remote D1 (`-c wrangler.deploy.toml`, `https://<name>.<account>.workers.dev`). It exercises the deployed entry end to end: health, ingest, idempotency, tenancy, the session projection, every bound, the schema-version guard, the quota, revocation, and both rate limiters. Every request uses a client timeout (`curl -m 20 --connect-timeout 5`); oversized uploads and rate-limit loops are run in segments of at most 150 requests, and the limiter rows are driven over one keep-alive connection.

## Procedure

```bash
rm -rf .wrangler/state
npm run schema:emit && npx wrangler d1 execute myco-server --local --file ./schema.sql
umask 077; D=$(mktemp -d)
npm run -s token:mint -- proj_1 machine_1 --print-token > $D/m1.sql 2> $D/m1.env   # prints the projects row and the token insert
npm run -s token:mint -- proj_2 machine_2 --print-token > $D/m2.sql 2> $D/m2.env
npm run -s token:mint -- proj_1 machine_3 --print-token > $D/m3.sql 2> $D/m3.env
npx wrangler d1 execute myco-server --local --command "$(grep -v '^--' $D/m1.sql) $(grep -v '^--' $D/m2.sql) $(grep -v '^--' $D/m3.sql)"
npx wrangler dev --port 8787 &
until curl -s -m 2 localhost:8787/health; do sleep 1; done
```

Then, with `T1`/`T2`/`T3` read from `$D/m*.env`, `EV` = `{"eventId":"evt_1","sessionId":"sess_1","kind":"prompt","createdAt":5000,"channel":"cli","payload":{"t":"hi"}}`, and `post TOKEN BODY` = `curl -s -m 20 --connect-timeout 5 -w ' [%{http_code}]' localhost:8787/events -H "authorization: Bearer TOKEN" --data-binary BODY`:

| Row | Request | Expected |
|---|---|---|
| 1 | `GET /health` | 200 `{"ok":true}` |
| 2a | T1 posts `EV` | 200 `{"persisted":true}` |
| 2b | same again | 200 `{"persisted":true,"duplicate":true}` |
| 2c | same id, `kind` changed (or session, time, channel, payload) | 200 `{"persisted":false,"reason":"event id conflict"}` |
| 3 | no authorization | 401 with `WWW-Authenticate: Bearer realm="myco"` |
| 4a | `GET /nope`, no credential | 401 (never 404) |
| 4b | `POST /v2/events` with T1 | 401; the source bucket is not charged |
| 5 | T2 posts `EV` (its own project) | 200 persisted — a second sessions row under proj_2, proj_1 untouched |
| 5b | `authorization: bearer …` (lowercase) | 200 |
| 6 | T3 (proj_1) posts `evt_1` with `createdAt: 0` and another payload | 200 `event id conflict`; proj_1/sess_1 unchanged, no new session row |
| 6b | T3 posts `evt_1` under `sess_9` | 200 `event id conflict`; no `sess_9` row |
| 6c | T3 posts `EV` unchanged | 200 duplicate; T3 `bytes_written` stays 0 |
| 7 | envelope with an extra field (`"transport":"cli"`) | 200 `unknown field transport` |
| 8 | pre-2.0 hook body `{type,prompt,session_id,agent,transcript_path}` | 200 `unknown field type` |
| 9–11 | 512 KiB content-length, 2 MiB chunked, 16 MiB chunked | 200 `body exceeds 327680 bytes` each; the next request answers normally |
| 12 | 160 000-element array (compact JSON) | 200 `payload exceeds 100000 nodes` |
| 13 | 40-deep nesting | 200 `payload exceeds nesting depth 32` |
| 14 | 300 KiB single-string payload | 200 `payload exceeds 262144 bytes` |
| 15 | 193-char eventId / a 165-char `<128 m>:<uuid>` id | 200 `eventId exceeds 192 characters` / 200 persisted |
| 16 | `createdAt: 1e308` | 200 `createdAt must be a non-negative integer` |
| 17 | `Bearer not-a-token` | 401 |
| 18 | headers on /health | `cache-control: no-store`, HSTS, `x-content-type-options: nosniff` |
| S1 | `UPDATE schema_meta SET value='2'`, then a member request with an unknown token and with T1 | 503 both (`schema_mismatch`); restore to '1' → 200 |
| Q1 | first post of a fresh event, then its replay, then a conflicting payload | `bytes_written` grows by the body bytes once; replay and conflict add 0 |
| Q2 | T2 row set to quota−100, ~120-byte body | 200 `token write quota exceeded`, nothing stored |
| P | sessions table | one row per (project, session) that stored an event; `first_received_at ≤ last_received_at`, both server clock; `created_by_token_id` = first inserter |
| — | revoke T2 via `npm run token:revoke -- <id>` → `wrangler d1 execute` | T2 answers 401 on its next request |
| 19 | 400 authenticated T1 posts over one keep-alive connection, then an anonymous request | 300×200 then 429 with `retry-after: 60`; anonymous → 401 (source bucket untouched by members) |
| 20 | 720 anonymous posts over one keep-alive connection, then anonymous / bad well-formed token / valid T2 | 401s then 429s once the bucket trips (best-effort: it tripped at 601 in one run and not within 720 in another); … / … / **200** |
| 21 | health | 200 |

Finish with `pkill -f 'wrangler dev'` and `rm -rf $D`.

## Last observed output — local (rows changed in this revision)

wrangler 4.123.0, workerd local, fresh local D1 seeded from the mint output alone. Tokens and token ids redacted.

```text
L1 post:        {"persisted":true} [200]
L2 replay:      {"persisted":true,"duplicate":true} [200]
L3 kind changed: {"persisted":false,"reason":"event id conflict"} [200]
L4 unknown field: {"persisted":false,"reason":"unknown field transport"} [200]
L5 legacy body: {"persisted":false,"reason":"unknown field type"} [200]
L6 squat by T3 (createdAt 0, other payload): {"persisted":false,"reason":"event id conflict"} [200]
L7 T3 new session id under stored evt: {"persisted":false,"reason":"event id conflict"} [200]
L8 valid token unmatched route:  [401]
L9 no cred: [401]  malformed: [401]
L10 long id (165): {"persisted":true} [200]
D1: {"events":2,"sessions":1,"sess":"<first>/<last>/<t1 id>","t1":372,"t3":0}
S1 unknown token: [503]  valid: [503]      S2 restored: [200]
telemetry: {"kind":"ingest_conflict","projectId":"proj_1","tokenId":"<t1>"} … {"kind":"auth_failed","matched":true,"source":"10ea03e3675d1296"}
5xx lines in the wrangler log: 2 (the two designed schema-mismatch 503s)
```

## Observed against a real deploy

Cloudflare account, D1 `myco-server` (ENAM), Worker deployed with `wrangler deploy -c wrangler.deploy.toml`; the remote database was dropped and re-created from `schema.sql`, then seeded with the mint output alone (three tokens across two projects). Tokens and ids redacted.

```text
R1 health: {"ok":true} [200]
R2a post: {"persisted":true} [200]
R2b replay: {"persisted":true,"duplicate":true} [200]
R2c conflict(kind): {"persisted":false,"reason":"event id conflict"} [200]
R3 no cred: [401] www-authenticate: Bearer realm="myco"
R4 /nope anon: [401]  /v2/events valid token: [401]
R5 T2 sess_1 (own project): {"persisted":true} [200]   (first attempts, ~60 s after deploy, answered from the previous Worker version — a gradual version rollout across edge servers; settled within a minute)
R6 T3 squat createdAt 0: {"persisted":false,"reason":"event id conflict"} [200]
R7 T3 identical replay: {"persisted":true,"duplicate":true} [200]
R8 unknown field: {"persisted":false,"reason":"unknown field transport"} [200]
R9 legacy body: {"persisted":false,"reason":"unknown field type"} [200]
R10 lowercase bearer: {"persisted":true} [200]
R11 malformed cred: [401]
R12 headers: cache-control: no-store strict-transport-security: max-age=31536000 x-content-type-options: nosniff
R13a 512KiB CL: {"persisted":false,"reason":"body exceeds 327680 bytes"} [200]
R13b 2MiB chunked: {"persisted":false,"reason":"body exceeds 327680 bytes"} [200]
R13c 16MiB chunked: {"persisted":false,"reason":"body exceeds 327680 bytes"} [200] 17.8s
R13d next normal: {"persisted":true} [200]
R14 wide: payload exceeds 100000 nodes · deep: payload exceeds nesting depth 32 · bigstr: payload exceeds 262144 bytes · longid: eventId exceeds 192 characters · okid (165 chars): {"persisted":true} · badts: createdAt must be a non-negative integer   (all 200)
R15 health: {"ok":true} [200]
R16 400 authenticated on one connection: {200: 301, 429: 99} first429@301 in 42s   · anonymous after member traffic: 401
R17a 720 anonymous on one connection: {401: 720} first429@None in 23s   (an earlier run on the previous version: 645×401 / 75×429, first429@601)
R17b anon now: 401 | bad well-formed token: 401 | valid T2 same source: (200, {"persisted":true})
R17c valid T2 on unmatched route: 401
R18 first: {"persisted":true}  replay: duplicate:true  conflict: event id conflict   bytes: before=38397 after=38508 delta=111 bodyBytes=111
R19 sessions: one row per stored session; first_received_at ≤ last_received_at; server clock; proj_1/sess_1 by machine_1, 1 row
R20 T2 after revoke (statement from `token:revoke`, applied remotely): 401
R21 D1 state: {"events":308,"sessions":6,"proj2_events":2,"t1":38508,"t2":226,"t3":0,"v":"1"}
```

Two platform facts this run established that `wrangler dev` cannot show: the `[[ratelimits]]` binding counts per edge server and is eventually consistent (a single-connection client is limited near the configured value; 1,500 requests over 40 parallel connections saw no 429 in an earlier run; the anonymous bucket tripped at 601 in one run and not within 720 in another), so the byte quota — not the rate limit — is the bound on what a stolen token can store; and for roughly a minute after a deploy the edge serves both the previous and the new Worker version (and, for a brand-new workers.dev hostname, Cloudflare error pages 1104/1042 before the Worker is reachable) — clients that ack only on 2xx retry through both.
