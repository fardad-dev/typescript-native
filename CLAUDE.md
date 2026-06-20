# typescript-native (`tsnc`)

An ahead-of-time (AOT) compiler that turns a subset of **TypeScript** into a native
**executable**, the way C++ or Rust do — TypeScript source → **C++** → machine code →
linked executable. No Node, no V8, no JIT at runtime: the output is a standalone binary.

This is a learning-oriented compiler. Favor clarity and a working end-to-end pipeline over
feature breadth or premature optimization.

## The pipeline

```
.ts source (entry)
   │  (0) type-check                src/frontend/check.ts  (ts.Program + TypeChecker)
   ▼  (abort on type errors)
.ts source (entry)
   │  (1) resolve + parse           src/frontend/modules.ts -> src/frontend/lower.ts
   ▼     follow imports, then ts.createSourceFile per file
TypeScript AST (per module)
   │  (2) lower + merge to our IR   src/frontend/lower.ts -> src/ir/nodes.ts
   ▼     bundle the module graph into ONE Module
Internal IR (typed)
   │  (3) codegen                   src/codegen/emit.ts
   ▼
C++ source (.cpp)
   │  (4) compile + link            src/backend/clang.ts  (clang++ program.cpp -o program)
   ▼
native executable
```

Stage 0 runs a real `ts.Program` + `TypeChecker` over the source and aborts with
TypeScript-quality diagnostics on any type error, before we lower or emit — so wrong
assignment types, undeclared names, bad argument counts/types, and bad property access are
caught up front rather than miscompiled (see [src/frontend/check.ts](src/frontend/check.ts)).
Because the checker resolves the whole import graph from disk, cross-module mistakes (importing
a non-existent or non-exported member, wrong argument types across files) are caught here too.

Stage 1 starts at the entry file and follows `import`s to build the module graph, then lowers
every reachable file and **bundles** them into one IR `Module` (the backend produces one
translation unit / one binary). A single-file program is just a one-node graph. See
[src/frontend/modules.ts](src/frontend/modules.ts) and _Modules_ under Current language support.

C++ is our intermediate language: codegen emits readable C++, and `clang++` does the real
lowering to machine code. (The compiler used to emit LLVM IR directly; it now targets C++,
which makes heap-backed values like strings and arrays straightforward.)

## Tech stack (decided)

| Concern             | Choice                                                         |
| ------------------- | -------------------------------------------------------------- |
| Compiler language   | **TypeScript**, run on Node (>= 22)                            |
| Front-end (parsing) | **Official `typescript` package** — reuse its lexer/parser     |
| Backend             | **Emit C++ source**, compile with **`clang++ -std=c++17 -O3`** |
| Target              | native binary for this host (Apple Silicon / arm64 macOS)      |
| CLI                 | **commander**                                                  |
| Tests               | **vitest** (end-to-end: compile → run → diff stdout)           |

## Project structure

```
src/
  index.ts          # CLI entry (tsnc): parse args via commander, call compile()
  driver.ts         # orchestrates the pipeline stages (0 -> 4)
  frontend/
    check.ts        # (0) type-check with ts.Program + TypeChecker; abort on errors
    modules.ts      # (1) resolve the import graph, lower each file, merge -> one Module
    lower.ts        # (1)(2) parse with `typescript`, lower one file's AST -> internal IR
  ir/
    nodes.ts        # internal IR node definitions (typed)
  codegen/
    emit.ts         # (3) internal IR -> C++ source text
  backend/
    clang.ts        # (4) shell out to clang++ to compile + link the .cpp
tests/
  e2e.test.ts       # harness: compile each case, run binary, diff stdout
  typecheck.test.ts # stage-0 checker: asserts bad programs are rejected
  modules.test.ts   # module loader: asserts graph rejections (cycles, collisions, …)
  cases/            # *.ts inputs + *.expected stdout (one pair per feature)
    modlib/         # helper modules imported by cases/ (not discovered as cases)
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

The suite (currently **78 e2e cases** + a stage-0 type-checker test file + a module-loader test
file, all green) auto-discovers every `tests/cases/*.ts`, compiles it to a real native binary,
runs it, and diffs stdout against the matching `.expected` file. **Every feature gets a
`tests/cases/*.ts` + `.expected` pair**, ideally written first (red), then implemented to green.
Programs that must be *rejected* (type errors) can't be expressed as a case pair, so they live in
[tests/typecheck.test.ts](tests/typecheck.test.ts); structural module-graph rejections (cycles,
name collisions, unsupported import forms) live in [tests/modules.test.ts](tests/modules.test.ts).
See [tests/CLAUDE.md](tests/CLAUDE.md).

## Current language support

Implemented and tested end-to-end:

- **Types:** `number`, `boolean`, `string`, arrays (`T[]` / `Array<T>`), object literal types
  (`{ x: number; y: string }`). Aggregates **nest** — array elements and object fields may
  themselves be arrays/objects (`number[][]`, `{ pts: number[] }`, `{ x: number }[]`,
  `{ inner: { x: number } }`).
- **Values:** numeric/boolean/string literals, array literals `[...]`, object literals `{...}`.
- **Type checking:** a real `ts.Program` + `TypeChecker` runs **before** lowering and aborts on
  any TypeScript type error with full diagnostics (wrong assignment types, undeclared names, bad
  argument counts/types, bad property access). See [src/frontend/check.ts](src/frontend/check.ts).
- **Operators:** arithmetic `+ - * / %`, unary `-` / `+` (`-x`, `-5`), comparison
  `< <= > >= === !==` (numbers **and** strings — strings compare lexicographically; `===`/`!==`
  also on arrays/objects/instances, comparing **reference identity** — see below), logical
  `&& || !`, string concatenation (`"a" + b`, numbers coerce), array indexing `a[i]`, member
  access `obj.field`, array `.length`. `&&` / `||` follow **JS semantics — they return one of the
  operands, not a coerced boolean** (`a || b` → first truthy, `a && b` → first falsy; `0`/`NaN`/`""`
  are falsy); both-boolean operands keep a boolean result. The operands must share a type (no union
  result), and short-circuit + single left-evaluation are preserved (via an IIFE).
- **Strings:** literals, concatenation, lexicographic comparison, `s.length`, character access
  `s[i]` (→ a one-char string), and methods `substring` / `slice` / `indexOf` / `charAt` /
  `charCodeAt` / `toUpperCase` / `toLowerCase` / `split` (`s.split(sep[, limit])` → `string[]`;
  string separators only — regex is out of subset) (JS `String.prototype` semantics, ASCII).
- **`console.log(x)`** for any value, JS-style (matches Node's `console.log`): numbers shortest-
  round-trip, booleans `true`/`false`, top-level strings bare; arrays `[ 1, 2 ]`, objects
  `{ k: v }`, class instances `Name { k: v }`, with nested strings quoted (`'x'`) and aggregates
  printed recursively (single-line; see _Richer console.log_ in the roadmap for the size caveat).
- **Variables:** `let` / `const` (initializer required); a type annotation is optional — without
  one the type is **inferred from the initializer**. `var` is **not supported** (errors). Assignment
  `x = e`, `a[i] = e`, `obj.f = e`, compound `+= -= *= /= %=`, and `i++` / `i--`. A **top-level**
  `let`/`const` is a *module* variable: in the entry it becomes a file-scope global (so a function may
  read it); in an imported module it becomes a field of that module's record (see _Modules_).
- **Arrays & objects are reference types** (like classes, and like JS): `let b = a` aliases the
  same value, a mutation through one alias is visible through the other, a callee can mutate an
  array/object **parameter** (visible to the caller), and `===`/`!==` compare **identity** (two
  distinct literals with equal contents are `!==`). They compile to `std::shared_ptr<…>`.
- **Arrays:** literals (incl. empty `[]` with an annotation); `xs.push(v)` (returns the new
  `length`, usable as a value); `xs.pop()` → the removed last element (empty array → the element
  type's default, since the subset has no `undefined`); `xs.slice(start?, end?)` → a *new* array
  (negatives count from the end); `xs.indexOf(v[, from])` → `number` (`-1` if absent; element
  `===`, so object/array-element arrays are rejected; class elements compare by identity); and
  `xs.join(sep?)` → `string` (separator defaults to `","`; `string[]` and `number[]`).
- **Control flow:** `if` / `else`, `while`, `for (init; cond; update)`.
- **Functions:** top-level, typed params + return type, `return`, calls, `void`; recursion works.
  Params and returns may be **arrays and objects**, not just scalars. Every parameter passes **by
  value** — for arrays/objects/instances that's a `shared_ptr` copy (a refcount bump) that aliases
  the caller's value, so a callee mutation is visible to the caller (JS reference semantics);
  returns likewise hand back the shared reference.
- **Classes:** `class C { f: T; constructor(...) {…}; method(...): R {…} }`, `new C(...)`,
  `this.field` / `this.method()` (read + write), instances in variables / params / returns / arrays.
  Instances are **reference types** (`new` is shared; `let b = a` aliases, so a mutation through one
  is visible through the other; `a === b` is identity) — the same representation arrays and objects
  now use. Access modifiers (`public`/`private`/…) are accepted and ignored. **Deferred** (clean
  `tsnc:` errors): `extends`/`implements`, `static`, get/set accessors, parameter properties, field
  initializers, no-constructor classes, and bare `this` as a value.
- **Modules:** multi-file programs via `export` on a declaration (`export function`/`class`/`const`/
  `let`) and named imports `import { a, b } from "./relative/path"` (relative specifiers only, →
  `<spec>.ts`). The compiler resolves the import graph from the entry, lowers every reachable file,
  and **bundles** them into one translation unit ([src/frontend/modules.ts](src/frontend/modules.ts)),
  with each module **scoped independently**:
  - **Functions and classes** stay top-level C++ symbols; a name reused across modules is **mangled
    apart** (`tsn_m<idx>_<name>`), a program-unique name kept verbatim. Importers call/construct them
    directly.
  - A **dependency module** (one that is imported) compiles to a **memoized `init()`** that runs its
    top-level **once** and returns a **record (struct) of its module variables**. A reference to such
    a variable — from the module's own functions *or* from an importer — reads it back as
    `init().field`. So module-private top-level state is encapsulated (it doesn't leak into a global
    namespace), and a **function can read its module's variables** (e.g. `export function f() { return
    x }` where `x` is module-level). `main()` runs each dependency's `init()` **eagerly, in dependency
    order**, before the entry's own top-level — so a module's top-level side effects happen at import
    time (ES-module semantics).
  - The **entry module** keeps its top-level in `main()` with its own variables as file-scope globals
    (nothing imports the entry). A **single-file program is just an entry**, so its codegen is exactly
    as before — no records, no perf change.

  The stage-0 TS checker enforces real module semantics (you may only use what you export/import) — so
  an importer can't reach a module's private variables even though the module's own functions can.
  **Deferred** (clean `tsnc:` errors): `export default`/default imports, `import * as` namespace
  imports, import aliasing (`{ a as b }`), re-export statements, package/non-relative specifiers, and
  circular imports.

### Representation / behavior notes (read these — they bite)

tsn types map onto C++ types (see [src/codegen/CLAUDE.md](src/codegen/CLAUDE.md)):

| tsn type  | C++ type                | notes                                                                                                                                                |
| --------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| number    | `double` or `long long` | IEEE f64 by default; **integer-valued numbers use a 64-bit int rep** (see below). Printed JS-style                                                   |
| boolean   | `bool`                  | `console.log` prints `true` / `false` (via `tsn_inspect`)                                                                                            |
| string    | `tsn_str`               | ref-counted immutable string; copy = pointer + refcount bump (no char copy); methods → `tsn_*` helpers                                               |
| `T[]`     | `std::shared_ptr<std::vector<T>>` | **reference** type: heap vector, shared on copy/assign (aliasing, shared mutation, identity `===`); `.length` → `->size()`, index `(*a)[i]`, methods → `tsn_*` helpers on `*a` |
| `{ ... }` | `std::shared_ptr<struct>` | **reference** type: heap struct (one per distinct field shape), shared on copy/assign; field access `obj->f`                                       |
| class `C` | `std::shared_ptr<C>`    | **reference** type: `new C()` is heap + ref-counted; copy/assign aliases (shared mutation, identity via `==`); `struct C { fields; ctor; methods; }` |

- **`number` is f64, but integer-valued numbers use a 64-bit integer representation.** A
  pre-pass ([src/codegen/repr.ts](src/codegen/repr.ts)) infers, per variable / parameter / return,
  whether every value reaching it is provably integer-valued; if so it's emitted as `long long`
  (`i64`) instead of `double` (`f64`). This gives integer arithmetic, `%`, and comparisons the
  CPU's integer units — **~1.8× on integer-heavy loops** (a prime sieve; and tsnc now _beats_ V8
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
- **Arrays/objects are reference types (`shared_ptr`), matching JS.** `let b = a` aliases the
  same heap value, so `b.push(v)` / `b[i] = e` / `b.f = e` is visible through `a`; `===`/`!==`
  compare pointer identity (two distinct literals with equal contents are `!==`); and a function
  can mutate an array/object parameter — the mutation is visible to the caller. The cost is one
  `shared_ptr` indirection per element/field access (`(*a)[i]`, `obj->f`); `clang -O3` hoists the
  invariant pointer out of hot loops, so the integer benchmark (no arrays) is unaffected and the
  array-heavy word-sort pays only ~3% at the largest JIT-warm sizes (see the roadmap). This
  replaces the earlier value-typed model (`std::vector`/`struct` by value, `const&` read-only
  params) — that was a deliberate, documented divergence from JS that reference-typing removes.
- **Function boundaries:** params and returns may be arrays/objects. Every parameter passes **by
  value**; for a reference type (array/object/instance) that's a `shared_ptr` copy — a refcount
  bump that aliases the caller's value, so callee mutations are visible to the caller (JS
  semantics). Returns hand back the shared reference the same way (a `shared_ptr`, not a deep copy).
- **Aggregates nest:** object fields and array elements may themselves be aggregates —
  `{ pts: number[] }`, `{ inner: { x: number } }`, `number[][]`, `{ x: number }[]`. These map to
  C++ as nested reference types (`std::shared_ptr<std::vector<std::shared_ptr<std::vector<double>>>>`,
  a struct whose members are `shared_ptr`s), and `lowerType` / struct generation recurse through the
  shape. Nested _number_ fields and elements always use the f64 rep (`double`). Reading, mutating
  (`box.inner.x = 9`, `poly.pts[0] = 9`), and pushing onto a nested array (`poly.pts.push(v)`) all
  work; an empty array as a field (`{ pts: [] }`) still errors (no annotation to infer the element
  type from).

The compiler **errors cleanly** — TypeScript-quality diagnostics from the stage-0 type checker for
type errors (caught before codegen), and a `tsnc:` message for constructs the subset doesn't lower
(void-as-value, an empty array literal with no annotation, etc.) — never a silent miscompile.

### Unsupported types (rejected at lowering)

Every type annotation must lower to one of the supported types above; anything else throws
`tsnc: Unsupported type annotation: <SyntaxKind>` from `lowerType` ([src/frontend/lower.ts](src/frontend/lower.ts)).
Not yet supported:

| Type                 | Example                       | Notes                                                 |
| -------------------- | ----------------------------- | ----------------------------------------------------- |
| Union                | `number \| string`            | No tagged-union representation yet.                   |
| `any`                | `let x: any`                  | Would erase the static type codegen relies on.        |
| `unknown` / `never`  | `let x: unknown`              | Same reason as `any`.                                 |
| Tuple                | `[number, string]`            | Only homogeneous `T[]` arrays are supported.          |
| Literal / enum       | `"a" \| "b"`, `enum E {}`     | No literal types or enums.                            |
| Intersection         | `A & B`                       | No type composition.                                  |
| Function type        | `(x: number) => number`       | No first-class function values / closures.            |
| Generic / type param | `Map<K, V>`, `<T>(x: T) => T` | Only the built-in `Array<T>` is special-cased.        |
| `null` / `undefined` | `string \| null`              | No nullable types; no optional (`x?:`) fields/params. |

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
      _beats_ a JIT-warm V8 on integer work (~2× on the prime sieve; see the integer fast path
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
      Turned out _not_ to need the scalar-only boundary lifted: a `methodCall` result already flows
      through `RetType`, and arrays are first-class in `let` / indexing / `.length`, so a method
      returning `string[]` just works. Runtime helpers `tsn_split` / `tsn_join`.
- [x] **Lift scalar-only boundaries** — function params and returns may be arrays/objects now
      (front-end checks dropped). Aggregate params pass by `const&` (read-only — mutating one is a
      clean `tsnc:` error rather than a silent JS-semantics divergence); aggregate returns pass by
      value via RVO/move, so a copy lands only where the result is bound or used. Exposed and fixed
      a latent aggregate-literal bug: building a `vector`/`struct` from a _non-constant_ integer
      number now casts `long long`→`double` (a brace-init narrowing clang rejected; literal
      constants like `3LL` had slipped through). Object _fields_ stay scalar-only.
- [x] **Nested objects and arrays** — aggregates nest: object fields that are arrays or objects
      (`{ pts: number[] }`, `{ inner: { x: number } }`) and arrays of aggregates (`number[][]`,
      `{ x: number }[]`). Turned out to be mostly _removing_ code: arrays of aggregates and
      `number[][]` already worked (`lowerType` recurses through array element types, and
      `f64SlotCode`/struct generation handle aggregate values), so the only blocks were two
      scalar-field guards — one in `lowerType`, one in the object-literal emitter. Dropping both
      lit up the whole surface: construction, indexing, field access, mutation (`box.inner.x = 9`,
      `poly.pts[0] = 9`), `push` onto a nested array, and crossing function boundaries
      (`{x;y}[]` param by `const&`, `number[][]` return by value). Nested structs generate inner
      before outer (correct C++ order); nested numbers stay f64. `console.log` of an aggregate is
      still a clean error (JS-style printing is the separate _Richer `console.log`_ item); an empty
      array field (`{ pts: [] }`) still errors (no element type to infer).
- [x] **Classes (basic shape)** — fields, one constructor, instance methods, `new C(...)`,
      `this.field` / `this.method()` (read + write), instances in variables / params / returns /
      arrays. The design decision the roadmap flagged was **identity**: instances are _reference_
      types, solved by compiling a class to `struct C { fields; ctor; methods; }` and an instance to
      `std::shared_ptr<C>` — exactly the "heap + ref-counted, like `tsn_str`" the roadmap called for,
      and reference semantics (aliasing, shared mutation, `===` identity) fall out for free. Methods
      and the constructor are first-class analyzed scopes (keys `C#method` / `C#$ctor`), so `repr.ts`
      gives method-local numbers the same i64/f64 treatment _and_ keeps cross-calls sound; fields are
      always f64. Instances are deliberately **not** `isAggregate` — they pass **by value** (a
      `shared_ptr` copy = a refcount bump) and stay **mutable**, so a callee's `p.x = …` is visible to
      the caller (JS reference semantics), whereas value-typed array/object params are `const&`/
      read-only. Classes are forward-declared so fields can reference a later/self class; method/ctor
      bodies are emitted out-of-line. Deferred (clean `tsnc:` errors): `extends`/`implements`,
      `static`, accessors, parameter properties, field initializers, no-constructor classes, and bare
      `this` as a value. `console.log` of an instance is a clean error (see _Richer `console.log`_).
- [x] **More array methods** — `pop`, `indexOf`, `slice`, and `push` as a value. No IR or front-end
      change was needed: `xs.pop()` / `xs.slice(…)` / `xs.indexOf(…)` already lower to `methodCall`,
      so this was purely codegen — four `tsn_*` **template** helpers (over the element type `T`) plus
      a rewritten array branch in `emitMethodCall`. `push` now returns the new `length` (an f64
      number) instead of `void`, so it's usable as a value _or_ a statement; `pop` returns the
      element type and mutates (so it's rejected through a `const&` aggregate param, like `push`);
      `slice` returns a new array by value (negatives count from the end, omitted args = NaN
      "default", mirroring the string `tsn_slice`); `indexOf` returns `-1`/index via element `==`
      (so object/array-element arrays are a clean `tsnc:` error, while class elements compare by
      identity = JS `===`). The one subset divergence: popping an empty array yields the element
      type's default (`0` / `""`) — there's no `undefined` to return. `repr.ts` learned the array
      methods' return types (e.g. array `slice` is an array, not a string) so number-rep slots stay
      sound; all number method-returns remain f64, so the emitter's rep-tagging was untouched.

- [x] **Arrays & objects as reference types (+ reference equality)** — arrays and object literals
      now compile to `std::shared_ptr<std::vector<T>>` / `std::shared_ptr<struct>`, the same
      reference treatment classes already had, so JS semantics fall out: `let b = a` aliases, a
      mutation through one alias (`b.push(v)`, `b[i] = e`, `b.f = e`) is visible through the other,
      a callee can mutate an array/object **parameter** (visible to the caller), and `===`/`!==`
      compare **pointer identity** (`shared_ptr::operator==`) — two distinct literals with equal
      contents are `!==`. This subsumes the old "Object/array reference equality" roadmap item (the
      equality guard in `emitBinary` is just dropped — identity comparison is free once values are
      `shared_ptr`s). The change was concentrated in codegen: `cppType` wraps aggregates in
      `shared_ptr`, literals `make_shared`, indexing derefs (`(*a)[i]`), members use `->`, the array
      helpers run on `*recv`, and `slice`/`split` re-wrap their results. It also _deleted_ machinery:
      the whole read-only-param apparatus (`readonlyParams` / `assertMutable` / `rootVarName`) is
      gone, since arrays/objects are now freely mutable references, and `paramType` collapsed to a
      single by-value rule (a `shared_ptr` copy is a refcount bump). **Cost:** one `shared_ptr`
      indirection per element/field access; `clang -O3` hoists the invariant pointer out of hot
      loops, so the integer benchmark (no arrays) is byte-identical/unaffected and the array-heavy
      word-sort pays only ~3% at the largest JIT-warm sizes (0.90× → 0.88× vs V8; a worktree A/B
      against the prior by-value build).
- [x] **Richer `console.log`** — `console.log` now prints any value JS-style, matching Node's
      `console.log` (`util.inspect`) byte-for-byte on the subset: booleans `true`/`false`, top-level
      strings bare, numbers shortest-round-trip; arrays `[ 1, 2 ]`, objects `{ k: v }`, class
      instances `Name { k: v }`, with nested strings quoted (`'x'`) and aggregates printed
      recursively. Implemented as a `tsn_inspect` family in the prelude — fixed scalar overloads + a
      `tsn_quote`, an array-inspect **template** (over the element type), and one generated overload
      per object struct / class (knowing its field names). The `log` statement routes booleans and
      reference types through `tsn_inspect` (numbers/top-level strings keep their bare form). The
      quote/escape characters are built from their byte values so the generated C++ contains no
      backslashes. This also removed the three `console.log`-of-aggregate/instance errors. The one
      caveat: the formatter is always single-line (no `breakLength` wrapping), so it matches Node
      for small values — keep logged aggregates small in test cases.
- [x] **Full `ts.Program` + TypeChecker** — a real `ts.Program` + `TypeChecker`
      ([src/frontend/check.ts](src/frontend/check.ts)) runs as **stage 0**, before lowering, and
      aborts on any TypeScript type error with full colorized, code-framed diagnostics (surfaced
      through the CLI's `tsnc:` prefix). It catches what the emitter's local checks missed — wrong
      assignment types, undeclared names, bad argument counts/types, bad property access — at the
      source level instead of as a late `tsnc:` message or a miscompile. Built over an in-memory copy
      of the source plus a tiny ambient `console` declaration, loading only the **ES2020 lib** (not
      DOM, so its hundreds of globals can't shadow user names) under `strict: true` (plus `module:
      ESNext` + `moduleResolution: Bundler`, so it resolves the whole import graph from disk and
      checks cross-module types — see _Modules_). All 78 e2e cases type-check clean under these
      options (verified empirically); rejection behavior — which can't
      be a case pair — is covered by [tests/typecheck.test.ts](tests/typecheck.test.ts). Subset-
      specific rejections (e.g. `var`) still happen later in lowering; this stage only enforces
      TypeScript's semantics. Note: lowering still reads annotations directly (it does not yet thread
      the `TypeChecker`'s inferred types through), so the checker is a gate, not yet the type source.

- [x] **Modules (`import` / `export`)** — multi-file programs, with each module **scoped
      independently**. A stage-1 loader ([src/frontend/modules.ts](src/frontend/modules.ts)) starts at
      the entry, follows `import`s to build the dependency graph (relative specifiers → `<spec>.ts`),
      topologically sorts it, lowers every reachable file with the existing `lower`, runs a scope-aware
      **resolver/renamer** per module, and **bundles** everything into one IR `Module` (the backend is
      one translation unit / one binary). The scoping model (after a couple of iterations on the
      design): **functions and classes** stay top-level C++ symbols, mangled apart on a cross-module
      name collision (`tsn_m<idx>_<name>`) and otherwise kept verbatim; a **dependency module** (one
      that's imported) compiles to a **memoized `init()`** returning a **record (struct) of its module
      variables** — a reference to a module variable, from the module's own functions *or* an importer,
      is rewritten by the resolver into `init().field` (reusing the existing object/member codegen). So
      module-private state is encapsulated (it never becomes a global), yet a function **can** read its
      module's variables. `main()` runs each dependency's `init()` **eagerly in dependency order**
      before the entry's top-level (ES-module side-effect timing). The **entry** keeps its top-level in
      `main()` with its own variables as **file-scope globals** (promoted so functions can read them);
      a **single-file program is just an entry**, so its codegen — and the prime-sieve benchmark — is
      unchanged. The stage-0 TS checker (now `module: ESNext` + `moduleResolution: Bundler`) resolves
      the graph from disk and enforces real module semantics (use-of-non-exported, missing members,
      cross-file type mismatches), so an importer can't reach a module's private variables even though
      the module's own functions can. Reserved C++ identifiers (e.g. an entry variable/function named
      `main`) are mangled too. The number-rep pass ([src/codegen/repr.ts](src/codegen/repr.ts)) gained
      **global rep slots** (entry globals keep the i64 fast path) and analyzes dependency `init` bodies.
      Shipped alongside: **JS-semantics `&&`/`||`** (return an operand, not a coerced boolean; truthy
      `||` / falsy `&&`; short-circuit + single left-eval via an IIFE; both-boolean stays boolean) —
      needed for the `x || fallback` idiom. **Deferred** (clean `tsnc:` errors): `export default`/
      default imports, `import * as` namespace imports, import aliasing (`{ a as b }`), re-export
      statements, non-relative specifiers, and circular imports. Helper modules for the e2e suite live
      in `tests/cases/modlib/` (a subdirectory, so the non-recursive harness doesn't run them as
      standalone cases); structural rejections are in [tests/modules.test.ts](tests/modules.test.ts).

### Later

- [ ] **Classes — beyond the basic shape** — the basic shape is done (see above). Still to come:
      `extends` / inheritance (base-struct layout + virtual dispatch + `super(...)`), enforcing
      `private`/`public`/`protected`/`readonly` visibility, `static` members, get/set accessors,
      parameter properties, field initializers (default member init), and bare `this` as a value
      (via `std::enable_shared_from_this`, so `let b = this` / passing `this` around works).
- [ ] **Closures, generics** — first-class function values and type parameters. (`import`/`export`
      modules shipped — see _Done_; a module variable is already usable inside that module's function
      bodies, via the module record.)

## will never support

- class bare `this` as a value ( `let b = this` / passing `this` around works)
- typescript any type
