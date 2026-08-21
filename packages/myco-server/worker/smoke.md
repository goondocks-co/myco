# Live smoke — myco-server ingest

The whole procedure runs against a **real Cloudflare deployment**, not `wrangler dev`. Rows whose request body never completes cannot be observed locally: `wrangler dev`'s body-drain middleware throws before the Worker is invoked and the dev server exits, while the edge answers them itself. Running the procedure at the edge is therefore the default; the only local rows are the migration ones (`M1`–`M3`), which need `--local`.

## Rig

Name the rig for the run and delete it afterwards — the worker, the database, and the objects it wrote to the shared bucket. A rig that outlives its run is a second deployment nobody is watching.

```
wrangler d1 create myco-server-smoke<N>
wrangler r2 bucket create myco-server-blobs
wrangler d1 migrations apply myco-server-smoke<N> --remote -c wrangler.smoke.toml
npx wrangler deploy -c wrangler.smoke.toml
```

`wrangler.smoke.toml` is a gitignored copy of `wrangler.toml` carrying the rig's `database_id` and `name`; the committed file keeps its placeholder. Teardown:

```bash
npx wrangler r2 object delete myco-server-blobs/<project_id>/<key> --remote   # each key the run stored
npx wrangler delete --name myco-server-smoke<N> --force
npx wrangler d1 delete myco-server-smoke<N> -y
```

Delete the objects by the keys the run recorded, never by prefix: the bucket is shared with the real deployment, and a smoke project id can collide with a live one.

**A migration file that changed after it was applied is not re-applied.** `d1_migrations` records the file name, so editing `0002_v2.sql` in place leaves the database behind the code while `wrangler d1 migrations apply` reports `No migrations to apply!`. Observed on an earlier run: the database still lacked `blob_reservations`, and every blob request answered `503 {"stored":false,"reason":"unavailable"}`. In development, recreate the database; in production, add a new numbered step — never edit an applied one.

## Procedure

1. Seed two projects and mint **two machines in `proj_1`** plus one in `proj_2`, keeping the raw tokens in mode-600 files outside the repository. The foreign-machine rows (`A6`, `C4`) need a second machine in the *same* project: a token from another project addresses another project's sessions, so it would open its own session rather than collide with `machine_1`'s.

```bash
cd packages/myco-server/worker
export CLOUDFLARE_ACCOUNT_ID=<account>
sql() { npx wrangler d1 execute myco-server-smoke<N> --remote -c wrangler.smoke.toml --command "$1"; }
sql "INSERT INTO projects (project_id,name,created_at) VALUES ('proj_1','one',0),('proj_2','two',0)"
umask 077; D=$(mktemp -d)
npm run -s token:mint -- proj_1 machine_1 --print-token > $D/m1.sql 2> $D/m1.env
npm run -s token:mint -- proj_1 machine_2 --print-token > $D/m2.sql 2> $D/m2.env
npm run -s token:mint -- proj_2 machine_9 --print-token > $D/m9.sql 2> $D/m9.env
for f in m1 m2 m9; do sql "$(grep -v '^--' $D/$f.sql)"; done
T1=$(sed -n 's/^MYCO_MEMBER_TOKEN=//p' $D/m1.env); T2=$(sed -n 's/^MYCO_MEMBER_TOKEN=//p' $D/m2.env)
```

2. `export BASE=https://myco-server-smoke<N>.<account>.workers.dev` and poll `GET $BASE/health` until it answers `{"ok":true}`.

3. Run the rows below with the request shapes under **Requests**. Every member request carries `authorization: Bearer <token>` and `x-myco-protocol: 1`.

4. Read the database back with the final-state query, revoke the tokens (segment R), and delete `$D`.

5. Run `M1`–`M4` separately against a **local** database (`npx wrangler d1 migrations apply myco-server --local`) — they are about the applier, not the deployment.

## Requests

```bash
post() { curl -sS -m 25 -w ' [%{http_code}]\n' -X POST "$BASE/events" \
  -H "authorization: Bearer $1" -H 'x-myco-protocol: 1' -H 'content-type: application/json' --data "$2"; }
blob() { curl -sS -m 25 -w ' [%{http_code}]\n' -X POST "$BASE/blobs/$2" \
  -H "authorization: Bearer $1" -H 'x-myco-protocol: 1' -H "content-type: ${4:-text/plain}" --data-binary "$3"; }
refresh() { curl -sS -m 25 -w ' [%{http_code}]\n' -X POST "$BASE/tokens/refresh" \
  -H "authorization: Bearer $1" -H 'x-myco-protocol: 1' -H 'content-type: application/json' --data "${2:-{\}}"; }
```

`T2`–`T7` move the token's `expires_at` into the refresh window with `sql` (the window is the last quarter of a 7-day TTL; waiting is not a procedure) and keep each successor's raw token from the `refresh` answer in a mode-600 file next to the minted ones (`S1`, `S2` below).

`D1` is the one row whose request curl cannot build from its body: it declares a length it does not send. Override the header and hand curl a body that ends early, so the edge sees a truncated request:

```bash
head -c 100 /dev/zero | tr '\0' 'x' | curl -sS -m 25 -w ' [%{http_code}] t=%{time_total}s\n' -X POST \
  "$BASE/blobs/$(printf 'a%.0s' {1..64})" -H "authorization: Bearer $T1" -H 'x-myco-protocol: 1' \
  -H 'content-type: text/plain' -H 'content-length: 26214401' --data-binary @-
```

`E1` needs the token's counter at the ceiling with no blob behind it, which is what a token spends its quota on events for. Move it, run the upload, then put it back:

```bash
sql "UPDATE member_tokens SET bytes_written = 1073741823 WHERE id = '<TOKEN_ID_1>'"
blob "$T1" "$(printf 'quota-probe' | shasum -a 256 | cut -d' ' -f1)" 'quota-probe'
sql "SELECT bytes_written FROM member_tokens WHERE id = '<TOKEN_ID_1>'"
sql "SELECT COUNT(*) FROM blobs WHERE token_id = '<TOKEN_ID_1>'"
sql "UPDATE member_tokens SET bytes_written = <PREVIOUS> WHERE id = '<TOKEN_ID_1>'"
```

## Rows

| Row | Request | Expected |
|---|---|---|
| A1 | `session.start` from machine_1 | `{persisted:true, projected:true}` |
| A2 | `prompt` | `{persisted:true, projected:true}` |
| A3 | `response` for that prompt | `{persisted:true, projected:true}`; `prompt_batches.ended_at` settles |
| A4 | A2 replayed byte for byte | `{persisted:true, duplicate:true}` |
| A5 | A2's event id with another `createdAt` | `{persisted:false, code:'event_id_conflict', reason:'event id conflict'}` |
| A6 | A2's envelope replayed by machine_2 (same project) | `{persisted:false, code:'identity_mismatch', reason:'machine identity mismatch'}` |
| A7 | `createdAt` far ahead of the server clock — a fixed far-future constant (`4102444800000`, the year 2100), so a replay never drifts into the past | `{persisted:false, code:'clock_skew', reason:'createdAt is more than 300000 ms ahead of the server clock'}` |
| A8 | an unknown kind | `{persisted:false, code:'unknown_kind', reason:'unknown kind made.up'}` |
| A9 | an unknown payload field | `{persisted:false, code:'unknown_field', reason:'unknown field payload.nope'}` |
| B1 | blob upload | `{stored:true, duplicate:false, …, mediaType:'text/plain; charset=utf-8'}` |
| B2 | the same key presented as `image/png` | `{stored:true, duplicate:true, …, mediaType:'text/plain; charset=utf-8'}` — the row's type |
| B3 | bytes that do not match the key | `{stored:false, code:'digest_mismatch', reason:'digest mismatch'}` |
| B4 | `content-length: 0` | `{stored:false, code:'empty_body', reason:'empty body'}` |
| B5 | an unparseable `content-type` | `{stored:false, code:'media_type', reason:'invalid content-type'}` |
| B6 | an uppercase key in the path | `401` — the key grammar is lowercase hex |
| C1 | `transcript.segment` at offset 0 | `{persisted:true, projected:true, transcript:{size:10, segmentCount:1}}` |
| C2 | C1 replayed under its own event id | `{persisted:true, duplicate:true, transcript:{size:10, segmentCount:1}}` — unchanged |
| C3 | a segment past the held size | `{persisted:false, code:'offset_gap', reason:'transcript offset gap', transcript:{…}}` |
| C4 | a segment from machine_2 (same project) | `{persisted:false, code:'identity_mismatch', reason:'machine identity mismatch'}` |
| C5 | `x-myco-protocol: 99` | `409 {error:'protocol_version_unsupported', …}` |
| C6 | no protocol header | `409 {error:'protocol_version_unsupported', …}` |
| C7 | `GET /health` | no `x-myco-protocol` header |
| D1 | `content-length: 26214401` with 100 bytes sent, then closed | `400` from the edge; the Worker is never invoked |
| D2 | `GET /health` after D1 | `{ok:true}` |
| D3 | an honest 25 MiB + 1 body (declared == sent) | `{stored:false, code:'blob_cap', reason:'blob exceeds 26214400 bytes'}` |
| D4 | a `409` (protocol) with 25 MiB in flight | `409`, read cleanly by the client |
| D5 | `GET /health` after all of D | `{ok:true}` |
| D6 | a normal store after all of D | `{stored:true, duplicate:false, …}` |
| E1 | a blob upload by a token whose quota is spent on event bodies | `{stored:false, code:'quota', reason:'token write quota exceeded'}`; no `blobs` row appears and `bytes_written` does not move |
| E2 | `session.start` with `startedAt` at `4102444800000` | `{persisted:false, code:'clock_skew', reason:'startedAt is more than 300000 ms ahead of the server clock'}` |
| E3 | `session.end` with `endedAt` recomputed at run time as `now + 10*60*1000` (never the recorded absolute value, which sits in the past on replay) | `{persisted:false, code:'clock_skew', reason:'endedAt is more than 300000 ms ahead of the server clock'}` |
| E4 | `session.start` with `startedAt: 0` | `{persisted:true, projected:true}`; `sessions.started_at = 0` — history replays, only the future is bounded |
| E5 | an expired `blob_reservations` row seeded for the token, then any upload | the expired row is gone and the live ones remain |
| X1 | a token whose `member_tokens.machine_id` is NULL, on `/blobs` and on `/events` | `{stored:false, code:'no_machine_identity', reason:'token has no machine identity'}` and `{persisted:false, code:'no_machine_identity', reason:'token has no machine identity'}`; no blob, event, or session row |
| X2 | three `prompt` events on one `promptId` (e1 < e2 < e3 by `createdAt`; e2 carries `threadLabel` only, e3 `promptKind` only), delivered e1,e2,e3 to one prompt and e3,e1,e2 to another | both rows column-identical but for `prompt_id`/`event_id`/`received_at`: `prompt_kind` = e3's, `thread_label` NULL (e3 carried none), `created_at` = e1's, `updated_at` = e3's — the ranked winner supplies every merged column |
| X3 | a live `blob_reservations` row seeded for the token at `quota − bytes_written − 5`, then a 14-byte upload; the row deleted, the same upload again | first `{stored:false, code:'quota', reason:'token write quota exceeded'}` with `bytes_written` unmoved and the live row untouched; then `{stored:true, …}` and `bytes_written` + 14 |
| R1 | `/events` with a revoked token | `401` |
| R2 | `/blobs` with a revoked token | `401` |
| T1 | `refresh "$T1"` on a token minted today | `{refreshed:false, code:'refresh_too_early', reason:'refresh window not yet open', refreshAfter:<expires_at − 151200000>}` |
| T2 | `expires_at` of `<TOKEN_ID_1>` moved to now + 1 h (`sql "UPDATE member_tokens SET expires_at = <now + 3600000> WHERE id = '<TOKEN_ID_1>'"`), then `refresh "$T1"` | `{refreshed:true, token:<S1>, tokenId:<SID1>, expiresAt:<now + 604800000>, refreshAfter:<expiresAt − 151200000>}`; a new row with `predecessor_id = <TOKEN_ID_1>`, `lineage_root = <TOKEN_ID_1>`, `first_used_at NULL`, `bytes_written 0`; `post "$T1"` still `{persisted:true, …}` |
| T3 | `refresh "$T1"` again | a second successor `<SID2>`; `<SID1>` has `revoked_at` set; `SELECT COUNT(*) FROM member_tokens WHERE predecessor_id = '<TOKEN_ID_1>' AND revoked_at IS NULL` = 1 |
| T4 | first `post "$S2"` (any `prompt`) | `{persisted:true, …}`; `<SID2>` has `first_used_at` set and `bytes_written` = `<TOKEN_ID_1>`'s before the request plus this body; `<TOKEN_ID_1>` has `revoked_at` set; `post "$T1"` → `401` |
| T5 | `sql "UPDATE member_tokens SET expires_at = <now + 3600000>, lineage_started_at = <now + 3600000> - 7776000000 WHERE id = '<SID2>'"` (one statement: the token sits at its lineage ceiling inside the window), then `refresh "$S2"` | `{refreshed:false, code:'lineage_expired', reason:'token lineage expired'}`; no new row |
| T6 | `refresh "$S2"` with body `not json` | `{refreshed:false, code:'parse', reason:'body must be JSON'}` |
| T7 | `sql "$(npm run -s token:revoke -- <SID2> --lineage)"` | reports 1 row changed (`<SID2>` was the chain's only live token); `post "$S2"` → `401`; `post "$T2"` (another lineage, into its own session) still `{persisted:true, …}` |
| M1 | `migrations apply` on a fresh database | `0001 ✅ 0002 ✅ 0003 ✅`, `schema_meta.version = 3` |
| M2 | `migrations apply` on a v1 database holding `bad/id` | `CHECK constraint failed: ok = 1`; `d1_migrations` keeps only `0001`; version stays `1` |
| M3 | the row repaired, `migrations apply` again | `0002 ✅ 0003 ✅`, version `3`, two triggers, `member_tokens` carries `lineage_root = id` on every row |
| M4 | `migrations apply` on a v1 database holding a session whose token has no `machine_id` | `CHECK constraint failed: ok = 1`; version stays `1`; `events` has no `producer_adapter` column (the guard runs ahead of every `ADD COLUMN`); repaired per BREAK-GLASS, `migrations apply` again completes |

## Last observed output — in-process (T1–T7)

Run on 2026-08-21 through the in-process worker (`tests/myco-server/helpers/d1.ts` over the migrated schema, `index.ts default.fetch`, real clock), with the `expires_at`/`lineage_started_at` moves of the rows above applied by SQL; raw tokens redacted, ids as issued. No edge output yet.

```
T1 {"refreshed":false,"code":"refresh_too_early","reason":"refresh window not yet open","refreshAfter":1787733922356} [200]
T2 {"refreshed":true,"token":"<S1>","tokenId":"mt_cahT64SpjD_5yZLV","expiresAt":1787885122359,"refreshAfter":1787733922359} [200]; row {"id":"mt_cahT64SpjD_5yZLV","predecessor_id":"mt_iG5ojkEarMgZD9x3","lineage_root":"mt_iG5ojkEarMgZD9x3","first_used_at":null,"revoked_at":null,"bytes_written":0}; post T1 {"persisted":true,"projected":true} [200]
T3 {"refreshed":true,"token":"<S2>","tokenId":"mt_DiFY2rJ6_M0gFnLd","expiresAt":1787885122360,"refreshAfter":1787733922360} [200]; S1 row {…,"first_used_at":null,"revoked_at":1787280322360,"bytes_written":0}; live successors [{"c":1}]
T4 post S2 {"persisted":true,"projected":true} [200]; T1 before {…,"revoked_at":null,"bytes_written":269}; T1 after {…,"revoked_at":1787280322360,"bytes_written":269}; S2 {…,"first_used_at":1787280322360,"revoked_at":null,"bytes_written":538}; post T1 {"error":"unauthorized"} [401]
T5 {"refreshed":false,"code":"lineage_expired","reason":"token lineage expired"} [200]; rows [{"c":4}]
T6 {"refreshed":false,"code":"parse","reason":"body must be JSON"} [200]
T7 revoked {"revoked":1}; post S2 {"error":"unauthorized"} [401]; post T2 {"persisted":false,"code":"identity_mismatch","reason":"machine identity mismatch"} [200] — T2 authenticated and reached the handler (this run wrote it into machine_1's session; the edge row uses T2's own session)
```

## Last observed output — edge

Recorded before refusal bodies carried `code` and before `POST /tokens/refresh` existed; the `## Rows` table above is the current contract, and `T1`–`T7` have no edge output yet.

Run on 2026-08-18 against `myco-server-smoke7` (worker `myco-server-smoke7`, its own D1 `myco-server-smoke7`, the shared `myco-server-blobs` bucket; worker, database and every object this run stored were deleted afterwards — teardown proof at the end of this section). Deployed version `f1ea6451-0931-408d-8be1-829c3c14f89b`; migrations `0001 ✅ 0002 ✅` applied remotely before deploy. Tokens: `machine_1`/`machine_2` in `proj_1` (`mt_MSugzSw07q-Y1WmQ`, `mt_J-23zh2xeVD_k69w`), `machine_9` in `proj_2` (`mt_v_sLCLQrS3TrhjA6`); raw tokens redacted as `<T1>`/`<T2>`/`<T9>`. Every member request carries `authorization: Bearer <token>`, `x-myco-protocol: 1`, and `content-type: application/json` (events), sent with the `post`/`blob` helpers of `## Requests`; **every request body is recorded verbatim under its row**, so each row reproduces from this file alone — the two clock-relative rows excepted: `A7`'s `createdAt` and `E3`'s `endedAt` are recomputed against the server clock at run time (the values recorded here were the wall-clock values on 2026-08-18 and now sit in the past), per the recipe in their `## Rows` entries. Result: PASS, 0 failed rows, no edge-error retries.

### A · events, identity, merges

Session for A: `bc5f49e3-4394-4110-baae-53cd8aa8615f`, prompt `ef0ca0a0-6251-4691-90b5-bfcba7aee427`.

```
## A1 session.start
REQ POST /events (Bearer T1) body: {"eventId":"7b43b384-cd23-4c81-aa17-df4a5c289622","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"session.start","createdAt":1723800000100,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"agent":"claude-code","branch":"main","startedAt":1723800000000,"originPath":"/tmp/x"}}
RES {"persisted":true,"projected":true} [200]
## A2 prompt
REQ POST /events (Bearer T1) body: {"eventId":"409a63a1-b1b7-4bbc-a258-535860773875","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"prompt","createdAt":1723800001000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"promptId":"ef0ca0a0-6251-4691-90b5-bfcba7aee427","text":"hello","origin":"user"}}
RES {"persisted":true,"projected":true} [200]
## A3 response
REQ POST /events (Bearer T1) body: {"eventId":"9da884ff-98f2-4955-a1b2-ddc737210727","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"response","createdAt":1723800002000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"responseId":"9da884ff-98f2-4955-a1b2-ddc737210727","promptId":"ef0ca0a0-6251-4691-90b5-bfcba7aee427","text":"hi back"}}
RES {"persisted":true,"projected":true} [200]
A3 check: [{"prompt_id":"ef0ca0a0-6251-4691-90b5-bfcba7aee427","ended_at":1723800002000}]
## A4 A2 replayed byte for byte
REQ POST /events (Bearer T1) body: {"eventId":"409a63a1-b1b7-4bbc-a258-535860773875","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"prompt","createdAt":1723800001000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"promptId":"ef0ca0a0-6251-4691-90b5-bfcba7aee427","text":"hello","origin":"user"}}
RES {"persisted":true,"duplicate":true} [200]
## A5 A2's event id, other createdAt
REQ POST /events (Bearer T1) body: {"eventId":"409a63a1-b1b7-4bbc-a258-535860773875","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"prompt","createdAt":1723800001001,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"promptId":"ef0ca0a0-6251-4691-90b5-bfcba7aee427","text":"hello","origin":"user"}}
RES {"persisted":false,"reason":"event id conflict"} [200]
## A6 A2's envelope replayed by machine_2
REQ POST /events (Bearer T2) body: {"eventId":"409a63a1-b1b7-4bbc-a258-535860773875","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"prompt","createdAt":1723800001000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"promptId":"ef0ca0a0-6251-4691-90b5-bfcba7aee427","text":"hello","origin":"user"}}
RES {"persisted":false,"reason":"machine identity mismatch"} [200]
## A7 createdAt +1h
NOTE (replay): recompute `createdAt` to a far-future constant (e.g. `4102444800000`); the `1787084518000` recorded below was +1h ahead of the clock on 2026-08-18 and now sits in the past.
REQ POST /events (Bearer T1) body: {"eventId":"cc7fbdac-fb60-4ed0-b884-b91bdf9a3af3","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"prompt","createdAt":1787084518000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"promptId":"c465030c-e323-4840-b7b6-294f16a56ac3","text":"future","origin":"user"}}
RES {"persisted":false,"reason":"createdAt is more than 300000 ms ahead of the server clock"} [200]
## A8 unknown kind
REQ POST /events (Bearer T1) body: {"eventId":"0ac77a45-e6e1-4058-909b-dac726597682","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"made.up","createdAt":1787080918000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{}}
RES {"persisted":false,"reason":"unknown kind made.up"} [200]
## A9 unknown payload field
REQ POST /events (Bearer T1) body: {"eventId":"e28431a8-9224-482e-9123-388edd6abbe9","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"prompt","createdAt":1787080918000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"promptId":"6fe2b12f-0f5f-4fe3-b01f-54cdd60b590a","text":"x","origin":"user","nope":1}}
RES {"persisted":false,"reason":"unknown field payload.nope"} [200]
```

Verdict A: A1 PASS, A2 PASS, A3 PASS (`prompt_batches.ended_at = 1723800002000`, the response's createdAt), A4 PASS, A5 PASS, A6 PASS, A7 PASS, A8 PASS, A9 PASS. No edge errors in A.

### B · blobs

```
## B1 store
REQ POST /blobs/7dc52e7d421b3410eec3158d6d3a7d7750aa31a75abf64f5b2e740c17ca5aac1 (Bearer T1) content-type: 'text/plain' body: 'hello smoke7 b1' 
RES {"stored":true,"duplicate":false,"key":"7dc52e7d421b3410eec3158d6d3a7d7750aa31a75abf64f5b2e740c17ca5aac1","size":15,"mediaType":"text/plain; charset=utf-8"} [200]
## B2 same key presented as image/png
REQ POST /blobs/7dc52e7d421b3410eec3158d6d3a7d7750aa31a75abf64f5b2e740c17ca5aac1 (Bearer T1) content-type: 'image/png' body: 'hello smoke7 b1' 
RES {"stored":true,"duplicate":true,"key":"7dc52e7d421b3410eec3158d6d3a7d7750aa31a75abf64f5b2e740c17ca5aac1","size":15,"mediaType":"text/plain; charset=utf-8"} [200]
## B3 bytes that do not match the key (key = sha256('other bytes'), body 'not those bytes')
REQ POST /blobs/a3ead5eedad5df82318c51685dbc1c147a36d1ff8584fc82de6b08d0bf63a795 (Bearer T1) content-type: 'text/plain' body: 'not those bytes' 
RES {"stored":false,"reason":"digest mismatch"} [200]
## B4 content-length: 0
REQ POST /blobs/a3ead5eedad5df82318c51685dbc1c147a36d1ff8584fc82de6b08d0bf63a795 (Bearer T1) content-type: text/plain, empty body (content-length: 0)
RES {"stored":false,"reason":"empty body"} [200]
## B5 unparseable content-type
REQ POST /blobs/a3ead5eedad5df82318c51685dbc1c147a36d1ff8584fc82de6b08d0bf63a795 (Bearer T1) content-type: 'nonsense' body: 'other bytes' 
RES {"stored":false,"reason":"invalid content-type"} [200]
## B6 uppercase key in the path
REQ POST /blobs/A3EAD5EEDAD5DF82318C51685DBC1C147A36D1FF8584FC82DE6B08D0BF63A795 (Bearer T1) content-type: text/plain body: 'other bytes'
RES {"error":"unauthorized"} [401]
B check: [{"key":"7dc52e7d421b3410eec3158d6d3a7d7750aa31a75abf64f5b2e740c17ca5aac1","size":15,"media_type":"text/plain; charset=utf-8","token_id":"mt_MSugzSw07q-Y1WmQ"}]
```

Verdict B: B1 PASS, B2 PASS (row type `text/plain; charset=utf-8` reported), B3 PASS, B4 PASS, B5 PASS, B6 PASS. R2 keys stored so far: `proj_1/7dc52e7d421b3410eec3158d6d3a7d7750aa31a75abf64f5b2e740c17ca5aac1`. No edge errors in B.

### C · transcripts and the protocol window

```
## C0 blob for the segment
REQ POST /blobs/df5f2a3a4065f021a63fc8fba37c01e6a8c52ccf08b748d39a301ed4bca6e288 (Bearer T1) content-type: text/plain body: 'segment-01'
RES {"stored":true,"duplicate":false,"key":"df5f2a3a4065f021a63fc8fba37c01e6a8c52ccf08b748d39a301ed4bca6e288","size":10,"mediaType":"text/plain; charset=utf-8"} [200]
## C1 transcript.segment at offset 0
REQ POST /events (Bearer T1) body: {"eventId":"1d8e6109-7067-4ffb-a5d7-613a8f739a3e","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"transcript.segment","createdAt":1723800003000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"transcriptId":"cf6602e8-afd0-4ede-93bb-bf2814acb525","baseOffset":0,"length":10,"blob":"df5f2a3a4065f021a63fc8fba37c01e6a8c52ccf08b748d39a301ed4bca6e288"}} 
RES {"persisted":true,"projected":true,"transcript":{"size":10,"segmentCount":1}} [200]
## C2 C1 replayed under its own event id
REQ POST /events (Bearer T1) body: {"eventId":"1d8e6109-7067-4ffb-a5d7-613a8f739a3e","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"transcript.segment","createdAt":1723800003000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"transcriptId":"cf6602e8-afd0-4ede-93bb-bf2814acb525","baseOffset":0,"length":10,"blob":"df5f2a3a4065f021a63fc8fba37c01e6a8c52ccf08b748d39a301ed4bca6e288"}} 
RES {"persisted":true,"duplicate":true,"transcript":{"size":10,"segmentCount":1}} [200]
## C3 segment past the held size (offset 20, held 10)
REQ POST /events (Bearer T1) body: {"eventId":"c1c76fa7-d17c-469a-98ee-a5f6ddd69621","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"transcript.segment","createdAt":1723800004000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"transcriptId":"cf6602e8-afd0-4ede-93bb-bf2814acb525","baseOffset":20,"length":10,"blob":"df5f2a3a4065f021a63fc8fba37c01e6a8c52ccf08b748d39a301ed4bca6e288"}} 
RES {"persisted":false,"reason":"transcript offset gap","transcript":{"size":10,"segmentCount":1}} [200]
## C4 segment at offset 10 from machine_2
REQ POST /events (Bearer T2) body: {"eventId":"92964500-0b8c-4b4c-a7a4-d38dc36aa890","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"transcript.segment","createdAt":1723800004000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"transcriptId":"cf6602e8-afd0-4ede-93bb-bf2814acb525","baseOffset":10,"length":10,"blob":"df5f2a3a4065f021a63fc8fba37c01e6a8c52ccf08b748d39a301ed4bca6e288"}} 
RES {"persisted":false,"reason":"machine identity mismatch"} [200]
## C5 x-myco-protocol: 99
REQ POST /events (Bearer T1) header x-myco-protocol: 99 body: {"eventId":"55455df4-7eb0-42e7-a55d-3ae39fb949cd","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"notification","createdAt":1787080972000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"message":"c5"}}
RES {"error":"protocol_version_unsupported","server_protocol":1,"min_compat_member_protocol":1} [409]
## C6 no protocol header
REQ POST /events (Bearer T1) NO x-myco-protocol header body: {"eventId":"5bf7efd5-7012-44ee-8ddf-b8fbb6bc0d46","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"notification","createdAt":1787080972000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"message":"c6"}}
RES {"error":"protocol_version_unsupported","server_protocol":1,"min_compat_member_protocol":1} [409]
## C7 GET /health headers
REQ GET /health
HTTP/2 200 
content-type: application/json
content-length: 11
cache-control: no-store
strict-transport-security: max-age=31536000
x-content-type-options: nosniff
server: cloudflare

x-myco-protocol header count: 0
C check: [{"transcript_id":"cf6602e8-afd0-4ede-93bb-bf2814acb525","size":10,"segment_count":1,"machine_id":"machine_1"}]
```

Verdict C: C1 PASS, C2 PASS (held size unchanged), C3 PASS, C4 PASS, C5 PASS, C6 PASS, C7 PASS (no `x-myco-protocol` on `/health`). R2 key stored: `proj_1/df5f2a3a4065f021a63fc8fba37c01e6a8c52ccf08b748d39a301ed4bca6e288`. No edge errors in C.

### D · request bodies the platform handles

```
## D1 truncated body: declared content-length 26214401, 100 bytes sent, then closed
REQ head -c 100 /dev/zero | tr '\0' 'x' | curl -sS -m 25 -X POST $BASE/blobs/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -H 'authorization: Bearer <T1>' -H 'x-myco-protocol: 1' -H 'content-type: text/plain' -H 'content-length: 26214401' --data-binary @-
RES <html>
<head><title>400 Bad Request</title></head>
<body>
<center><h1>400 Bad Request</h1></center>
<hr><center>cloudflare</center>
</body>
</html>
 [400] t=0.056013s

## D2 GET /health after D1
REQ GET /health
RES {"ok":true} [200]
## D3 honest 25 MiB + 1 body (26214401 zero bytes, declared == sent), key sha256 of that body
REQ POST /blobs/0765445211e5f3faf9378e5dd89603fe38c13f5863158906ece6fd1369631087 (Bearer T1) content-type: application/octet-stream --data-binary @over.bin (26214401 B)
RES {"stored":false,"reason":"blob exceeds 26214400 bytes"} [200] t=22.181419s
## D4 409 (x-myco-protocol: 99) with 25 MiB in flight
REQ POST /blobs/394c345f0b0c63ee652627a62eed069244d35c4d5134e4f07d4eabb51afda47e (Bearer T1) x-myco-protocol: 99 content-type: application/octet-stream --data-binary @cap.bin (26214400 B)
RES {"error":"protocol_version_unsupported","server_protocol":1,"min_compat_member_protocol":1} [409] t=22.603800s
## D5 GET /health after all of D
REQ GET /health
RES {"ok":true} [200]
## D6 normal store after all of D
REQ POST /blobs/83e70cf1ae8575acb5cb0f4aaa5f211953554dd48f6c0a4ece476e393cea2157 (Bearer T1) content-type: text/plain body: 'after-d smoke7'
RES {"stored":true,"duplicate":false,"key":"83e70cf1ae8575acb5cb0f4aaa5f211953554dd48f6c0a4ece476e393cea2157","size":14,"mediaType":"text/plain; charset=utf-8"} [200]
D check blobs: [{"key":"7dc52e7d421b3410eec3158d6d3a7d7750aa31a75abf64f5b2e740c17ca5aac1","size":15},{"key":"df5f2a3a4065f021a63fc8fba37c01e6a8c52ccf08b748d39a301ed4bca6e288","size":10},{"key":"83e70cf1ae8575acb5cb0f4aaa5f211953554dd48f6c0a4ece476e393cea2157","size":14}]
D check reservations: []
```

Verdict D: D1 PASS (edge `400` in 56 ms, Worker never invoked — this is the expected edge answer, not an edge error), D2 PASS, D3 PASS, D4 PASS, D5 PASS, D6 PASS. D3/D4 wall time ~22 s is upload bandwidth from this machine (25 MiB each), inside the 25 s cap. No blob row and no reservation was left behind by D1/D3/D4. R2 key stored: `proj_1/83e70cf1ae8575acb5cb0f4aaa5f211953554dd48f6c0a4ece476e393cea2157`.

### E · one counter, the clock bound on an ordering, and the reservation sweep

```
E1 bytes_written before: 1365
SQL UPDATE member_tokens SET bytes_written = 1073741823 WHERE id = 'mt_MSugzSw07q-Y1WmQ'
## E1 blob upload by a token whose quota is spent on event bodies
REQ POST /blobs/a45ade09ad3855d8eb285ffe2c5a5c12dc032b8ae24063226ebd9b27d7019cf1 (Bearer T1) content-type: text/plain body: 'quota-probe'
RES {"stored":false,"reason":"token write quota exceeded"} [200]
E1 bytes_written after: [{"bytes_written":1073741823}]
E1 blobs rows for the probe key: [{"n":0}]
E1 R2 object for the probe key: ✘ [ERROR] The specified key does not exist.
SQL UPDATE member_tokens SET bytes_written = 1365 WHERE id = 'mt_MSugzSw07q-Y1WmQ'
E1 bytes_written restored: [{"bytes_written":1365}]
## E2 session.start with startedAt 4102444800000 (new session bcea953a-fa1c-4668-b0e3-ec84aa7820c6)
REQ POST /events (Bearer T1) body: {"eventId":"2f7d2d5d-1a94-40fd-9d61-3f40a0b353dd","sessionId":"bcea953a-fa1c-4668-b0e3-ec84aa7820c6","kind":"session.start","createdAt":1723800000000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"agent":"claude-code","startedAt":4102444800000}} 
RES {"persisted":false,"reason":"startedAt is more than 300000 ms ahead of the server clock"} [200]
## E3 session.end with endedAt 10 min ahead of now
NOTE (replay): recompute `endedAt` as `now + 10*60*1000` (and `createdAt` near `now`); the absolute values recorded below were the wall clock on 2026-08-18 and now sit in the past.
REQ POST /events (Bearer T1) body: {"eventId":"2186db4f-4e35-4003-84e8-1271b90d1c3d","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"session.end","createdAt":1787081080000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"endedAt":1787081680000}} 
RES {"persisted":false,"reason":"endedAt is more than 300000 ms ahead of the server clock"} [200]
## E4 session.start with startedAt 0 (new session a3fd438d-d16b-4e7f-84d8-0af69fef3a62)
REQ POST /events (Bearer T1) body: {"eventId":"c306f906-76d9-41cd-85ac-0401b9d57149","sessionId":"a3fd438d-d16b-4e7f-84d8-0af69fef3a62","kind":"session.start","createdAt":1723800000000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"agent":"claude-code","startedAt":0}} 
RES {"persisted":true,"projected":true} [200]
E4 check: [{"session_id":"a3fd438d-d16b-4e7f-84d8-0af69fef3a62","started_at":0,"machine_id":"machine_1"}]
SQL INSERT INTO blob_reservations (reservation_id, project_id, key, token_id, size, expires_at) VALUES ('smoke-dead-1','proj_1','dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd','mt_MSugzSw07q-Y1WmQ',5,1787081021000),('smoke-dead-2','proj_1','eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee','mt_MSugzSw07q-Y1WmQ',5,1787081080999),('smoke-live','proj_1','ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff','mt_MSugzSw07q-Y1WmQ',5,1787084681000)
E5 reservations before: [{"reservation_id":"smoke-dead-1","expires_at":1787081021000},{"reservation_id":"smoke-dead-2","expires_at":1787081080999},{"reservation_id":"smoke-live","expires_at":1787084681000}]
## E5 upload that reserves
REQ POST /blobs/d03b559c85315013f5d53c4bacb9538819c8d1f3c00123cb554859cd3d90f3dc (Bearer T1) content-type: text/plain body: 'reserve smoke7'
RES {"stored":true,"duplicate":false,"key":"d03b559c85315013f5d53c4bacb9538819c8d1f3c00123cb554859cd3d90f3dc","size":14,"mediaType":"text/plain; charset=utf-8"} [200]
E5 reservations after: [{"reservation_id":"smoke-live","expires_at":1787084681000}]
SQL DELETE FROM blob_reservations WHERE reservation_id='smoke-live'  (cleanup of the seeded live row)
```

Verdict E: E1 PASS (`token write quota exceeded`; `bytes_written` unmoved at 1073741823, 0 blob rows, R2 key absent; counter restored to 1365 afterwards), E2 PASS, E3 PASS, E4 PASS (`sessions.started_at = 0`, machine_1), E5 PASS (both expired rows swept, `smoke-live` remained; the seeded live row was then deleted by SQL as cleanup). R2 key stored: `proj_1/d03b559c85315013f5d53c4bacb9538819c8d1f3c00123cb554859cd3d90f3dc`. No edge errors in E.

### X · a machine-less token on both routes, three-event order independence, and a live reservation at admission

```
SQL (X1 token row; hash redacted): INSERT INTO member_tokens (id, project_id, machine_id, token_hash, expires_at, revoked_at, bytes_written)               VALUES ('mt_QQ1NPe1wd0iN48no', 'proj_1', NULL, '<sha256>', 1787685921617, NULL, 0); 
X1 token row: [{"id":"mt_QQ1NPe1wd0iN48no","project_id":"proj_1","machine_id":null,"revoked_at":null}]
## X1a POST /blobs with a token that has no machine identity
REQ POST /blobs/cbfe41a9d619199548c3021a6ef6cebefc15f988a64ea6720002760819445d88 (Bearer TX, machine_id NULL) content-type: text/plain body: 'x1 smoke7'
RES {"stored":false,"reason":"token has no machine identity"} [200]
## X1b POST /events with the same token (new session fde9158c-1e25-455f-a693-2ad650621fcd)
REQ POST /events (Bearer TX, machine_id NULL) body: {"eventId":"b44c1914-35b1-4d72-8f7c-c3efc7543950","sessionId":"fde9158c-1e25-455f-a693-2ad650621fcd","kind":"session.start","createdAt":1723800000000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"agent":"claude-code"}}
RES {"persisted":false,"reason":"token has no machine identity"} [200]
X1 check: blobs rows for the key: [{"n":0}], events rows for the session: [{"n":0}], sessions rows: [{"n":0}]
SQL UPDATE member_tokens SET revoked_at = 1787081126000 WHERE id = 'mt_QQ1NPe1wd0iN48no' AND revoked_at IS NULL
X1 token revoked: [{"id":"mt_QQ1NPe1wd0iN48no","revoked":1}]

## X2 three prompt events on one promptId, two delivery orders across two promptIds
order for PA: e1,e2,e3   order for PB: e3,e1,e2 (e_n = createdAt 172380010n000)
REQ (PA e1) POST /events (Bearer T1) body: {"eventId":"8a3e9332-7521-44d6-b890-95a8bb97cfef","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"prompt","createdAt":1723800101000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"promptId":"8544bd04-cba5-4420-819f-8b4a4355d204","text":"x2 text","origin":"user","promptKind":"k1","threadLabel":"first"}}
RES {"persisted":true,"projected":true} [200]
REQ (PA e2) POST /events (Bearer T1) body: {"eventId":"b22bbdf1-ee74-4d5e-a402-28088f317207","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"prompt","createdAt":1723800102000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"promptId":"8544bd04-cba5-4420-819f-8b4a4355d204","text":"x2 text","origin":"user","threadLabel":"second"}}
RES {"persisted":true,"projected":true} [200]
REQ (PA e3) POST /events (Bearer T1) body: {"eventId":"e9491b45-497e-43a8-afd6-d67259c343b9","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"prompt","createdAt":1723800103000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"promptId":"8544bd04-cba5-4420-819f-8b4a4355d204","text":"x2 text","origin":"user","promptKind":"k3"}}
RES {"persisted":true,"projected":true} [200]
REQ (PB e3) POST /events (Bearer T1) body: {"eventId":"a9d19ce4-0b1c-4e76-b07f-21065a2eeefa","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"prompt","createdAt":1723800103000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"promptId":"2ade166b-b354-4280-a7cc-15033a45aade","text":"x2 text","origin":"user","promptKind":"k3"}}
RES {"persisted":true,"projected":true} [200]
REQ (PB e1) POST /events (Bearer T1) body: {"eventId":"a6d2059a-a713-4656-9714-d0e86f85bf5e","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"prompt","createdAt":1723800101000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"promptId":"2ade166b-b354-4280-a7cc-15033a45aade","text":"x2 text","origin":"user","promptKind":"k1","threadLabel":"first"}}
RES {"persisted":true,"projected":true} [200]
REQ (PB e2) POST /events (Bearer T1) body: {"eventId":"3634b47c-3e8e-475b-afd8-09ea9d823452","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"prompt","createdAt":1723800102000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"promptId":"2ade166b-b354-4280-a7cc-15033a45aade","text":"x2 text","origin":"user","threadLabel":"second"}}
RES {"persisted":true,"projected":true} [200]
X2 rows: [{"project_id":"proj_1","prompt_id":"2ade166b-b354-4280-a7cc-15033a45aade","session_id":"bc5f49e3-4394-4110-baae-53cd8aa8615f","event_id":"a9d19ce4-0b1c-4e76-b07f-21065a2eeefa","parent_prompt_id":null,"thread_id":null,"thread_label":null,"origin":"user","prompt_kind":"k3","text":"x2 text","blob_key":null,"content_hash":"3c9b4e5757166d03189e0af1349c816eaf8ab58cec1b6aa486b6254fbd47673e","created_at":1723800101000,"updated_at":1723800103000,"ended_at":null,"token_id":"mt_MSugzSw07q-Y1WmQ","received_at":1787081128437},{"project_id":"proj_1","prompt_id":"8544bd04-cba5-4420-819f-8b4a4355d204","session_id":"bc5f49e3-4394-4110-baae-53cd8aa8615f","event_id":"e9491b45-497e-43a8-afd6-d67259c343b9","parent_prompt_id":null,"thread_id":null,"thread_label":null,"origin":"user","prompt_kind":"k3","text":"x2 text","blob_key":null,"content_hash":"3c9b4e5757166d03189e0af1349c816eaf8ab58cec1b6aa486b6254fbd47673e","created_at":1723800101000,"updated_at":1723800103000,"ended_at":null,"token_id":"mt_MSugzSw07q-Y1WmQ","received_at":1787081127829}]
X2 EA3=e9491b45-497e-43a8-afd6-d67259c343b9 EB3=a9d19ce4-0b1c-4e76-b07f-21065a2eeefa

## X3 a live reservation counts against admission (interpretation: seed a live reservation of size quota-bytes_written-5 for T1, then upload 14 bytes)
bytes_written now: 3594; seeded reservation size: 1073738225
SQL INSERT INTO blob_reservations (reservation_id, project_id, key, token_id, size, expires_at) VALUES ('smoke-x3-live','proj_1','9999999999999999999999999999999999999999999999999999999999999999','mt_MSugzSw07q-Y1WmQ',1073738225,1787084749000)
REQ POST /blobs/24ae3403cb00a1d2e546fba738a6fe2efba2632ec33fbc5bced2659fc9ebeb26 (Bearer T1) content-type: text/plain body: 'x3 live smoke7' (14 B) with the live reservation held
RES {"stored":false,"reason":"token write quota exceeded"} [200]
X3 reservations after refused upload: [{"reservation_id":"smoke-x3-live","size":1073738225}]   bytes_written: [{"bytes_written":3594}]
SQL DELETE FROM blob_reservations WHERE reservation_id='smoke-x3-live'
REQ same upload again with the reservation released
RES {"stored":true,"duplicate":false,"key":"24ae3403cb00a1d2e546fba738a6fe2efba2632ec33fbc5bced2659fc9ebeb26","size":14,"mediaType":"text/plain; charset=utf-8"} [200]
X3 reservations after: []   bytes_written: [{"bytes_written":3608}]
```

Verdict X: X1 PASS — a `member_tokens` row inserted by SQL with `machine_id NULL` (`mt_QQ1NPe1wd0iN48no`, minted via `token:mint` for `machine_x` and the literal replaced by `NULL`; `token:mint` itself has no NULL path) is refused on both routes with `token has no machine identity`, leaving no blob, event, or session row; the row was revoked by SQL afterwards. X2 PASS — the two `prompt_batches` rows (`PA` delivered e1,e2,e3; `PB` delivered e3,e1,e2) are column-identical except `prompt_id`, `event_id` (each row's own e3, the highest-ranked event) and `received_at` (wall clock of the first insert, not merged): `prompt_kind = k3`, `thread_label = NULL` (e3 carried none, so the highest-ranked event's absent field cleared e2's `second`), `created_at = 1723800101000`, `updated_at = 1723800103000`, same `content_hash`. X3 PASS — interpreted as "a live reservation counts against admission": with a seeded live reservation of `quota - bytes_written - 5` bytes held, a 14-byte upload is refused `token write quota exceeded`, `bytes_written` unmoved and the live row untouched; released, the same upload stores and charges 14. R2 key stored: `proj_1/24ae3403cb00a1d2e546fba738a6fe2efba2632ec33fbc5bced2659fc9ebeb26`. No edge errors in X.

### R · revocation and final state

```
SQL UPDATE member_tokens SET revoked_at = 1787081178130 WHERE id = 'mt_MSugzSw07q-Y1WmQ' AND revoked_at IS NULL;
SQL UPDATE member_tokens SET revoked_at = 1787081179201 WHERE id = 'mt_J-23zh2xeVD_k69w' AND revoked_at IS NULL;
SQL UPDATE member_tokens SET revoked_at = 1787081180386 WHERE id = 'mt_v_sLCLQrS3TrhjA6' AND revoked_at IS NULL;
tokens: [{"id":"mt_J-23zh2xeVD_k69w","machine_id":"machine_2","revoked":1},{"id":"mt_MSugzSw07q-Y1WmQ","machine_id":"machine_1","revoked":1},{"id":"mt_QQ1NPe1wd0iN48no","machine_id":null,"revoked":1},{"id":"mt_v_sLCLQrS3TrhjA6","machine_id":"machine_9","revoked":1}]
## R1 /events with a revoked token
REQ POST /events (Bearer T1, revoked) body: {"eventId":"5d4a0c72-11ab-4e1b-bace-a8d62de21508","sessionId":"bc5f49e3-4394-4110-baae-53cd8aa8615f","kind":"notification","createdAt":1787081182000,"channel":"cli","producer":{"adapter":"smoke","version":"1"},"payload":{"message":"r1"}}
RES {"error":"unauthorized"} [401]
## R2 /blobs with a revoked token
REQ POST /blobs/d834b1e52d12686319d31f80ef90ee252caaee8a1ba9d2ced2aeb3a9f03e0a5b (Bearer T1, revoked) content-type: text/plain body: 'r2 smoke7'
RES {"error":"unauthorized"} [401]
## final state
[{"events":11,"prompt_batches":3,"ended_at":1723800002000,"blobs":5,"transcript_segments":1,"live_reservations":0,"sessions_null_machine":0,"sessions":2,"v":"2"}]
blobs: [{"project_id":"proj_1","key":"7dc52e7d421b3410eec3158d6d3a7d7750aa31a75abf64f5b2e740c17ca5aac1","size":15},{"project_id":"proj_1","key":"df5f2a3a4065f021a63fc8fba37c01e6a8c52ccf08b748d39a301ed4bca6e288","size":10},{"project_id":"proj_1","key":"83e70cf1ae8575acb5cb0f4aaa5f211953554dd48f6c0a4ece476e393cea2157","size":14},{"project_id":"proj_1","key":"d03b559c85315013f5d53c4bacb9538819c8d1f3c00123cb554859cd3d90f3dc","size":14},{"project_id":"proj_1","key":"24ae3403cb00a1d2e546fba738a6fe2efba2632ec33fbc5bced2659fc9ebeb26","size":14}]
events by kind: [{"kind":"prompt","n":7},{"kind":"response","n":1},{"kind":"session.start","n":2},{"kind":"transcript.segment","n":1}]
```

Verdict R: R1 PASS, R2 PASS. Final state: `events 11 | prompt_batches 3 | ended_at 1723800002000 | blobs 5 | transcript_segments 1 | live_reservations 0 | sessions with NULL machine_id 0 | sessions 2 | schema version 2`. The 11 events are A1, A2, A3, C1, E4 and the six X2 prompts; the 5 blobs are exactly the 5 R2 keys the run stored (B1, C0, D6, E5, X3). No edge errors in R.

### Edge-error retries

None. No row in this run answered a Cloudflare edge error page (1042/1104/1101); every response above is the first send. (D1's `400 Bad Request` from cloudflare is the row's expected edge answer, not an error page.)

### Teardown proof

```
CMD npx wrangler r2 object delete myco-server-blobs/proj_1/7dc52e7d421b3410eec3158d6d3a7d7750aa31a75abf64f5b2e740c17ca5aac1 --remote
Delete complete.
CMD npx wrangler r2 object delete myco-server-blobs/proj_1/df5f2a3a4065f021a63fc8fba37c01e6a8c52ccf08b748d39a301ed4bca6e288 --remote
Delete complete.
CMD npx wrangler r2 object delete myco-server-blobs/proj_1/83e70cf1ae8575acb5cb0f4aaa5f211953554dd48f6c0a4ece476e393cea2157 --remote
Delete complete.
CMD npx wrangler r2 object delete myco-server-blobs/proj_1/d03b559c85315013f5d53c4bacb9538819c8d1f3c00123cb554859cd3d90f3dc --remote
Delete complete.
CMD npx wrangler r2 object delete myco-server-blobs/proj_1/24ae3403cb00a1d2e546fba738a6fe2efba2632ec33fbc5bced2659fc9ebeb26 --remote
Delete complete.
verify (each should not exist):
proj_1/7dc52e7d421b3410eec3158d6d3a7d7750aa31a75abf64f5b2e740c17ca5aac1: does not exist
proj_1/df5f2a3a4065f021a63fc8fba37c01e6a8c52ccf08b748d39a301ed4bca6e288: does not exist
proj_1/83e70cf1ae8575acb5cb0f4aaa5f211953554dd48f6c0a4ece476e393cea2157: does not exist
proj_1/d03b559c85315013f5d53c4bacb9538819c8d1f3c00123cb554859cd3d90f3dc: does not exist
proj_1/24ae3403cb00a1d2e546fba738a6fe2efba2632ec33fbc5bced2659fc9ebeb26: does not exist
CMD npx wrangler delete --name myco-server-smoke7 --force
Successfully deleted myco-server-smoke7
CMD npx wrangler d1 delete myco-server-smoke7 -y
This action is irreversible and will permanently delete all data in the database.
Deleting...
Deleted 'myco-server-smoke7' successfully.
VERIFY npx wrangler d1 list | grep smoke7:
0
VERIFY npx wrangler deployments list --name myco-server-smoke7:
✘ [ERROR] A request to the Cloudflare API (/accounts/b134c2135129c4800082e677fbffb286/workers/scripts/myco-server-smoke7/deployments) failed.
  This Worker does not exist on your account. [code: 10007]
VERIFY curl health:
[404]
VERIFY real deployment untouched:
95f0d072-46f1-40c3-be51-f9714a502f37 myco-server
Created:     2026-08-17T14:11:05.254Z
Version(s):  (100%) c6bb7cf3-1fa6-411b-9c94-af13524bf90a
```

Local: the token dir `/private/tmp/claude-501/smoke7-tokens.RxRtUM` (mode 700, outside the repo) is deleted; the scratch copy used for M1–M4 (`scratchpad/wtree`, with its own `.wrangler/state`) is deleted; the tree's `.wrangler/state` was never used (mtime still Aug 17 22:13). `wrangler.smoke.toml` in the tree pre-existed this run (pointing at `myco-server-smoke5`, gitignored) — it was overwritten for the run and restored to its pre-run content afterwards, so the tree is exactly as found. The pre-existing D1 `myco-server-smoke5` (not this run's) was left alone.

## Last observed output — local (the applier)

```
M1 fresh: 0001 ✅ 0002 ✅, schema_meta.version = 2
M2 v1 + 'bad/id': CHECK constraint failed: ok = 1; version stays 1; d1_migrations keeps only 0001_v1.sql
M3 repaired: 0002 ✅, version 2, 2 triggers
M4 v1 + a session whose token has no machine_id: CHECK constraint failed: ok = 1; version stays 1;
   events has no producer_adapter column (the guard runs ahead of every ADD COLUMN)
M4 repaired: 0002 ✅; sessions = sess_ok/machine_1 (backfilled), sess_orphan/machine_recovered (repaired)
```
