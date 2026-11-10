# Database kernel

Application SQL belongs in `packages/myco-server/src/db/`. Families define private,
module-level statements and expose their admitted domain operations. Those operations
retain Project/Deployment scope and capability authorization; the kernel does not
replace them. Existing callers migrate by family.

`db/index.ts` exports `read<Params, Row>`, `write<Params, Row = never>`,
`assertion<Params>`, `Bound`, `commit`, `readSet`, their definition/result types,
and the three limits (`MAX_BIND_SLOTS`, `MAX_SQL_BYTES`, `MAX_LIKE_BYTES`).

A definition has a unique `family.operation` name, SQL, and optional `like` slots.
SQL is either fixed text or a family-owned composition function returning SQL and
bindings from typed inputs. Composition runs at `bind`, captures the resulting values,
and applies the same arity, kind and portability checks as fixed text. The definition
and telemetry name stay fixed across all bindings; no definition or prepared-handle
cache grows with guard values. Its kind is explicit in its constructor and Bound. `bind` validates positional
arity and values (string, finite number, null, Uint8Array). Byte arrays are captured
by value. Numbered parameters use SQLite slot allocation: repeated `?1` needs one
binding, `?100` needs 100 bindings, and an anonymous `?` follows the highest slot.
Definitions admit at most 100 slots and 100,000 UTF-8 SQL bytes. These checks do not
promise full D1 SQL equivalence.

A family's LIKE definition names each pattern slot in `like`, using one-based
positions. Bind the **final escaped, wildcard-wrapped string**, for example the output
of `read/scope.ts`'s `containsPattern`. Binding refuses patterns beyond 50 UTF-8 bytes;
it never truncates a search. The existing scope helper itself is unchanged.

A Bound holds no store handle. `commit(db, ...bound)` prepares every value against
the supplied decorated store and calls its `batch` exactly once. It returns a tuple
of `{ results: Row[], meta }` in argument order, including assertion positions.
`readSet(db, ...reads)` uses that same path and returns a tuple of row arrays; writes
and assertions are excluded from its type and runtime contract. Both empty operations
return `[]` without preparing or calling the store.

Families define parameterized aborting assertions once and compose their Bound values
at the required position in the batch. A zero-row guarded UPDATE does not abort a
transaction. Companion writes requiring a condition must include an aborting assertion
in the same commit. Original storage errors and domain guard refusals propagate.
Prepared-statement identity and result slicing remain owned by the supplied decorators.

RETURNING writes specify their row type and return those rows. The native adapter
reports `meta.changes: 0` for every row-producing statement, including RETURNING;
non-row-producing writes report actual changes. The kernel preserves these metadata
semantics and never uses them to decide whether a conditional mutation succeeded.
An upsert's DO UPDATE changes count does not distinguish insertion from update.

## Telemetry

The single executor in `db/kernel/commit.ts` emits one `db_batch` event through the
existing `telemetry.ts` emitter after a successful batch. It lists each supplied
statement in order with only its fixed `statement` name and finite numeric, top-level
adapter `meta` fields. One line per batch keeps Workers Logs volume proportional to
round trips, not statements. Bindings, SQL, error text and nonnumeric metadata are excluded. Failed batches
emit no success events. Statements added internally by existing decorators are outside
this named-definition telemetry.

D1 batch results can supply `rows_read`, `rows_written`, `changes`, `duration` and other
numeric metadata. The native adapter currently supplies only `changes`; missing cost
fields are omitted, never manufactured as zero. Existing `PreparedStatement.first()`
and `.all()` return no metadata in the shared interface. The kernel uses batch results
for reads and adds no separate `.first()` execution path.

## Boundary gate

`tests/myco-server/db-layer.test.ts` uses an AST to count prepare calls, store batch/exec
calls, and SQL-producing string/template literals outside `db/`. Comments and RegExp
exec calls are excluded. Store aliases are recognized through their types. One temporary
`PENDING` set lists the files still allowed raw sites, and `PENDING_CHANGE_COUNTS` those
still reading `.meta.changes`. A file outside a set with any site fails, naming each site;
a listed file with none left fails until it is removed, so the sets only shrink. A listed
file can still gain sites, so SQL review remains necessary.

Named infrastructure exceptions cover native adapters, native startup/migration,
platform maintenance adapters, and the recovery Durable Object's separate coordination
SQL. Schema and migration emission remain owned by `db/`. There is no blanket platform
exclusion. The coordinator owns the sets; a slice only removes the files it migrates.
