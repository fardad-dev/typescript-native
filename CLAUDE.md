# typescript-native

An ahead-of-time (AOT) compiler that turns a subset of **TypeScript** into a native
**executable**, the way C++ or Rust do — TypeScript source → **LLVM IR** → machine code →
linked executable. No Node, no V8, no JIT at runtime: the output is a standalone binary.

This is a learning-oriented compiler. Favor clarity and a working end-to-end pipeline over
feature breadth or premature optimization.

## The pipeline

```
.ts source
   │  (1) parse + type-check
   ▼
TypeScript AST            ← official `typescript` package (ts.createProgram / TypeChecker)
   │  (2) lower to our own IR
   ▼
Internal IR (typed)       ← our small intermediate representation
   │  (3) codegen
   ▼
LLVM IR text (.ll)        ← we emit textual LLVM IR
   │  (4) assemble + link
   ▼
native executable         ← `clang program.ll -o program`
```

Step 4 uses `clang` as the assembler+linker — it compiles `.ll` directly, so **no separate
`llc`/`opt` is required**.

## Tech stack (decided)

| Concern             | Choice                                                              |
| ------------------- | ------------------------------------------------------------------- |
| Compiler language   | **TypeScript**, run on Node (v22)                                   |
| Front-end (parsing) | **Official `typescript` package** — reuse its lexer/parser/checker  |
| Backend             | **Emit LLVM IR text**, compile with **`clang`**                     |
| Target              | **arm64-apple-macosx** (Apple Silicon) — single target for now      |

### Verified environment (2026-06-19, this machine)

- Apple Silicon (`arm64`), macOS (Darwin 24.6).
- Apple clang **17.0.0**, target `arm64-apple-darwin24.6.0`. **Opaque pointers** are the
  default — use `ptr`, never `i8*`/typed pointers, in emitted IR.
- Emit `target triple = "arm64-apple-macosx15.0.0"` at the top of each `.ll` to avoid the
  `-Woverride-module` warning.
- `node` v22.22, `tsc`, `clang`, `as`, `ld` present. `llc` is **not** installed (not needed).

A known-good minimal IR (computes 20+22, prints 42) — the shape codegen should produce:

```llvm
target triple = "arm64-apple-macosx15.0.0"
@.fmt = private unnamed_addr constant [4 x i8] c"%d\0A\00"
declare i32 @printf(ptr, ...)
define i32 @main() {
entry:
  %sum = add i64 20, 22
  call i32 (ptr, ...) @printf(ptr @.fmt, i64 %sum)
  ret i32 0
}
```

## v1 language scope

Keep it small; get the whole pipeline working first, then grow.

**In scope for v1:**
- Types: `number`, `boolean`
- `console.log(x)` for numbers and booleans
- Arithmetic: `+ - * / %`
- Comparisons: `< <= > >= === !==`, boolean `&& || !`
- `let`/`const` variables, assignment
- `if`/`else`, `while`, `for`
- Functions (top-level, typed params + return), `return`

**Number representation (v1 decision needed early):** start by treating `number` as a 64-bit
integer (`i64`) to keep codegen simple, then move to IEEE `double` (`f64`) once the integer
path works end-to-end. JS `number` is really `f64`; this is a deliberate v1 simplification —
document it where it bites.

**Explicitly out of scope for v1** (revisit later, each needs a heap/runtime):
strings, arrays/objects, classes, closures, `null`/`undefined`, exceptions, async, modules,
generics, union/`any` types, garbage collection.

## Proposed source layout

> Repo is currently empty (just `.git`). This is the intended structure — create as we go.

```
src/
  index.ts          # CLI entry: tsnc <file.ts> -> ./file
  driver.ts         # orchestrates the 4 pipeline stages + invokes clang
  frontend/
    program.ts      # build ts.Program, run the type checker, collect diagnostics
    lower.ts        # TypeScript AST -> internal IR
  ir/
    nodes.ts        # internal IR node definitions (typed)
  codegen/
    emit.ts         # internal IR -> LLVM IR text
    builder.ts      # helpers: SSA temp names, basic blocks, string constants
  backend/
    clang.ts        # shell out to clang to assemble+link the .ll
tests/
  cases/            # *.ts inputs + *.expected stdout
  run.ts            # compile each case, run binary, diff stdout
```

## Commands

> These are the intended scripts — wire them up in `package.json` as the project is scaffolded.

```bash
# build the compiler
npm run build                 # tsc -> dist/

# compile a TS program to a native binary
node dist/index.js examples/add.ts -o add
./add

# keep emitted IR for inspection
node dist/index.js examples/add.ts --emit-llvm -o add   # also writes add.ll

# run the test suite (compile each case, run, diff stdout)
npm test
```

Manual pipeline check (sanity, no compiler needed): `clang file.ll -o file && ./file`.

## Conventions

- **Opaque pointers only** in emitted IR (`ptr`). Never emit `i8*` or other typed pointers.
- Each emitted `.ll` starts with the `target triple`.
- Generate fresh SSA temp names per function (e.g. `%t0`, `%t1`, …); LLVM SSA values are
  assigned once. Route mutable `let` variables through stack slots (`alloca` + `load`/`store`)
  rather than trying to keep them in SSA registers by hand.
- Surface TypeScript type-checker diagnostics to the user and **abort** before codegen if the
  program doesn't type-check — lean on the official checker, don't re-implement it.
- Prefer small, pure functions per IR node kind; one `emitX` per node.
- Add a `tests/cases/*.ts` + `.expected` pair for every feature before/with implementing it.

## Roadmap

1. **Scaffold** — `package.json`, `tsconfig.json`, CLI that reads a file and shells to clang.
2. **Hello number** — hardcode the 20+22 IR above through the driver; prove the binary runs.
3. **Front-end** — `ts.Program` + checker; walk the AST for a single `console.log(<int literal>)`.
4. **Expressions** — integer arithmetic + comparisons → IR → LLVM (SSA temps).
5. **Variables & control flow** — `let`/`const`, `if`/`while`/`for` (basic blocks + branches).
6. **Functions** — params, returns, calls.
7. **Booleans + `console.log` for bool**, then **switch `number` to `f64`**.
8. **Test harness** green across all cases.

Later (post-v1): strings + a minimal runtime, arrays/objects, a memory model, then classes.
