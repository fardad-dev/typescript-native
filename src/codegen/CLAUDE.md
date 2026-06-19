# src/codegen/ — LLVM IR emission (stage 3)

[emit.ts](emit.ts) lowers the internal IR ([../ir/nodes.ts](../ir/nodes.ts)) to **textual
LLVM IR**. `emit(mod): string` returns the full `.ll`. **This is where LLVM-level correctness
lives** — pointer model, terminators, value representation.

## Representation model

| tsn type            | LLVM repr | notes                                                   |
| ------------------- | --------- | ------------------------------------------------------- |
| `number`, `boolean` | `i64`     | booleans are `0`/`1`                                    |
| `string`            | `ptr`     | to a private global NUL-terminated byte array           |
| `T[]`               | `ptr`     | to a stack buffer `alloca [N x repr(T)]`                |
| `{ ... }`           | `ptr`     | to a stack struct `alloca { repr(f0), repr(f1), ... }`  |

`reprOf(t)` collapses this to `"i64" | "ptr"`. Aggregates and strings are pointers, so they're
"passed around" as the pointer itself — referencing a variable that holds one needs **no load**.

Every emitted value is a `Value { v, type, length? }`: the LLVM operand text (`%t3`, a literal,
or a global symbol), its IR `Type`, and — for arrays — the compile-time element count.

## The `Emitter` class

- **Module-level (shared):** `globals` (string-literal constants), `sigs` (function signature
  table, collected in a first pass so calls can reference later/recursive functions).
- **Per-function scratch (reset by `resetForFunction`):** `body` (instruction lines), `temp`
  (SSA counter via `fresh()`), `vars` (name → stack slot + type + length), `curReturn`,
  `terminated` (set on `ret`; stops emitting after it — there's no control flow yet).
- Each `Func` → one `define`; top-level statements → `emitMain` → `define i32 @main()`.

## Conventions (match these)

- **Opaque pointers only** (`ptr`) — never `i8*`/typed pointers.
- Output starts with `target triple = "arm64-apple-macosx15.0.0"`.
- Fresh `%tN` per function; **variables and params both live in stack slots**
  (`alloca` + `store` on entry, `load` on use) — uniform and ready for future assignment.
- String literals are interned as `@.str.N` private globals via `encodeCString` (UTF-8, escapes
  non-printables/quote/backslash as `\XX`, appends `\00`).
- `console.log` → `printf` with `@.fmt.int` (`%d\n`) for `i64` or `@.fmt.str` (`%s\n`) for strings.
- Helpers: `reprOf`, `structType` (`{ i64, ptr }`), `sameType` (structural, order-independent for
  objects), `displayType` (for error messages), `isArray`/`isObject`/`isAggregate`.
- `emitCall(e, asStatement)` — a `void` call is valid only in statement position; using it as a
  value throws.

## Guard clauses

Unsupported constructs throw a clear `Error` (→ `tsnc: <message>`) instead of emitting bad IR:
string concatenation, arithmetic on aggregates, `console.log` of an array/object, indexing a
non-array, missing/duplicate fields, type-mismatched assignment, wrong arg count/type, missing
`return`, aggregate params. Keep this discipline when extending.
