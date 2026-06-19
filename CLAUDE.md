# typescript-native (`tsnc`)

An ahead-of-time (AOT) compiler that turns a subset of **TypeScript** into a native
**executable**, the way C++ or Rust do — TypeScript source → **C++** → machine code →
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
C++ source (.cpp)
   │  (4) compile + link            src/backend/clang.ts  (clang++ program.cpp -o program)
   ▼
native executable
```

C++ is our intermediate language: codegen emits readable C++, and `clang++` does the real
lowering to machine code. (The compiler used to emit LLVM IR directly; it now targets C++,
which makes heap-backed values like strings and arrays straightforward.)

## Tech stack (decided)

| Concern             | Choice                                                              |
| ------------------- | ------------------------------------------------------------------- |
| Compiler language   | **TypeScript**, run on Node (>= 22)                                 |
| Front-end (parsing) | **Official `typescript` package** — reuse its lexer/parser          |
| Backend             | **Emit C++ source**, compile with **`clang++ -std=c++17`**          |
| Target              | native binary for this host (Apple Silicon / arm64 macOS)           |
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
    emit.ts         # (3) internal IR -> C++ source text
  backend/
    clang.ts        # (4) shell out to clang++ to compile + link the .cpp
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

node dist/index.js examples/test1.ts -o test1 --emit-cpp   # also writes test1.cpp
```

Manual pipeline sanity check (no compiler needed): `clang++ -std=c++17 file.cpp -o file && ./file`.

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
- **`console.log(x)`** for numbers/booleans and strings.
- **Variables:** `let`/`const` with annotations (initializer required).
- **Functions:** top-level, typed params + return type, `return`, calls, `void`.

### Representation / behavior notes (read these — they bite)

tsn types map onto C++ types (see [src/codegen/CLAUDE.md](src/codegen/CLAUDE.md)):

| tsn type | C++ type           | notes                                              |
| -------- | ------------------ | -------------------------------------------------- |
| number   | `long long`        | **64-bit integer** — `console.log(5 / 2)` prints `2` |
| boolean  | `bool`             | `std::cout` prints `1` / `0`                       |
| string   | `std::string`      | literals are `const char*`, convert implicitly     |
| `T[]`    | `std::vector<T>`   | heap-backed; `.length` → `.size()`                 |
| `{ ... }`| generated `struct` | one struct per distinct field shape                |

- **`number` is an integer, not IEEE `f64`.** Moving to `f64` is now a one-type change
  (`long long` → `double`) — deferred to keep current test behavior.
- **Scalar-only boundaries (v1):** object fields and function params/returns must be
  `number`/`boolean`/`string`. (C++ value semantics would now make aggregate params/returns
  safe — this restriction is enforced in the front-end and can be lifted next.)

The compiler **errors cleanly** (a `tsnc:` message) on unsupported constructs rather than
miscompiling — e.g. string concatenation, `console.log` of an aggregate, void-as-value.

## Conventions

- **Codegen is expression-based:** `emitExpr` returns a C++ expression string; we lean on
  the C++ compiler instead of hand-managing temporaries.
- Binary expressions are fully parenthesized to preserve precedence.
- `console.log` → `std::cout << expr << "\n"`.
- Out-of-scope constructs throw a clear `Error` (surfaced as `tsnc: <message>`) — never a
  silent miscompile.
- Prefer small, pure helpers; one `emitX` / `lowerX` per node kind.

### Verified environment (2026-06-19, this machine)

- Apple Silicon (`arm64`), macOS (Darwin 24.6).
- Apple **clang++ 17.0.0** at `/usr/bin/clang++`; we compile with `-std=c++17`.
- `node` v22, `tsc` present.

A minimal generated program (the shape codegen produces) — computes 20+22, prints 42:

```cpp
#include <cstdint>
#include <iostream>
#include <string>
#include <vector>

int main() {
  std::cout << (20LL + 22LL) << "\n";
  return 0;
}
```

## Roadmap / known limits

Roughly in dependency order:

1. **`if` / `while` / `for`** — control flow. Maps directly to C++ `if`/`while`/`for`; unblocks
   loops and terminating recursion.
2. **Assignment statements** — `x = e`, `a[i] = e`, `obj.f = e` (mutation). C++ makes these direct.
3. **Lift scalar-only boundaries** — pass/return arrays and objects (C++ `std::vector`/`struct`
   value semantics make this safe now).
4. **String concatenation / array `push`** — now trivial via `std::string` / `std::vector`;
   currently still guarded off.
5. **`f64` numbers** — change the `number` mapping from `long long` to `double`.
6. **Full `ts.Program` + TypeChecker** — replace AST-annotation reading with real semantic
   diagnostics, abort before codegen on type errors.

Later: classes, closures, modules, generics.
