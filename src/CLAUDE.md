# src/ — compiler internals

The compiler is a straight pipeline. Data flows one direction; each stage has one file.

```
index.ts      CLI (commander): parse args -> Options -> compile()
   ▼
driver.ts     compile(): read source -> typeCheck() -> loadProgram() -> emit() -> buildExecutable()
   ▼
frontend/check.ts   (0) ts.Program + TypeChecker; abort on type errors (whole import graph)
   ▼
frontend/modules.ts (1) resolve the import graph, lower each file, merge -> one Module  ──┐
   ▲   uses lower() per file                                                              │ produces
frontend/lower.ts   (1) parse with `typescript`  (2) lower one file's AST -> IR           │
   ▼                                                                                      │
ir/nodes.ts         the typed IR — the contract between lower and emit  ◄─────────────────┘
   ▼
codegen/emit.ts     (3) IR -> C++ source text (the .cpp)                 ◄── consumes IR
   ▼
backend/clang.ts    (4) clang++ .cpp -> native executable
```

Each folder below has its own `CLAUDE.md` with detail.

- [index.ts](index.ts) — CLI entry; defers all work to `driver.compile`.
- [driver.ts](driver.ts) — `compile(opts)` glues the stages and owns where the `.cpp` is written.
- [frontend/check.ts](frontend/check.ts) — (0) type-check with `ts.Program` + `TypeChecker` over the
  whole import graph; throws TS diagnostics before lowering.
- [frontend/modules.ts](frontend/modules.ts) — (1) resolve the `import` graph, lower every reachable
  file, merge into one IR `Module`.
- [frontend/lower.ts](frontend/lower.ts) — one file's TypeScript AST → our IR.
- [ir/nodes.ts](ir/nodes.ts) — IR node definitions.
- [codegen/emit.ts](codegen/emit.ts) — IR → C++ source.
- [codegen/repr.ts](codegen/repr.ts) — number-representation pass (`i64`/`f64`), run before emit.
- [codegen/closures.ts](codegen/closures.ts) — closure-capture pass, run before emit.
- [codegen/cpp/tsn_runtime.h](codegen/cpp/tsn_runtime.h) — the fixed C++ runtime; every emitted `.cpp`
  `#include`s it.
- [backend/clang.ts](backend/clang.ts) — compile + link via clang++.

## Adding a language feature (the repeated 3-touch pattern)

Almost every feature so far (strings, arrays, objects, functions) followed the same flow:

1. **Test first** — add `tests/cases/<feature>.ts` + `.expected`. Run `npm run test:watch`
   to see it fail (red).
2. **IR** — add/extend a node in [ir/nodes.ts](ir/nodes.ts) (a new `Expr`/`Stmt`/`Type` variant).
3. **Front-end** — produce that node in [frontend/lower.ts](frontend/lower.ts) (a new AST branch).
4. **Codegen** — consume it in [codegen/emit.ts](codegen/emit.ts) (a new `case` in `emitExpr`/`emitStmt`).
5. Run to green; the existing cases guard against regressions.

`lower.ts` and `emit.ts` both `switch` on the IR node's `kind`, so the TypeScript compiler
points you at every site that must handle a newly added node.

## Cross-cutting conventions

- Reading type info: a real `ts.Program` + `TypeChecker` runs first ([frontend/check.ts](frontend/check.ts))
  and rejects type-erroneous programs up front; lowering then still reads annotations straight off
  the AST (it doesn't yet thread the checker's inferred types through — the checker is a gate, not
  yet the type source).
- Codegen is **expression-based**: it emits readable C++ and lets `clang++` do the real
  lowering (no SSA/pointer bookkeeping in our emitter).
- Out-of-scope constructs throw a clear `Error` (surfaced as `tsnc: <message>`) — never a
  silent miscompile.
