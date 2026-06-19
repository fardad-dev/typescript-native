# src/frontend/ — type-check + parse + lower (stages 0, 1 & 2)

This folder owns the front of the pipeline: [check.ts](check.ts) type-checks (stage 0), then
[lower.ts](lower.ts) turns the source into our internal IR ([../ir/nodes.ts](../ir/nodes.ts)).

- **Type-check (stage 0):** [check.ts](check.ts)'s `typeCheck(fileName, source)` builds a real
  `ts.Program` + `TypeChecker` (over an in-memory copy of the source + an ambient `console`, ES2020
  lib only, `strict: true`) and **throws** formatted TypeScript diagnostics on any type error,
  before we lower or emit. This is a *gate*: it rejects type-erroneous programs but does not (yet)
  feed inferred types into lowering.
- **Parse:** `ts.createSourceFile(...)` from the official `typescript` package gives a full
  AST (with parent links) — a second, lightweight parse that lowering walks.
- **Lower:** walk the AST and emit IR nodes.

Subset-specific rejections (e.g. `var`, parameter properties) still happen during lowering, *after*
the type check — stage 0 only enforces TypeScript's own semantics, not our subset's restrictions.

## Entry point & shape

`lower(fileName, source): Module` splits top-level statements:
- `class` declarations → `lowerClass` → `Module.classes`
- `function` declarations → `lowerFunction` → `Module.functions`
- everything else → `lowerStatement` → `Module.main` (the body of `@main`)
- a top-level `return` is rejected (only valid inside a function).

## Internal helpers (one concern each)

- `lowerFunction(fn)` — name, typed params, return type (incl. `void`), body statements.
- `lowerClass(cls)` — fields (typed, no initializers), one constructor, methods. Rejects
  inheritance, `static`, accessors, parameter properties, field initializers, and a missing
  constructor; **ignores** access modifiers (public/private/…). Bodies lower via `lowerStatement`.
- `lowerParams(params)` — shared typed-parameter lowering (functions, methods, constructors);
  also rejects parameter-properties (`constructor(private x: ...)`).
- `lowerStatement(node, out)` — `let`/`const`, `return`, `console.log(...)` (special-cased to a
  `log` stmt), and bare call expressions (`exprStmt`).
- `lowerVarDecl(decl)` — a single `let`/`const` binding; initializer is required.
- `lowerType(node)` — TS `TypeNode` → IR `Type` (keywords, `T[]`, `Array<T>`, object type literals;
  a **bare identifier** that isn't a known primitive/`Array` → a `class` instance type).
- `lowerExpr(node)` — TS `Expression` → IR `Expr` (literals, identifiers, binary, array/object
  literals, indexing, member access, calls, `new C(...)`, `this`).
- `lowerBinaryOp(kind)` — operator token → `BinaryOp`.
- `isConsoleLog(expr)` — recognizes the `console.log` callee.

## Conventions / gotchas

- **Boxed wrappers are primitives here:** `Number`/`Boolean`/`String` annotations lower to
  `number`/`boolean`/`string`. (Strict TS would reject e.g. arithmetic on `Number`; our dialect
  has one of each.)
- **Aggregate function boundaries:** function params and returns may lower to **any** supported
  type — scalars, arrays, or objects (`lowerFunction` no longer rejects aggregates). How aggregates
  cross the boundary (const& params, by-value returns, the read-only-param rule) is a codegen
  concern — see [../codegen/CLAUDE.md](../codegen/CLAUDE.md).
- **Aggregates nest:** object fields and array element types may themselves be aggregates.
  `lowerType` recurses with no scalar-field check, so `{ pts: number[] }`, `{ inner: { x: number } }`,
  `number[][]`, and `{ x: number }[]` all lower to the right nested `Type`.
- **Class type-refs are open:** `lowerType` maps any bare identifier that isn't a known
  primitive/`Array` to `{ kind: "class", name }` *without* checking the class exists — the emitter
  validates that (and reports `Unknown class: X`). Generic refs (with type arguments) still fall
  through to the "Unsupported type annotation" throw, so e.g. `Map<K, V>` keeps its clear error.
- **String values come pre-decoded:** use `node.text` for string/template literals (TS already
  resolved escapes); codegen re-encodes them as C++ string literals.
- **Fail loud:** any unsupported syntax throws `Error("Unsupported ... ")`. Keep messages
  specific — they surface to the user as `tsnc: <message>`.

## Adding syntax

New surface syntax usually means: a new branch here **plus** a matching IR node in
[../ir/nodes.ts](../ir/nodes.ts) and a `case` in [../codegen/emit.ts](../codegen/emit.ts).
