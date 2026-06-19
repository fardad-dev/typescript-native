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
| Backend             | **Emit C++ source**, compile with **`clang++ -std=c++17 -O3`**      |
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

The suite (currently **52 cases**, all green) auto-discovers every `tests/cases/*.ts`,
compiles it to a real native binary, runs it, and diffs stdout against the matching
`.expected` file. **Every feature gets a `tests/cases/*.ts` + `.expected` pair**, ideally
written first (red), then implemented to green. See [tests/CLAUDE.md](tests/CLAUDE.md).

## Current language support

Implemented and tested end-to-end:

- **Types:** `number`, `boolean`, `string`, arrays (`T[]` / `Array<T>`), object literal types
  (`{ x: number; y: string }`). Aggregates **nest** — array elements and object fields may
  themselves be arrays/objects (`number[][]`, `{ pts: number[] }`, `{ x: number }[]`,
  `{ inner: { x: number } }`).
- **Values:** numeric/boolean/string literals, array literals `[...]`, object literals `{...}`.
- **Operators:** arithmetic `+ - * / %`, unary `-` / `+` (`-x`, `-5`), comparison
  `< <= > >= === !==` (numbers **and** strings — strings compare lexicographically), logical
  `&& || !`, string concatenation (`"a" + b`, numbers coerce), array indexing `a[i]`, member
  access `obj.field`, array `.length`.
- **Strings:** literals, concatenation, lexicographic comparison, `s.length`, character access
  `s[i]` (→ a one-char string), and methods `substring` / `slice` / `indexOf` / `charAt` /
  `charCodeAt` / `toUpperCase` / `toLowerCase` / `split` (`s.split(sep[, limit])` → `string[]`;
  string separators only — regex is out of subset) (JS `String.prototype` semantics, ASCII).
- **`console.log(x)`** for numbers/booleans and strings.
- **Variables:** `let` / `const` (initializer required); a type annotation is optional — without
  one the type is **inferred from the initializer**. `var` is **not supported** (errors). Assignment
  `x = e`, `a[i] = e`, `obj.f = e`, compound `+= -= *= /= %=`, and `i++` / `i--`.
- **Arrays:** literals (incl. empty `[]` with an annotation), `xs.push(v)`, and `xs.join(sep?)`
  → `string` (separator defaults to `","`; `string[]` and `number[]`).
- **Control flow:** `if` / `else`, `while`, `for (init; cond; update)`.
- **Functions:** top-level, typed params + return type, `return`, calls, `void`; recursion works.
  Params and returns may be **arrays and objects**, not just scalars — aggregate params pass by
  `const&` (read-only in the callee), aggregate returns by value (RVO/move).

### Representation / behavior notes (read these — they bite)

tsn types map onto C++ types (see [src/codegen/CLAUDE.md](src/codegen/CLAUDE.md)):

| tsn type | C++ type           | notes                                                       |
| -------- | ------------------ | ----------------------------------------------------------- |
| number   | `double` or `long long` | IEEE f64 by default; **integer-valued numbers use a 64-bit int rep** (see below). Printed JS-style |
| boolean  | `bool`             | `std::cout` prints `1` / `0`                                |
| string   | `tsn_str`          | ref-counted immutable string; copy = pointer + refcount bump (no char copy); methods → `tsn_*` helpers |
| `T[]`    | `std::vector<T>`   | heap-backed; `.length` → `.size()`; `.push()` → `push_back` |
| `{ ... }`| generated `struct` | one struct per distinct field shape                         |

- **`number` is f64, but integer-valued numbers use a 64-bit integer representation.** A
  pre-pass ([src/codegen/repr.ts](src/codegen/repr.ts)) infers, per variable / parameter / return,
  whether every value reaching it is provably integer-valued; if so it's emitted as `long long`
  (`i64`) instead of `double` (`f64`). This gives integer arithmetic, `%`, and comparisons the
  CPU's integer units — **~1.8× on integer-heavy loops** (a prime sieve; and tsnc now *beats* V8
  by ~2× in its own JIT-warm regime, where it used to reach parity). Soundness: a slot is `i64`
  only when no fractional value can flow in; `/` is **always** float division (`5 / 2 === 2.5`,
  and two integer vars no longer do C++ integer division), and `%` returns f64 so `x % 0 === NaN`
  stays representable (fast `tsn_imod` for integer operands, `tsn_mod`/`fmod` otherwise). Object
  fields and array elements always use the f64 rep. The one accepted imprecision — shared with all
  native-int compilation — is wraparound past 2^63.
- **Inference picks the concrete C++ type.** An unannotated declaration takes its type from the
  initializer (`const s = "hi"` → string, `const a = 12` → `number`); whether a `number` lands on
  `long long` or `double` is the rep decision above (`const a = 12` → `long long a = 12LL`). `var`
  is rejected during lowering.
- **`string` is ref-counted (`tsn_str`), not `std::string`.** TypeScript strings are immutable,
  so a value is shared, not duplicated: copying one bumps a counter and aliases the same heap
  buffer. This makes the hot operation in element-shuffling code (e.g. a sort's `a[j+1]=a[j]`) a
  pointer copy + counter bump instead of a character copy — matching V8's pointer moves. The
  tradeoff: every string is a heap allocation (no `std::string` small-string optimization), so
  string-creation-heavy code pays an alloc per value. The refcount is a plain (non-atomic) `long`
  — generated programs are single-threaded.
- **Aggregate function boundaries:** function params and returns may be arrays/objects (not just
  scalars). Aggregate **params pass by `const&`** — no per-call copy, and read-only inside the
  callee: mutating one (`xs.push(v)`, `xs[i] = v`, `xs = …`) is a clean `tsnc:` error, not a silent
  divergence from JS's shared-reference semantics (copy into a local first to mutate). Aggregate
  **returns pass by value**, leaning on C++ RVO/move so the cost lands only where the result is
  bound or used.
- **Aggregates nest:** object fields and array elements may themselves be aggregates —
  `{ pts: number[] }`, `{ inner: { x: number } }`, `number[][]`, `{ x: number }[]`. These map
  directly to C++ (`std::vector<std::vector<double>>`, a struct with `vector`/struct members), and
  `lowerType` / struct generation recurse through the shape. Nested *number* fields and elements
  always use the f64 rep (`double`). Reading, mutating (`box.inner.x = 9`, `poly.pts[0] = 9`), and
  pushing onto a nested array (`poly.pts.push(v)`) all work; an empty array as a field
  (`{ pts: [] }`) still errors (no annotation to infer the element type from).

The compiler **errors cleanly** (a `tsnc:` message) on unsupported constructs rather than
miscompiling — e.g. `console.log` of an aggregate, void-as-value, type mismatches.

### Unsupported types (rejected at lowering)

Every type annotation must lower to one of the supported types above; anything else throws
`tsnc: Unsupported type annotation: <SyntaxKind>` from `lowerType` ([src/frontend/lower.ts](src/frontend/lower.ts)).
Not yet supported:

| Type                    | Example                       | Notes                                                       |
| ----------------------- | ----------------------------- | ----------------------------------------------------------- |
| Union                   | `number \| string`            | No tagged-union representation yet.                         |
| `any`                   | `let x: any`                  | Would erase the static type codegen relies on.              |
| `unknown` / `never`     | `let x: unknown`              | Same reason as `any`.                                       |
| Tuple                   | `[number, string]`            | Only homogeneous `T[]` arrays are supported.                |
| Literal / enum          | `"a" \| "b"`, `enum E {}`     | No literal types or enums.                                  |
| Intersection            | `A & B`                       | No type composition.                                        |
| Function type           | `(x: number) => number`       | No first-class function values / closures.                  |
| Generic / type param    | `Map<K, V>`, `<T>(x: T) => T` | Only the built-in `Array<T>` is special-cased.              |
| `null` / `undefined`    | `string \| null`             | No nullable types; no optional (`x?:`) fields/params.       |

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

## Roadmap

Ordering principle: correctness of core types → completeness of what already exists → new
capabilities → robustness tooling. **Every item ships with a `tests/cases/*.ts` + `.expected`
pair** (red → green).

### Done

- [x] **`if` / `while` / `for`** — control flow (+ comparison/logical operators, recursion).
- [x] **Assignment** — `x = e`, `a[i] = e`, `obj.f = e`, compound `+= …`, `i++` / `i--`.
- [x] **`f64` numbers** — `number` is IEEE double (`5 / 2 === 2.5`); `%` via `std::fmod`, with
      an integer-remainder fast path for integer-valued operands (`tsn_mod`).
- [x] **Strings & arrays (basics)** — concatenation `"a" + b` (numbers coerce); `string[]`;
      array literals incl. empty `[]`; indexing `a[i]`; array `.length`; `xs.push(v)`.
- [x] **Strings (full scalar surface)** — unary `-`/`+`; lexicographic comparison
      `< <= > >= === !==`; `s.length`; character access `s[i]`; methods `substring` / `slice` /
      `indexOf` / `charAt` / `charCodeAt` / `toUpperCase` / `toLowerCase` (JS semantics, via
      `tsn_*` runtime helpers).
- [x] **Native-speed backend** — `clang++ -O3`; ~10–17× faster than `node app.ts` for normal
      program sizes (Node's startup/JIT-warmup tax dominates). On sustained hot loops it now
      *beats* a JIT-warm V8 on integer work (~2× on the prime sieve; see the integer fast path
      below) and stays ~parity on string-comparison-bound work.
- [x] **Ref-counted immutable strings (`tsn_str`)** — strings are shared, not copied, so
      element-shuffling code (sorts) moves a pointer + bumps a counter instead of copying chars
      (matching V8). On the `benchmark/sort-words.mjs` word-sort this cut tsnc's sustained-compute
      gap to V8 from ~15% behind to ~parity (a same-source A/B shows ~12% over by-value strings).
- [x] **Integer fast path for `number`** — a representation pass ([src/codegen/repr.ts](src/codegen/repr.ts))
      emits `long long` for provably integer-valued numbers (variables, parameters, returns) and
      `double` for the rest, via a sound monotone fixpoint. **~1.8× on integer-heavy loops**; in
      V8's own JIT-warm regime the prime sieve goes from ~parity to ~2× ahead. As a bonus it fixed
      a latent `int/int` truncation bug (`/` is now always float division) and made `NaN`/`Infinity`
      print JS-style.
- [x] **`split` / `join`** — `paragraph.split(" ")` → `string[]` (string separators + optional
      `limit`, full JS edge-case semantics), `words.join(sep?)` → `string` (`string[]` / `number[]`,
      separator defaults to `","`), so a paragraph can be tokenized and reassembled in-language.
      Turned out *not* to need the scalar-only boundary lifted: a `methodCall` result already flows
      through `RetType`, and arrays are first-class in `let` / indexing / `.length`, so a method
      returning `string[]` just works. Runtime helpers `tsn_split` / `tsn_join`.
- [x] **Lift scalar-only boundaries** — function params and returns may be arrays/objects now
      (front-end checks dropped). Aggregate params pass by `const&` (read-only — mutating one is a
      clean `tsnc:` error rather than a silent JS-semantics divergence); aggregate returns pass by
      value via RVO/move, so a copy lands only where the result is bound or used. Exposed and fixed
      a latent aggregate-literal bug: building a `vector`/`struct` from a *non-constant* integer
      number now casts `long long`→`double` (a brace-init narrowing clang rejected; literal
      constants like `3LL` had slipped through). Object *fields* stay scalar-only.
- [x] **Nested objects and arrays** — aggregates nest: object fields that are arrays or objects
      (`{ pts: number[] }`, `{ inner: { x: number } }`) and arrays of aggregates (`number[][]`,
      `{ x: number }[]`). Turned out to be mostly *removing* code: arrays of aggregates and
      `number[][]` already worked (`lowerType` recurses through array element types, and
      `f64SlotCode`/struct generation handle aggregate values), so the only blocks were two
      scalar-field guards — one in `lowerType`, one in the object-literal emitter. Dropping both
      lit up the whole surface: construction, indexing, field access, mutation (`box.inner.x = 9`,
      `poly.pts[0] = 9`), `push` onto a nested array, and crossing function boundaries
      (`{x;y}[]` param by `const&`, `number[][]` return by value). Nested structs generate inner
      before outer (correct C++ order); nested numbers stay f64. `console.log` of an aggregate is
      still a clean error (JS-style printing is the separate *Richer `console.log`* item); an empty
      array field (`{ pts: [] }`) still errors (no element type to infer).

### Will support — core completeness

- [ ] **More array methods** — `pop`, `indexOf`, `slice`; `push` as a value (returns length).
- [ ] **Richer `console.log`** — booleans as `true`/`false`; arrays/objects printed JS-style.

### Will support — correctness & performance

- [ ] **Full `ts.Program` + TypeChecker** — real semantic diagnostics; abort before codegen on
      type errors instead of reading AST annotations.

### Later

- [ ] **Classes** — `class C { f: T; constructor(...) {…}; method(...): R {…} }`, `new C(...)`,
      `this`, field access and method calls. Fields reuse the struct generation that object
      literals already have, and methods lower to member functions (or free functions taking the
      receiver). The real design decision is **identity**: JS objects are *reference* types
      (`new C()` is shared, two variables can alias and see each other's mutations), which clashes
      with the value semantics used for object literals today — so class instances likely need a
      reference representation (heap-allocated + ref-counted, like `tsn_str`) rather than by-value
      structs. `extends` / inheritance, `private`/`public`, and `static` members come after the
      basic shape works.
- [ ] **Closures, modules, generics** — first-class function values, `import`/`export`, and
      type parameters.
