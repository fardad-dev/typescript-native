# typescript-native (`tsnc`)

An ahead-of-time compiler that turns a subset of **TypeScript** into a native **executable**:
TypeScript source → **C++** → machine code → linked binary. No Node, no V8, no JIT — the output is
a standalone binary.

This is a learning-oriented compiler. Favor clarity and a working end-to-end pipeline over feature
breadth or premature optimization.

## The pipeline

```
.ts entry
  │ (0) type-check        frontend/check.ts   ts.Program + TypeChecker; abort on type errors
  ▼
  │ (1) resolve + parse   frontend/modules.ts → frontend/lower.ts   follow imports, parse each file
  ▼
  │ (2) lower + bundle    frontend/lower.ts → ir/nodes.ts   merge the module graph into ONE Module
  ▼  internal IR
  │ (3) codegen           codegen/emit.ts     IR → readable C++ source
  ▼  .cpp
  │ (4) compile + link    backend/clang.ts    clang++ -std=c++20 -O3 program.cpp -o program
  ▼
native executable
```

- **Stage 0** runs a real `ts.Program` + `TypeChecker` over the whole import graph and aborts with
  TypeScript-quality diagnostics on any type error — so bad types, undeclared names, wrong argument
  counts, and bad property access (including cross-module) are caught before we lower.
- **Stage 1** starts at the entry, follows `import`s, lowers every reachable file, and **bundles**
  them into one IR `Module` (the backend emits one translation unit). A single-file program is a
  one-node graph.
- **C++ is the intermediate language:** codegen emits readable C++ and `clang++` does the real
  lowering to machine code.

Each `src/` folder has its own `CLAUDE.md` with detail.

## Tech stack

| Concern   | Choice                                                      |
| --------- | ----------------------------------------------------------- |
| Compiler  | **TypeScript** on Node (>= 22)                              |
| Parsing   | Official **`typescript`** package (reuse its lexer/parser)  |
| Backend   | Emit **C++**, compile with **`clang++ -std=c++20 -O3`**     |
| Target    | native binary for this host (Apple Silicon / arm64 macOS)   |
| CLI       | **commander**                                               |
| Tests     | **vitest** (end-to-end: compile → run → diff stdout)        |

## Project structure

```
src/
  index.ts            CLI entry (tsnc): parse args, call compile()
  driver.ts           orchestrate the pipeline stages (0 → 4)
  frontend/
    check.ts          (0) type-check; abort on errors
    modules.ts        (1) resolve the import graph, lower each file, merge → one Module
    lower.ts          (1)(2) parse + lower one file's AST → IR
  ir/nodes.ts         the typed IR (contract between lower and emit)
  codegen/
    emit.ts           (3) IR → C++ source text
    repr.ts           number-representation pass (i64/f64), run before emit
    closures.ts       closure-capture pass, run before emit
    cpp/tsn_runtime.h the fixed C++ runtime, #included by every emitted .cpp
  backend/clang.ts    (4) compile + link via clang++
tests/
  e2e.test.ts         harness: compile each case, run, diff stdout
  cases/              *.ts inputs + *.expected stdout (one pair per feature)
  *.test.ts           rejection suites (typecheck, modules, union, closures, …)
```

## How to run

```bash
npm run build                                  # tsc → dist/
node dist/index.js prog.ts -o prog             # compile a .ts program to a binary
./prog                                         # run it
node dist/index.js prog.ts -o prog --emit-cpp  # also write prog.cpp
```

## How to test

```bash
npm test            # run the e2e suite once (vitest run)
npm run test:watch  # TDD red→green loop
```

The suite auto-discovers every `tests/cases/*.ts`, compiles it to a real binary, runs it, and diffs
stdout against the matching `.expected`. **Every feature ships a `cases/*.ts` + `.expected` pair**,
written first (red) then implemented to green. Programs that must be *rejected* can't be a case
pair, so they live in the `*.test.ts` suites. See [tests/CLAUDE.md](tests/CLAUDE.md).

## Language support (summary)

Implemented and tested end-to-end:

- **Types:** `number`, `boolean`, `string`, `null`, `undefined`, arrays (`T[]`/`Array<T>`), object
  literal types, **union types** (`A | B`), **function types** (`(x: T) => R`), `Map<K,V>`,
  `Set<T>`, `Promise<T>`, `Response`. Aggregates nest.
- **Union types & narrowing:** flow narrowing via `typeof`, `=== null`/`undefined`, truthiness, and
  `&&` chains (incl. early-return narrowing). A member widens into a union on assignment/arg/return.
- **Operators:** arithmetic, comparison (numbers, strings, identity on reference types), logical
  (`&&`/`||` return an operand, JS semantics), ternary, string concat, indexing, member access.
- **Strings:** literals, template interpolation, and the full scalar method surface (`substring`,
  `slice`, `split`, `indexOf`, `includes`, `replace`, `trim`, `pad*`, …; no regex).
- **`console.log`** — JS-style, matching Node's `util.inspect` byte-for-byte on the subset.
- **`JSON.stringify` / `JSON.parse`** — match Node byte-for-byte; `parse` needs a target type
  (`JSON.parse(text) as T`).
- **Variables:** `let`/`const` (type optional, inferred from initializer); `var` rejected.
- **Arrays:** literals, and non-callback methods (`push`/`pop`/`slice`/`concat`/`join`/`indexOf`/…).
  Callback methods (`map`/`filter`/…) are not yet implemented.
- **`Math.*`**, **`Map`/`Set`** (reference types).
- **Control flow:** `if`/`else`, `while`, `do…while`, `for`, `for…of`, `for…in`, `switch`,
  `break`/`continue` (+ labeled loops), `try`/`catch`/`finally`/`throw` (string-only throws).
- **Functions:** top-level, typed params + return, recursion; **default / rest / destructuring
  params** and **spread args**; **destructuring & spread** in `let`/`const`.
- **Closures & first-class functions:** arrows, function expressions, function values; closures
  capture by reference with full JS semantics (boxed in a shared heap cell).
- **Async/await:** faithful event-loop model (`async` → C++20 coroutine, `await` → microtask
  suspension), `Promise<T>`, `Promise.resolve`/`all`, top-level `await` in the entry. Byte-for-byte
  Node ordering.
- **`fetch(url)`** — real, `await`-able HTTP GET → `Promise<Response>` (blocking libcurl under the
  hood; links `-lcurl` only when used).
- **Classes:** fields, one constructor, instance methods, `new`, `this.field`/`this.method()`.
  Reference types. (No `extends`/`static`/accessors yet.)
- **Modules:** the full `export`/`import` surface over relative specifiers — `export` on a
  declaration, export lists (`export { a, b as c }`), default exports (`export default fn/class/expr`),
  re-exports (`export { x } from`, `export * from`), and every import form (named, aliased
  `{ a as b }`, default `import d from`, namespace `import * as ns`). The graph is bundled into one
  binary, each module scoped independently.

The compiler **errors cleanly** — TypeScript diagnostics from stage 0, or a `tsnc:` message for
constructs the subset doesn't lower — never a silent miscompile. For the full surface and every
deferred case, see git history and the per-folder `CLAUDE.md` files.

## Roadmap (ordered by impact — most-used first)

Every item ships a `tests/cases/*.ts` + `.expected` pair (red → green).

1. **Callback array methods** — `map` / `filter` / `reduce` / `forEach` / `some` / `every` / `find` /
   `findIndex` / `sort`. The single most-used missing feature; now **unblocked by closures**. Same for
   `Map`/`Set.forEach` and `new Promise(executor)`.
2. **Optional chaining `?.` & nullish coalescing `??`** — pervasive in modern TS; the union/`undefined`
   machinery is already in place.
3. **`console.log` with multiple args** — currently exactly one; cheap.
4. **Bitwise `& | ^ ~ << >> >>>` & exponentiation `**`** — cheap and self-contained (one IR node + one
   `lower` branch + one `emit` case each).
5. **Optional object fields `{ x?: T }`** — common; needs object-literal field-defaulting.
6. **Classes beyond the basic shape** — `extends`/inheritance, `static`, accessors, parameter
   properties, field initializers, visibility enforcement.
7. **Enums, literal types, tuples** — need more type-system work.
8. **Generics / type parameters** (`<T>(x: T) => T`, user `Box<T>`) — the largest type-system lift.

**Module forms — permanently unsupported** (clean errors, not roadmap): **non-relative / package
specifiers** (they reference external npm packages there's no way to compile to native) and
**circular imports** (the eager memoized-record `init()` model would risk a silent miscompile under
ES cycle/TDZ semantics — and silent miscompiles are off the table). Also rejected: namespace
re-export (`export * as ns from`) and the CommonJS `export =`. Every other import/export form is
supported (see *Language support*).

**Will never support:** the `any` type, and bare `this` as a value.

## Representation notes (read these — they bite)

tsn types map onto C++ types (full table in [src/codegen/CLAUDE.md](src/codegen/CLAUDE.md)):

| tsn type             | C++ type                  | notes                                                            |
| -------------------- | ------------------------- | ---------------------------------------------------------------- |
| number               | `double` or `long long`   | f64 by default; integer-valued slots use an i64 rep (see below)  |
| boolean              | `bool`                    |                                                                  |
| string               | `tsn_str`                 | ref-counted immutable string; copy = pointer + refcount bump     |
| `T[]`                | `tsn_rc<std::vector<T>>`  | reference type                                                   |
| `{ ... }`            | `tsn_rc<struct>`          | reference type, one struct per field shape                       |
| class `C`            | `tsn_rc<C>`               | reference type                                                   |
| `Map`/`Set`          | `tsn_rc<tsn_map/tsn_set>` | reference types, insertion-ordered                               |
| `Promise<T>`         | `tsn_promise<T>`          | C++20 coroutine handle                                           |
| `A \| B`             | `tsn_union<…>`            | a `std::variant` wrapper                                         |
| `(P…) => R`          | `std::function<R(P…)>`    | reference type; captured locals are boxed (`tsn_rc<tsn_box<T>>`) |
| `null`/`undefined`   | `tsn_null`/`tsn_undefined`| empty tag structs                                                |

- **`number` is f64, but integer-valued numbers use a 64-bit int rep.** [repr.ts](src/codegen/repr.ts)
  infers per slot whether only integer values can flow in; if so it emits `long long` instead of
  `double` (~1.8× on integer-heavy loops). Soundness: a slot is i64 only when no fraction can reach
  it. `/` is **always** float division; `%` returns f64 (so `x % 0 === NaN`). Object fields and array
  elements are always f64.
- **`string` is ref-counted (`tsn_str`), not `std::string`.** TS strings are immutable, so copy bumps
  a counter and aliases the same buffer (cheap shuffles, but every string is a heap alloc). The
  refcount is a plain non-atomic `long` — generated programs are single-threaded.
- **Arrays, objects, class instances, Map/Set are reference types (`tsn_rc`), matching JS.**
  `let b = a` aliases, mutation through one alias is visible through the other, callees can mutate
  reference-type params, and `===`/`!==` compare identity. `tsn_rc` is a **non-atomic** ref-counted
  pointer (not `std::shared_ptr`, whose atomic refcount dominated shuffle-heavy loops — ~6× on the
  object benchmark).
- **Every parameter passes by value.** For a reference type that's a `tsn_rc` copy (a refcount bump)
  aliasing the caller's value, so callee mutations are visible. Returns hand back the shared reference.
- **Aggregates nest:** fields/elements may themselves be aggregates; `lowerType`/struct generation
  recurse. Nested numbers are always f64.

## Conventions

- **Codegen is expression-based:** `emitExpr` returns a C++ expression string; lean on the C++
  compiler instead of hand-managing temporaries.
- Fully parenthesize binary expressions to preserve precedence.
- `console.log` → `std::cout << expr << "\n"`.
- Out-of-scope constructs throw a clear `Error` (surfaced as `tsnc: <message>`) — never a silent
  miscompile.
- Prefer small, pure helpers; one `emitX`/`lowerX` per node kind.
- **Every feature gets a `tests/cases/*.ts` + `.expected` pair**, ideally written first.

### Verified environment (this machine)

- Apple Silicon (arm64), macOS (Darwin 24.6); Apple **clang++ 17** at `/usr/bin/clang++`; `node` v22.
- We compile with `-std=c++20` (coroutines back async/await; clang 17 supports them with no extra
  flag). A non-async program also builds under the default standard.
