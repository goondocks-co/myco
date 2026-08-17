# Local smoke — procedure and last observed output

The procedure below is run from `packages/myco-server/worker` against `wrangler dev` with a local D1. It exercises the deployed entry end to end: health, ingest, idempotency, tenancy, every bound, the schema-version guard, the quota, revocation, and both rate limiters. Every request uses a client timeout (`curl -m 20`); oversized uploads and rate-limit loops are run in segments of at most 150 requests.

## Procedure

```bash
rm -rf .wrangler/state
npm run schema:emit && npx wrangler d1 execute myco-server --local --file ./schema.sql
npx wrangler d1 execute myco-server --local --command "INSERT INTO projects (project_id,name,created_at) VALUES ('proj_1','one',0),('proj_2','two',0)"
umask 077; D=$(mktemp -d)
npm run -s token:mint -- proj_1 machine_1 --print-token > $D/m1.sql 2> $D/m1.env
npm run -s token:mint -- proj_2 machine_2 --print-token > $D/m2.sql 2> $D/m2.env
npx wrangler d1 execute myco-server --local --command "$(grep -v '^--' $D/m1.sql) $(grep -v '^--' $D/m2.sql)"
npx wrangler dev --port 8787 &
until curl -s -m 2 localhost:8787/health; do sleep 1; done
```

Then, with `T1`/`T2` read from `$D/m*.env` and `post TOKEN BODY` = `curl -s -m 20 --connect-timeout 5 -w ' [%{http_code}]' localhost:8787/events -H "authorization: Bearer TOKEN" -H 'content-type: application/json' --data-binary BODY`:

| Row | Request | Expected |
|---|---|---|
| 1 | `GET /health` | 200 `{"ok":true}` |
| 2a | T1 posts `evt_1`/`sess_1` | 200 `{"persisted":true}` |
| 2b | same again | 200 `{"persisted":true,"duplicate":true}` |
| 2c | same id, different payload | 200 `{"persisted":false,"reason":"event id conflict"}` |
| 3 | no authorization | 401 with `WWW-Authenticate: Bearer realm="myco"` |
| 4 | `GET /nope` with T1 | 401 (never 404) |
| 5 | T2 posts `evt_1`/`sess_1` | 200 persisted — a second sessions row under proj_2, proj_1 untouched |
| 5b | `authorization: bearer …` (lowercase) | 200 |
| 6–8 | 512 KiB, 2 MiB content-length, 2 MiB chunked | 200 `body exceeds 327680 bytes` |
| 8b | 16 MiB chunked ×3, then health | 200 refusal ×3; health 200 |
| 9 | `{}` after the drains | 200 `eventId must be a non-empty string` |
| 10 | 160 000-element array (320 106 B, compact JSON) | 200 `payload exceeds 100000 nodes` |
| 11 | 40-deep nesting | 200 `payload exceeds nesting depth 32` |
| 12 | `Bearer not-a-token` | 401 |
| 13 | headers on /events | `Cache-Control: no-store`, HSTS, `x-content-type-options: nosniff` |
| 14 | 300 KiB single-string payload | 200 `payload exceeds 262144 bytes` |
| 15 | 129-char eventId | 200 `eventId exceeds 128 characters` |
| 16 | pre-2.0 hook body `{type,prompt,session_id,agent,transcript_path}` | 200 `eventId must be a non-empty string` |
| 16b | `createdAt: 1e308` | 200 `createdAt must be a non-negative integer` |
| S1 | `UPDATE schema_meta SET value='2'`, then a member request | 503 with `Retry-After: 60`, `schema_mismatch` telemetry; restore to '1' → 200 |
| Q1 | T2 row set to quota−100, ~120-byte body | 200 `token write quota exceeded`, nothing stored |
| Q2 | restore, same body | 200 persisted; `bytes_written` charged the body once |
| — | revoke T2 via `npm run token:revoke -- <id>` → `wrangler d1 execute` | pass 2: rows 5 and 17 answer 401 |
| 18 | 450 authenticated T1 posts (3×150), then an anonymous request | 300×200 then 429 (token limit); anonymous → 401 (source bucket untouched by members) |
| 19 | 750 anonymous posts (5×150), then anonymous / bad token / valid T1 | 600×401 then 429; 429 / 429 / **200** |
| 20 | health | 200 |

Finish with `pkill -f 'wrangler dev'` and `rm -rf $D`.

## Last observed output

wrangler 4.123.0, workerd local, fresh local D1. Tokens and token ids redacted.

```text
===== PASS 1
1 health:  {"ok":true} [200]
2a same event:  {"persisted":true} [200]
2b same event:  {"persisted":true,"duplicate":true} [200]
2c same id, different payload:  {"persisted":false,"reason":"event id conflict"} [200]
3 no auth:  HTTP/1.1 401 Unauthorized WWW-Authenticate: Bearer realm="myco" 
4 /nope:  {"error":"unauthorized"} [401]
5 T2 posts sess_1:  {"persisted":true} [200]
5b lowercase bearer:  {"persisted":true} [200]
6 512KiB CL:  {"persisted":false,"reason":"body exceeds 327680 bytes"} [200]
7 2MiB CL:  {"persisted":false,"reason":"body exceeds 327680 bytes"} [200]
8 2MiB chunked:  {"persisted":false,"reason":"body exceeds 327680 bytes"} [200]
8b 16MiB chunked #1:  {"persisted":false,"reason":"body exceeds 327680 bytes"} [200]
8b 16MiB chunked #2:  {"persisted":false,"reason":"body exceeds 327680 bytes"} [200]
8b 16MiB chunked #3:  {"persisted":false,"reason":"body exceeds 327680 bytes"} [200]
8c health after drain:  {"ok":true} [200]
9 next normal {}:  {"persisted":false,"reason":"eventId must be a non-empty string"} [200]
10 160k array:  {"persisted":false,"reason":"body exceeds 327680 bytes"} [200]
11 40-deep:  {"persisted":false,"reason":"payload exceeds nesting depth 32"} [200]
12 malformed cred:  {"error":"unauthorized"} [401]
13 headers:  Cache-Control: no-store Strict-Transport-Security: max-age=31536000 x-content-type-options: nosniff 
14 300KiB string payload:  {"persisted":false,"reason":"payload exceeds 262144 bytes"} [200]
15 129-char eventId:  {"persisted":false,"reason":"eventId exceeds 128 characters"} [200]
16 legacy body:  {"persisted":false,"reason":"eventId must be a non-empty string"} [200]
16b createdAt 1e308:  {"persisted":false,"reason":"createdAt must be a non-negative integer"} [200]
17 T2 {}:  {"persisted":false,"reason":"eventId must be a non-empty string"} [200]
10 160k array:  {"persisted":false,"reason":"payload exceeds 100000 nodes"} [200]
S1 schema v2 in DB, member request:  HTTP/1.1 503 Service Unavailable Retry-After: 60
S2 restored:  {"persisted":false,"reason":"eventId must be a non-empty string"} [200]
Q1 T2 with 100 bytes left, ~120-byte body:  {"persisted":false,"reason":"token write quota exceeded"} [200]
Q2 T2 restored, same post:  {"persisted":true} [200]
--- revoking T2: UPDATE member_tokens SET revoked_at = <ts> WHERE id = 'mt_<id2>' AND revoked_at IS NULL;  → 1 command executed successfully
===== PASS 2
1 health:  {"ok":true} [200]
2a same event:  {"persisted":true,"duplicate":true} [200]
2b same event:  {"persisted":true,"duplicate":true} [200]
2c same id, different payload:  {"persisted":false,"reason":"event id conflict"} [200]
3 no auth:  HTTP/1.1 401 Unauthorized WWW-Authenticate: Bearer realm="myco" 
4 /nope:  {"error":"unauthorized"} [401]
5 T2 posts sess_1:  {"error":"unauthorized"} [401]
5b lowercase bearer:  {"persisted":true,"duplicate":true} [200]
6 512KiB CL:  {"persisted":false,"reason":"body exceeds 327680 bytes"} [200]
7 2MiB CL:  {"persisted":false,"reason":"body exceeds 327680 bytes"} [200]
8 2MiB chunked:  {"persisted":false,"reason":"body exceeds 327680 bytes"} [200]
8b 16MiB chunked #1:  {"persisted":false,"reason":"body exceeds 327680 bytes"} [200]
8b 16MiB chunked #2:  {"persisted":false,"reason":"body exceeds 327680 bytes"} [200]
8b 16MiB chunked #3:  {"persisted":false,"reason":"body exceeds 327680 bytes"} [200]
8c health after drain:  {"ok":true} [200]
9 next normal {}:  {"persisted":false,"reason":"eventId must be a non-empty string"} [200]
11 40-deep:  {"persisted":false,"reason":"payload exceeds nesting depth 32"} [200]
12 malformed cred:  {"error":"unauthorized"} [401]
13 headers:  Cache-Control: no-store Strict-Transport-Security: max-age=31536000 x-content-type-options: nosniff 
14 300KiB string payload:  {"persisted":false,"reason":"payload exceeds 262144 bytes"} [200]
15 129-char eventId:  {"persisted":false,"reason":"eventId exceeds 128 characters"} [200]
16 legacy body:  {"persisted":false,"reason":"eventId must be a non-empty string"} [200]
16b createdAt 1e308:  {"persisted":false,"reason":"createdAt must be a non-negative integer"} [200]
17 T2 {}:  {"error":"unauthorized"} [401]
10 160k array:  {"persisted":false,"reason":"payload exceeds 100000 nodes"} [200]
===== RATE LIMITS
18 authenticated T1 posts (3×150):
 150 200 
 130 200   20 429 
 150 429 
18a anonymous right after 450 authenticated (source bucket untouched by members):
anon:  {"error":"unauthorized"} [401]
bad token:  {"error":"unauthorized"} [401]
valid T1 same source:  {"error":"rate limited"} [429]
19 anonymous posts (5×150) — expected 600×401 then 429:
 150 401 
 150 401 
 150 401 
 150 401 
 150 429 
19a-c probe with source exhausted:
anon:  {"error":"rate limited"} [429]
bad token:  {"error":"rate limited"} [429]
valid T1 same source:  {"persisted":false,"reason":"eventId must be a non-empty string"} [200]
health:  {"ok":true} [200]
===== D1 rows
events 4, sessions 3 (proj_1/sess_1/machine_1, proj_2/sess_1/machine_2, proj_2/sess_q/machine_2), started_at 1000
bytes_written: proj_1 228 (two stored events; replays and the conflict charged nothing), proj_2 141
===== wrangler log
5xx: 1 (the S1 schema-mismatch 503, by design)   Network connection lost: 0
status histogram: 331×200  610×401  323×429  1×503
telemetry kinds: 4 auth_failed  2 ingest_conflict  4 ingest_duplicate  4 ingest_ok  315 ingest_refused  1 schema_mismatch
auth_failed sample: {"kind":"auth_failed","route":"/events","source":"0:0:0:0::/64"}
```
