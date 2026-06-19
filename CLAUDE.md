# typescript-native (`tsnc`)

An ahead-of-time (AOT) compiler that turns a subset of **TypeScript** into a native
**executable**, the way C++ or Rust do — TypeScript source → **LLVM IR** → machine code →
linked executable. No Node, no V8, no JIT at runtime: the output is a standalone binary.

This is a learning-oriented compiler. Favor clarity and a working end-to-end pipeline over
feature breadth or premature optimization.

## The pipeline

```
.ts source
   │  (1) parse                     src/frontend/lower.ts  (ts.createSourceFile)
   ▼
TypeScript AST
   │  (2) lower to our own IR       src/frontend/lower.ts -> src/ir/nodes.ts
   ▼
Internal IR (typed)
   │  (3) codegen                   src/codegen/emit.ts
   ▼
LLVM IR text (.ll)
   │  (4) assemble + link           src/backend/clang.ts  (clang program.ll -o program)
   ▼
native executable
```

Step 4 uses `clang` as the assembler+linker — it compiles `.ll` directly, so **no separate
`llc`/`opt` is required**.

## Tech stack (decided)

| Concern             | Choice                                                              |
| ------------------- | ------------------------------------------------------------------- |
| Compiler language   | **TypeScript**, run on Node (>= 22)                                 |
| Front-end (parsing) | **Official `typescript` package** — reuse its lexer/parser          |
| Backend             | **Emit LLVM IR text**, compile with **`clang`**                     |
| Target              | **arm64-apple-macosx** (Apple Silicon) — single target for now      |
| CLI                 | **commander**                                                       |
| Tests               | **vitest** (end-to-end: compile → run → diff stdout)                |

## Project structure

```
src/
  index.ts          # CLI entry (tsnc): parse args via commander, call compile()
  driver.ts         # orchestrates the 4 pipeline stages
  frontend/
    lower.ts        # (1)(2) parse with `typescript`, lower AST -> internal IR
  ir/
    nodes.ts        # internal IR node definitions (typed)
  codegen/
    emit.ts         # (3) internal IR -> LLVM IR text
  backend/
    clang.ts        # (4) shell out to clang to assemble + link the .ll
tests/
  e2e.test.ts       # harness: compile each case, run binary, diff stdout
  cases/            # *.ts inputs + *.expected stdout (one pair per feature)
```

Each folder has its own `CLAUDE.md` with module-specific detail.

## How to run

```bash
npm run build                                       # tsc -> dist/

node dist/index.js examples/test1.ts -o test1       # compile a .ts program to a binary
./test1                                             # run it

node dist/index.js examples/test1.ts -o test1 --emit-llvm   # also writes test1.ll
```

Manual pipeline sanity check (no compiler needed): `clang file.ll -o file && ./file`.

## How to test

```bash
npm test            # run the e2e suite once (vitest run)
npm run test:watch  # re-run on change — the TDD red->green loop
```

The suite (currently **12 cases**, all green) auto-discovers every `tests/cases/*.ts`,
compiles it to a real native binary, runs it, and diffs stdout against the matching
`.expected` file. **Every feature gets a `tests/cases/*.ts` + `.expected` pair**, ideally
written first (red), then implemented to green. See [tests/CLAUDE.md](tests/CLAUDE.md).

## Current language support

Implemented and tested end-to-end:

- **Types:** `number`, `boolean`, `string`, arrays (`T[]` / `Array<T>`), object literal types
  (`{ x: number; y: string }`).
- **Values:** numeric/boolean/string literals, array literals `[...]`, object literals `{...}`.
- **Operators:** arithmetic `+ - * / %` (integer), array indexing `a[i]`, member access
  `obj.field`, array `.length`.
- **`console.log(x)`** for numbers/booleans (`%d`) and strings (`%s`).
- **Variables:** `let`/`const` with annotations (initializer required).
- **Functions:** top-level, typed params + return type, `return`, calls, `void`.

### Representation notes (read these — they bite)

- **`number` is a 64-bit integer (`i64`)**, not IEEE `f64`. `console.log(5 / 2)` prints `2`.
  Moving to `f64` is a planned step; document where the integer model leaks.
- Booleans are `i64` `0`/`1` and print as `0`/`1` (not `true`/`false`).
- **Strings, arrays, and objects are pointers.** Strings → a private global byte array;
  arrays → a stack buffer `[N x T]`; objects → a stack struct `{ ... }`. Array length is a
  **compile-time constant** (tracked in the compiler, not stored in memory).
- **Scalar-only boundaries (v1):** object fields and function params/returns must be
  `number`/`boolean`/`string`. Aggregates aren't passed/returned yet — a pointer into a
  callee frame would dangle, and array `.length` can't be a compile-time constant across callers.

The compiler **errors cleanly** (a `tsnc:` message) on unsupported constructs rather than
miscompiling — e.g. string concatenation, `console.log` of an aggregate, void-as-value.

## Conventions

- **Opaque pointers only** in emitted IR (`ptr`). Never emit `i8*` or other typed pointers.
- Each emitted `.ll` starts with `target triple = "arm64-apple-macosx15.0.0"`.
- Generate fresh SSA temp names per function (`%t0`, `%t1`, …). Route variables **and params**
  through stack slots (`alloca` + `load`/`store`) rather than hand-managing SSA.
- Prefer small, pure helpers; one `emitX` / `lowerX` per node kind.
- Lean on clear error messages for anything out of scope — don't silently miscompile.

### Verified environment (2026-06-19, this machine)

- Apple Silicon (`arm64`), macOS (Darwin 24.6).
- Apple clang **17.0.0**, target `arm64-apple-darwin24.6.0`. **Opaque pointers** are the
  default — use `ptr`.
- `node` v22, `tsc`, `clang`, `as`, `ld` present. `llc` is **not** installed (not needed).

A known-good minimal IR (computes 20+22, prints 42) — the shape codegen produces:

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

## Roadmap / known limits

Roughly in dependency order:

1. **`if` / `while` / `for`** — control flow (basic blocks + branches). Unblocks loops and
   terminating recursion.
2. **Assignment statements** — `x = e`, `a[i] = e`, `obj.f = e` (mutation).
3. **`f64` numbers** — make `number` behave like JS (so `5 / 2 === 2.5`).
4. **A heap (`malloc`) + minimal runtime** — unlocks string concatenation, array `push`/resize,
   returning/passing aggregates, and a length-carrying array representation.
5. **Bounds-checked indexing** — trap on out-of-range `a[i]`.
6. **Full `ts.Program` + TypeChecker** — replace the AST-annotation reading with real semantic
   diagnostics, abort before codegen on type errors.

Later: classes, closures, modules, generics, GC.
