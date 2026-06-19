# src/ — compiler internals

The compiler is a straight pipeline. Data flows one direction; each stage has one file.

```
index.ts      CLI (commander): parse args -> Options -> compile()
   ▼
driver.ts     compile(): read source -> typeCheck() -> lower() -> emit() -> buildExecutable()
   ▼
frontend/check.ts   (0) ts.Program + TypeChecker; abort on type errors
   ▼
frontend/lower.ts   (1) parse with `typescript`  (2) lower AST -> IR     ──┐ produces
   ▼                                                                       │
ir/nodes.ts         the typed IR — the contract between lower and emit  ◄──┘
   ▼
codegen/emit.ts     (3) IR -> C++ source text (the .cpp)                 ◄── consumes IR
   ▼
backend/clang.ts    (4) clang++ .cpp -> native executable
```

- [index.ts](index.ts) — entry; only CLI concerns. Defers all work to `driver.compile`.
- [driver.ts](driver.ts) — `compile(opts)` glues the stages (type-check → lower → emit → build);
  owns where the `.cpp` is written.
- [frontend/check.ts](frontend/check.ts) — (0) semantic type-check with `ts.Program` + `TypeChecker`;
  throws TypeScript diagnostics before lowering. See [frontend/CLAUDE.md](frontend/CLAUDE.md).
- [frontend/lower.ts](frontend/lower.ts) — TypeScript AST → our IR. See [frontend/CLAUDE.md](frontend/CLAUDE.md).
- [ir/nodes.ts](ir/nodes.ts) — IR node definitions. See [ir/CLAUDE.md](ir/CLAUDE.md).
- [codegen/emit.ts](codegen/emit.ts) — IR → C++ source. See [codegen/CLAUDE.md](codegen/CLAUDE.md).
- [codegen/repr.ts](codegen/repr.ts) — number-representation pass (`i64`/`f64`) the emitter runs
  first, so integer-valued numbers compile to `long long`. See [codegen/CLAUDE.md](codegen/CLAUDE.md).
- [backend/clang.ts](backend/clang.ts) — compile + link via clang++. See [backend/CLAUDE.md](backend/CLAUDE.md).

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
