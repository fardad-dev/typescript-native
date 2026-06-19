# src/frontend/ — parse + lower (stages 1 & 2)

[lower.ts](lower.ts) turns TypeScript source text into our internal IR
([../ir/nodes.ts](../ir/nodes.ts)).

- **Parse:** `ts.createSourceFile(...)` from the official `typescript` package gives a full
  AST (with parent links). We do **not** build a `ts.Program` or run the `TypeChecker` yet —
  that's a roadmap item.
- **Lower:** walk the AST and emit IR nodes.

## Entry point & shape

`lower(fileName, source): Module` splits top-level statements:
- `function` declarations → `lowerFunction` → `Module.functions`
- everything else → `lowerStatement` → `Module.main` (the body of `@main`)
- a top-level `return` is rejected (only valid inside a function).

## Internal helpers (one concern each)

- `lowerFunction(fn)` — name, typed params, return type (incl. `void`), body statements.
- `lowerStatement(node, out)` — `let`/`const`, `return`, `console.log(...)` (special-cased to a
  `log` stmt), and bare call expressions (`exprStmt`).
- `lowerVarDecl(decl)` — a single `let`/`const` binding; initializer is required.
- `lowerType(node)` — TS `TypeNode` → IR `Type` (keywords, `T[]`, `Array<T>`, object type literals).
- `lowerExpr(node)` — TS `Expression` → IR `Expr` (literals, identifiers, binary, array/object
  literals, indexing, member access, calls).
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
- **String values come pre-decoded:** use `node.text` for string/template literals (TS already
  resolved escapes); codegen re-encodes them as C++ string literals.
- **Fail loud:** any unsupported syntax throws `Error("Unsupported ... ")`. Keep messages
  specific — they surface to the user as `tsnc: <message>`.

## Adding syntax

New surface syntax usually means: a new branch here **plus** a matching IR node in
[../ir/nodes.ts](../ir/nodes.ts) and a `case` in [../codegen/emit.ts](../codegen/emit.ts).
