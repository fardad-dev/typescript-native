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
| Backend             | **Emit C++ source**, compile with **`clang++ -std=c++20 -O3`** |
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
    cpp/
      tsn_runtime.h # the fixed C++ runtime (tsn_str, helpers, tsn_inspect) — #included by every emitted .cpp
  backend/
    clang.ts        # (4) shell out to clang++ to compile + link the .cpp
scripts/
  copy-runtime.mjs  # post-build: copy src/codegen/cpp/ -> dist/codegen/cpp/ (the .h isn't transpiled by tsc)
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

The suite (currently **141 e2e cases** + a stage-0 type-checker test file + a module-loader test
file + a `fetch` test file + union-, closure-, and destructuring/spread/rest-rejection test files,
all green) auto-discovers every `tests/cases/*.ts`, compiles it to a real native binary,
runs it, and diffs stdout against the matching `.expected` file. **Every feature gets a
`tests/cases/*.ts` + `.expected` pair**, ideally written first (red), then implemented to green.
Programs that must be *rejected* (type errors) can't be expressed as a case pair, so they live in
[tests/typecheck.test.ts](tests/typecheck.test.ts); structural module-graph rejections (cycles,
name collisions, unsupported import forms) live in [tests/modules.test.ts](tests/modules.test.ts);
union-specific subset rejections (optional object fields, …) live in
[tests/union.test.ts](tests/union.test.ts); and destructuring/spread/rest/default-parameter subset
rejections (object rest, destructured `for…of`, spread into a fixed parameter, …) live in
[tests/destructure.test.ts](tests/destructure.test.ts). See [tests/CLAUDE.md](tests/CLAUDE.md).

## Current language support

Implemented and tested end-to-end:

- **Types:** `number`, `boolean`, `string`, `null`, `undefined`, arrays (`T[]` / `Array<T>`),
  object literal types (`{ x: number; y: string }`), and **union types** (`A | B | …`, e.g.
  `number | string`, `T | null`, `T | undefined`). Aggregates **nest** — array elements and object
  fields may themselves be arrays/objects (`number[][]`, `{ pts: number[] }`, `{ x: number }[]`,
  `{ inner: { x: number } }`).
- **Values:** numeric/boolean/string literals, the `null`/`undefined` literals, array literals
  `[...]`, object literals `{...}`.
- **Union types & narrowing:** a union `A | B | …` (members **canonicalized** so `number | string`
  ≡ `string | number`) compiles to a `tsn_union<…>` (a `std::variant` wrapper; `null`/`undefined`
  are empty tag structs). A member **widens** into a union on assignment/argument/return (explicit
  `std::in_place_type` construction), and a narrower union widens into a wider one. `console.log`
  prints the active member (a string bare, like a top-level string); `===`/`!==` compares a union
  against a member (holds-and-equals) or two equal unions. **Flow narrowing** lets a union be *used*
  as one of its members inside a guard — `typeof x === "…"`, `x === null`/`undefined`, bare
  truthiness, and boolean-`&&` chains, in `if`/`else`/ternary, plus **early-return** narrowing
  (`if (x === null) return; …` narrows the fallthrough). A narrowed read emits `std::get<Member>`
  (sound — the stage-0 checker proved the guard holds); reassignment drops the narrowing.
  **`typeof e`** is a first-class `string` (resolved at runtime for a union; statically otherwise;
  `typeof null === "object"`). **Optional parameters** `(a?: T)` desugar to `T | undefined` (an
  omitted trailing arg defaults to `undefined`). **Deferred** (clean `tsnc:` errors): optional
  object fields (`{ x?: T }` — need literal field-defaulting), a ternary whose branches have
  *different* types (no union-merge yet), and union-typed array/Map/Set element coercion.
- **Type checking:** a real `ts.Program` + `TypeChecker` runs **before** lowering and aborts on
  any TypeScript type error with full diagnostics (wrong assignment types, undeclared names, bad
  argument counts/types, bad property access). See [src/frontend/check.ts](src/frontend/check.ts).
- **Operators:** arithmetic `+ - * / %`, unary `-` / `+` (`-x`, `-5`), comparison
  `< <= > >= === !==` (numbers **and** strings — strings compare lexicographically; `===`/`!==`
  also on arrays/objects/instances, comparing **reference identity** — see below), logical
  `&& || !`, the ternary conditional `cond ? a : b`, string concatenation (`"a" + b`, numbers
  coerce), array indexing `a[i]`, member access `obj.field`, array `.length`. `&&` / `||` follow
  **JS semantics — they return one of the operands, not a coerced boolean** (`a || b` → first truthy,
  `a && b` → first falsy; `0`/`NaN`/`""` are falsy); both-boolean operands keep a boolean result. The
  operands must share a type (no union result), and short-circuit + single left-evaluation are
  preserved (via an IIFE). The **ternary** lowers to the C++ `?:`: its condition is a number/boolean
  (like `if`/`while`) and its two branches must share a type (that's the result type; no union) —
  for a number result the rep follows both branches (i64 only when both are).
- **Strings:** literals (`"..."` / no-substitution `` `...` ``), **template-literal interpolation**
  (`` `a${x}b` `` — desugars to `+`-concatenation, so interpolated values coerce the same operands
  `+` does: string and number), concatenation, lexicographic comparison, `s.length`, character access
  `s[i]` (→ a one-char string), and methods `substring` / `slice` / `indexOf` / `lastIndexOf` /
  `charAt` / `charCodeAt` / `toUpperCase` / `toLowerCase` / `split` (`s.split(sep[, limit])` →
  `string[]`; string separators only — regex is out of subset) / `includes` / `startsWith` /
  `endsWith` / `repeat` / `trim` / `trimStart` / `trimEnd` / `padStart` / `padEnd` / `replace` /
  `replaceAll` (string search + literal replacement only — no regex / `$`-patterns / function args) /
  `concat` (JS `String.prototype` semantics, ASCII).
- **`console.log(x)`** for any value, JS-style (matches Node's `console.log`): numbers shortest-
  round-trip, booleans `true`/`false`, top-level strings bare; arrays `[ 1, 2 ]`, objects
  `{ k: v }`, class instances `Name { k: v }`, with nested strings quoted (`'x'`) and aggregates
  printed recursively (single-line; see _Richer console.log_ in the roadmap for the size caveat).
- **`JSON.stringify(x)` / `JSON.parse(text)`** (single value arg), matching Node byte-for-byte on
  the subset. `JSON.stringify` serializes any value to a compact JSON `string` (double-quoted
  keys/strings with JSON escaping, no spaces, `null` for `NaN`/`Infinity`, no class name on an
  instance). `JSON.parse` is statically typed: TypeScript types it `any`, which the subset can't
  represent, so the **target type is required up front** — `JSON.parse(text) as T` or an annotated
  target (`const x: T = JSON.parse(text)`). `T` is any JSON **value** type (scalars, arrays,
  objects, nested); a **class** target is a clean `tsnc:` error (no prototype to rebuild). The
  runtime parses to a generic value and codegen extracts the typed value out of it; malformed JSON
  or a value that doesn't match `T` prints a message and exits non-zero (no exceptions in the
  subset — the closest analog to an uncaught JS `SyntaxError`). **Deferred** (clean errors): the
  `replacer`/`space` args of `stringify`, the `reviver` arg of `parse`, and class targets.
- **Variables:** `let` / `const` (initializer required); a type annotation is optional — without
  one the type is **inferred from the initializer**. `var` is **not supported** (errors). Assignment
  `x = e`, `a[i] = e`, `obj.f = e`, compound `+= -= *= /= %=`, and `i++` / `i--`. A **top-level**
  `let`/`const` is a *module* variable: in the entry it becomes a file-scope global (so a function may
  read it); in an imported module it becomes a field of that module's record (see _Modules_).
- **Arrays & objects are reference types** (like classes, and like JS): `let b = a` aliases the
  same value, a mutation through one alias is visible through the other, a callee can mutate an
  array/object **parameter** (visible to the caller), and `===`/`!==` compare **identity** (two
  distinct literals with equal contents are `!==`). They compile to `tsn_rc<…>` — a non-atomic
  ref-counted pointer (single-threaded, so cheaper than `std::shared_ptr`; see the rep notes).
- **Arrays:** literals (incl. empty `[]` with an annotation); `xs.push(v)` (returns the new
  `length`, usable as a value); `xs.pop()` / `xs.shift()` → the removed last/first element (empty
  array → the element type's default, since the subset has no `undefined`); `xs.unshift(...items)` →
  the new `length`; `xs.slice(start?, end?)` → a *new* array (negatives count from the end);
  `xs.concat(...arrays)` → a *new* array (array operands only); `xs.indexOf` / `xs.lastIndexOf`
  (`v[, from]`) → `number` (`-1` if absent) and `xs.includes(v[, from])` → `boolean` — all by element
  `===`, so object/array-element arrays are rejected (class elements compare by identity);
  `xs.reverse()` / `xs.fill(v[, start, end])` mutate in place and return the array; and
  `xs.join(sep?)` → `string` (separator defaults to `","`; `string[]` and `number[]`).
- **`Math.*`:** functions `abs` `floor` `ceil` `round` `trunc` `sign` `sqrt` `cbrt` `exp` `log`
  `log2` `log10` `sin` `cos` `tan` `asin` `acos` `atan` `sinh` `cosh` `tanh` `pow` `atan2`
  `min`/`max`/`hypot` (variadic) `random`, and constants `PI` `E` `LN2` `LN10` `LOG2E` `LOG10E`
  `SQRT2` `SQRT1_2`. Recognized as builtins in lowering (like `JSON.*`), always `number`-typed and
  always the f64 rep. Most map straight to `<cmath>`; JS-divergent ones use a `tsn_math_*` helper
  (`round` rounds half toward +∞; `min`/`max` propagate `NaN`; `sign`/`random`). Constants are
  emitted as exact double literals (byte-for-byte with Node).
- **`Map<K, V>` / `Set<T>`** — reference types (insertion-ordered, like JS), backed by `tsn_map` /
  `tsn_set` in the runtime. Construct `new Map<K, V>()` / `new Set<T>()` / `new Set<T>(arr)` (the
  type arguments are required, or take them from an annotated target — `const m: Map<K, V> = new
  Map()`; `new Map(entries)` needs tuples and is out of subset). Map methods: `set` (chainable),
  `get`, `has`, `delete`, `clear`, `keys()` → `K[]`, `values()` → `V[]`, `.size`. Set methods: `add`
  (chainable), `has`, `delete`, `clear`, `values()`/`keys()` → `T[]`, `.size`. Iterate a **Set**
  directly with `for…of`; iterate a Map via `for…of` over `.keys()`/`.values()`. `===`/`!==` are
  identity; `console.log` prints `Map(2) { 'a' => 1 }` / `Set(3) { 1, 2, 3 }` (Node format).
  **Subset divergences:** `Map.get` of a *missing* key returns the value type's default (no
  `undefined` — pair with `.has`; use `!` so `get` of a present key type-checks), a `NaN` number key
  won't match (operator-`==` semantics). **Deferred** (clean `tsnc:` errors): `forEach`
  (needs first-class functions), `entries`/`for…of` over a Map (need tuples), `JSON.stringify` of a
  Map/Set, and `new Map(entries)`.
- **Control flow:** `if` / `else`, `while`, `do…while`, `for (init; cond; update)`,
  **`for…of`** (over an array's elements, a string's characters, or a Set's elements), **`for…in`** (over the *keys* —
  array/string indices as strings, or an object/instance's field names), and **`switch` / `case` /
  `default`** (JS `===` matching with **fall-through**; `default` may sit anywhere). **`break` /
  `continue`** target the innermost loop/switch, or an enclosing **labeled** loop (`outer: for (…) {
  … break outer; }` — only loops may be labeled). `switch` and labeled break/continue compile the
  way a C compiler does internally — a single discriminant eval + `goto`s to generated labels — so
  fall-through, default-in-the-middle, and multi-level jumps are exact.
- **Exceptions:** **`throw`**, **`try` / `catch` / `finally`**. `throw` takes a **string** (the
  subset has no `Error` objects, and no `unknown`/union to type an arbitrary thrown value), and
  `throw new Error(msg)` is accepted as a synonym for throwing `msg`; the caught binding in
  `catch (e)` is bound as a **`string`**. `finally` is realized as an **RAII guard**, so it runs on
  *every* exit from the `try` — normal completion, an early `return`, or an exception unwinding
  through it — and therefore needs no `catch` (a `try`/`finally` with no `catch` is fine). **Deferred**
  (clean `tsnc:` errors): throwing a non-string, labeling a non-loop, and `return`/`throw`/escaping
  `break`/`continue` **inside** a `finally` body (it runs from a destructor, which must not unwind).
- **Functions:** top-level, typed params + return type, `return`, calls, `void`; recursion works.
  Params and returns may be **arrays and objects**, not just scalars. Every parameter passes **by
  value** — for arrays/objects/instances that's a `tsn_rc` copy (a refcount bump) that aliases
  the caller's value, so a callee mutation is visible to the caller (JS reference semantics);
  returns likewise hand back the shared reference.
- **Default, rest & destructuring parameters** (functions, methods, constructors, **and** closures):
  - **Default params** `(a: T = expr)` — resolved at the function's **entry**, so the default may
    reference earlier parameters (evaluated left to right); the parameter has its declared type `T`
    in the body (the default fills an omitted argument). At the boundary it's received as
    `T | undefined` under a hidden name and rebound to `T` (see codegen). Defaults may be any value
    (a call, a reference type, …); a **union-typed** default param is a clean error (deferred).
  - **Rest params** `(...xs: T[])` — the trailing call arguments are collected into a fresh `T[]`;
    the body uses `xs` as an ordinary array. Also valid in **function-type annotations**
    (`(...xs: T[]) => R`).
  - **Spread arguments** `f(1, ...xs, 2)` / `new C(...xs)` — splice an array into a call, but **only**
    into a rest parameter (spreading into a fixed parameter is a clean error — its length is unknown
    statically).
  - **Destructuring params** `({ x, y }: P)` / `([a, b]: T[])` — desugar to a synthetic parameter
    plus body bindings (same machinery as a destructuring `let`); rename / nesting / a whole-param
    default all work.
- **Destructuring & spread** (in `let`/`const`):
  - **Array** `const [a, , b, ...rest] = xs` — index per element, skip **holes** (`[, x]`), and an
    element **default** `[a = 5]` fills an out-of-bounds element (`i < xs.length ? xs[i] : 5`); a
    **rest** `...rest` takes `xs.slice(i)` (a new array).
  - **Object** `const { x, y: alias, p: { z } } = obj` — bind each field, with **rename** and
    **nesting**. (Object fields are always present in the subset, so a property default never fires.)
  - **Nesting** composes to any depth; the initializer is evaluated **once** (bound to a temp). A
    spread in an **array literal** `[...a, ...b, c]` builds a *fresh* array (so `[...a]` is a copy).
  - **Deferred** (clean `tsnc:` errors): **object rest** `{ ...rest }` (needs a residual-object
    build), **destructuring a `for…of`/`for…in` binding**, and a **destructuring assignment**
    (`[a, b] = xs` as a statement — only declarations destructure).
- **Closures & first-class functions:** **arrow functions** (`(x: T) => e` / `(x: T) => { … }`)
  and **anonymous function expressions** (`function (x: T) { … }`); **function-type annotations**
  `(a: T, b: U) => R` (incl. `() => void`) on variables, parameters, returns, fields, and array
  elements; and **function values** — store in a variable, pass as an argument (user-defined
  higher-order functions), return one, put one in an array/object, reference a top-level function by
  name as a value, and **call** one (`f(x)`, `getFn()(x)`, `fns[0](x)`, `obj.cb(x)`). A function value
  compiles to **`std::function<R(P…)>`** (number params/returns use the **f64 rep**, so a function
  value's C++ type is context-stable). **Closures capture by reference with full JS semantics:** a
  local captured by a nested closure is **boxed** in a heap cell (`tsn_rc<tsn_box<T>>`, see the
  capture pass [src/codegen/closures.ts](src/codegen/closures.ts)) that the enclosing scope and every
  closure over it share — so `makeAdder` (read-only capture), `makeCounter` (a closure mutating its
  own captured state), and two closures sharing one mutable variable all behave exactly like JS.
  Closure parameters need **type annotations** (lowering doesn't thread the checker's contextual
  types); the **return type is inferred** from the body (or taken from an explicit annotation). A
  captured **`for…of`/`for…in`** loop variable is re-boxed each iteration (correct `let`
  per-iteration capture); `typeof f === "function"`; `console.log(f)` prints `[Function (anonymous)]`.
  Closures also support **default / rest / destructuring parameters** (see _Default, rest &
  destructuring parameters_). **Deferred** (clean `tsnc:` errors): **async** arrow/function
  expressions, comparing function values with `===`/`!==`, `this` inside a closure (lexical-`this`
  capture), and `JSON.stringify` of a function. The callback array methods (`map`/`filter`/`reduce`/
  …), `Map`/`Set.forEach`, `new Promise(executor)`, and `Promise.reject`/`race` are now *unblocked*
  by closures but not yet implemented (still clean errors). A **C-style `for` counter** captured by a
  closure is a single shared cell (JS `var`-like — a documented divergence from per-iteration `let`).
- **Async / await:** **`async` functions and methods**, **`await`**, the **`Promise<T>`** type
  (a first-class value — storable, passable, returnable; `Promise<void>` too), and the static
  builtins **`Promise.resolve(x)`** and **`Promise.all(xs)`**. This is a **faithful event-loop**
  implementation, **not** synchronous erasure: an `async` function compiles to a **C++20
  coroutine** returning a real promise, `await` **suspends** and schedules its continuation on a
  **microtask queue**, and `main()` drains that queue after the synchronous top-level. There are
  no timers/IO in the subset, so the microtask queue *is* the whole event loop (no macrotasks;
  every promise settles via synchronous computation, so the drain terminates). Ordering matches
  Node/V8 **byte-for-byte** — including the one-tick deferral of code after an `await` (verified
  against Node in the e2e cases). **Rejection** rides the subset's string-only exception model: a
  `throw` inside an async function rejects its promise; `await`ing a rejected promise re-throws
  the string (caught by an ordinary `try`/`catch`, with `finally` still running). No closures are
  needed — the only continuations are internal coroutine handles, and `.then`/`new Promise(executor)`
  aren't in the subset. **Top-level `await`** is supported in the **entry** module (which, as TS
  requires for top-level await, must be a module — have an `import`/`export`): the entry's whole
  top-level becomes a `tsn_top_level()` coroutine that `main()` starts and then drains. **Subset
  divergence:** `await` may not appear inside a non-boolean `&&`/`||` operand or `Array.fill`'s index
  args (those lower to a C++ lambda body, where `co_await` can't go) — assign the awaited value to a
  variable first (a clean `tsnc:` error). **Deferred** (clean `tsnc:` errors): `new Promise(executor)`
  and `Promise.reject`/`race`/`any`/`allSettled` (need closures / a richer model), top-level `await`
  in an **imported** module (would make the whole module graph async), and `for await` (no async
  iterables).
- **`fetch(url)`** — a real, `await`-able HTTP(S) GET returning `Promise<Response>`, the same code
  you'd write in TypeScript: `const res = await fetch(url); const data = await res.json() as T`.
  `Response` is a built-in reference type with `status: number`, `ok: boolean`, and methods
  `text(): Promise<string>` / `json(): Promise<T>`. The microtask runtime has **no async I/O**, so
  `fetch` does a **blocking** libcurl request and returns an already-settled promise (`await` still
  defers one tick, so JS ordering holds); it's the one I/O builtin and the natural payoff of async.
  A **transport error** (DNS/refused/timeout) **rejects** the promise — `await` throws a string,
  catchable with `try`/`catch`; an **HTTP error status** (404/500) is *not* a failure — it resolves
  with `ok === false`, matching real `fetch`. `Response.json()` is `Promise<any>` and the subset has
  no `any`, so the target type is required (idiomatic TS): `await res.json() as T` or an annotated
  target — reusing the typed-`JSON.parse` extraction (so `JSON.parse(await res.text()) as T` works
  too). Compiling a `fetch` program links `-lcurl` (only then — a non-fetch binary is unchanged).
  **Deferred** (clean errors): request options / non-GET methods, headers, and `res.headers` /
  `blob()` / `statusText` (request options need optional object fields, blocked on unions).
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
| `T[]`     | `tsn_rc<std::vector<T>>` | **reference** type: heap vector behind a non-atomic ref-counted pointer (`tsn_rc`), shared on copy/assign (aliasing, shared mutation, identity `===`); `.length` → `->size()`, index `(*a)[i]`, methods → `tsn_*` helpers on `*a` |
| `{ ... }` | `tsn_rc<struct>` | **reference** type: heap struct (one per distinct field shape), shared on copy/assign; field access `obj->f`                                       |
| class `C` | `tsn_rc<C>`    | **reference** type: `new C()` is heap + ref-counted; copy/assign aliases (shared mutation, identity via `==`); `struct C { fields; ctor; methods; }` |
| `Map<K, V>` | `tsn_rc<tsn_map<K, V>>` | **reference** type: insertion-ordered `tsn_map` (runtime), shared on copy/assign; methods via `->`; `.size` → `->size()` (i64). Keys/values use the f64 rep |
| `Set<T>` | `tsn_rc<tsn_set<T>>` | **reference** type: insertion-ordered `tsn_set`; iterable by `for…of`; methods via `->`; `.size` (i64) |
| `Promise<T>` | `tsn_promise<T>` (a C++20 coroutine type) | **reference** type: a handle holding a `std::shared_ptr` to shared promise state (the one aggregate still on `shared_ptr` — not a hot path). An `async` function returns one (its body is a coroutine using `co_return`/`co_await`); `await` is `co_await`. `Promise<void>` → `tsn_promise<tsn_unit>`. Resolved numbers use the f64 rep |
| `Response` | `tsn_rc<tsn_response>` | **reference** type: the `fetch(...)` result (runtime `tsn_response { status; ok; body }`). Fields `status` (f64) / `ok` (bool); `text()` → `Promise<string>`, `json()` → `Promise<T>`. `tsn_fetch` (libcurl) is `#ifdef TSN_ENABLE_FETCH`; using it links `-lcurl` |
| `null` / `undefined` | `tsn_null` / `tsn_undefined` | empty tag structs (one value each), distinct types so a union variant discriminates them and `typeof` differs (`typeof null === "object"`); mostly a union member / the optional-`?:` desugar |
| `A \| B \| …` (union) | `tsn_union<M0, M1, …>` | a `std::variant` **wrapper** (so ADL finds our overloads for an all-scalar union). Members canonical + rep-stable (`undefined`/`null` first → the default alternative). A member **widens** in via `std::in_place_type` (`coerceTo`); a narrower union widens via `tsn_union_widen`. `===` is holds-and-equals; **narrowing** (`typeof`/`=== null`/truthiness/`&&`) reads a member via `std::get<Member>`. Number members are f64 |
| `(P…) => R` (function) | `std::function<Rc(Pc…)>` | **reference** type: a first-class function value (arrow / function expression / top-level-function reference). Number params/returns use the **f64 rep** (context-stable signature). A **captured local** is **boxed** (`tsn_rc<tsn_box<T>>`) so closures share its one cell (full JS capture). Call via `(f)(args)`; `typeof` is `"function"`; `===`/`json` unsupported (clean errors) |

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
- **Arrays/objects are reference types (`tsn_rc`), matching JS.** `let b = a` aliases the
  same heap value, so `b.push(v)` / `b[i] = e` / `b.f = e` is visible through `a`; `===`/`!==`
  compare pointer identity (two distinct literals with equal contents are `!==`); and a function
  can mutate an array/object parameter — the mutation is visible to the caller. They compile to
  **`tsn_rc<…>`, a non-atomic ref-counted pointer** (like `tsn_str`), *not* `std::shared_ptr`:
  generated programs are single-threaded, so `shared_ptr`'s atomic refcount is pure overhead — and
  it **dominated** object/array-shuffling hot loops (every `a[j+1] = a[j]` swap was an atomic
  inc/dec). Switching to a plain-`long` refcount made that copy as cheap as a value move: the
  object-heavy leaderboard benchmark went from ~7.5× slower than hand-written C++ to ~1.2× (a ~6×
  speedup), with no change to JS semantics. The remaining cost is one pointer indirection per
  element/field access (`(*a)[i]`, `obj->f`); `clang -O3` hoists the invariant pointer out of hot
  loops, so the integer benchmark (no arrays) is unaffected and the string word-sort (its swaps
  copy `tsn_str`, already non-atomic) stays ~parity with V8. This reference-typed model replaces an
  earlier value-typed one (`std::vector`/`struct` by value, `const&` read-only params) — a
  deliberate divergence from JS that reference-typing removed.
- **Function boundaries:** params and returns may be arrays/objects. Every parameter passes **by
  value**; for a reference type (array/object/instance) that's a `tsn_rc` copy — a refcount
  bump that aliases the caller's value, so callee mutations are visible to the caller (JS
  semantics). Returns hand back the shared reference the same way (a `tsn_rc`, not a deep copy).
- **Aggregates nest:** object fields and array elements may themselves be aggregates —
  `{ pts: number[] }`, `{ inner: { x: number } }`, `number[][]`, `{ x: number }[]`. These map to
  C++ as nested reference types (`tsn_rc<std::vector<tsn_rc<std::vector<double>>>>`,
  a struct whose members are `tsn_rc`s), and `lowerType` / struct generation recurse through the
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
| `any`                | `let x: any`                  | Would erase the static type codegen relies on.        |
| `unknown` / `never`  | `let x: unknown`              | Same reason as `any`.                                 |
| Tuple                | `[number, string]`            | Only homogeneous `T[]` arrays are supported.          |
| Literal / enum       | `"a" \| "b"`, `enum E {}`     | No literal types or enums (a union of *types* is fine — see _Union types & narrowing_). |
| Intersection         | `A & B`                       | No type composition.                                  |
| Generic / type param | `<T>(x: T) => T`, `Box<T>`     | Only built-in `Array<T>` / `Map<K, V>` / `Set<T>` / `Promise<T>` are special-cased; user generics aren't. |

`null` / `undefined`, **union types** (`number | string`, `T | null`), and **function types**
(`(x: number) => number` — see _Closures & first-class functions_) **are** supported now. Optional
**parameters** (`a?: T`) work; optional object **fields** (`{ x?: T }`) are still rejected (clean
error — they need object-literal field-defaulting).

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
- Apple **clang++ 17.0.0** at `/usr/bin/clang++`; we compile with `-std=c++20` (was `-std=c++17`;
  bumped for coroutines, which back async/await — clang 17 supports them with no extra flag). A
  program that uses async therefore needs `-std=c++20` to recompile by hand (`clang++ -std=c++20
  file.cpp`); a non-async program still builds with the default standard.
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

- [x] **Closures + first-class functions** — arrow functions (`(x: T) => e` / `(x: T) => { … }`),
      anonymous function expressions, function-type annotations (`(a: T, b: U) => R`, `() => void`),
      and function VALUES: storable / passable (user-defined higher-order functions) / returnable / in
      arrays & objects / a top-level function referenced by name, and callable in every position
      (`f(x)`, `getFn()(x)`, `fns[0](x)`, `obj.cb(x)`). A function value compiles to
      **`std::function<R(P…)>`** (number params/returns forced to the **f64 rep** so the C++ type is
      context-stable — `repr.ts` demotes a function referenced as a value, and closure params/returns,
      to f64). The headline decision was **capture fidelity**: rather than by-value `[=]` snapshots
      (which silently diverge when closures share a mutable variable), a **capture pass**
      ([src/codegen/closures.ts](src/codegen/closures.ts)) marks every local captured by a nested
      closure as **boxed** — stored in a heap cell `tsn_rc<tsn_box<T>>` that the enclosing scope and
      all its closures share through `->v`, with the C++ lambda's `[=]` copying the (shared) cell
      pointer. So `makeAdder` (read-only capture), `makeCounter` (a closure mutating its own captured
      counter, persisting across calls), two closures sharing one mutable variable, and a
      mutation-after-capture all match JS exactly. A captured **`for…of`/`for…in`** variable is
      re-boxed per iteration (correct `let` capture); a captured **C-style `for` counter** is one
      shared cell (JS `var`-like — a documented divergence). Closure **parameters need annotations**
      (lowering doesn't thread the checker's contextual types — so `arr.map(x => …)` needs
      `(x: number) => …`); the **return type is inferred** from the body (unified like a ternary) or
      taken from an annotation. Threaded across the usual files: a `function` `Type`, a `closure` +
      `callValue` `Expr`, `boxed` flags on binding nodes, the capture pass + closure-id assignment
      (run before `repr`/`emit`), `lower` (arrows/function-exprs/function-types/value-calls/
      function-refs), `repr.ts` (boxed-and-closure slots are f64), the module `Renamer`, the runtime
      (`tsn_box` + `std::function` overloads for `tsn_inspect`/`tsn_truthy`/`tsn_typeof`), and
      `emit.ts` (closure emission with full per-function state save/restore, boxing of params/lets/
      loop-vars/catch-bindings, value calls, function-field calls). Non-closure programs are
      byte-identical. Closures support default / rest / destructuring **parameters** (see the
      _Destructuring + spread/rest + default/rest params_ Done item). **Deferred** (clean `tsnc:`
      errors): async arrow/function expressions, `this` inside a closure, function `===`/`!==`, and
      `JSON.stringify` of a function. Tests: `tests/cases/closure-*.ts`, `function-{value,expr,typeof,log}.ts`,
      `class-fn-field.ts` + [tests/closures.test.ts](tests/closures.test.ts) (rejections).
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
      checks cross-module types — see _Modules_). All e2e cases type-check clean under these
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
- [x] **`JSON.parse` / `JSON.stringify`** — both builtins, matching Node byte-for-byte on the subset
      (cross-checked against `node` in the e2e cases). The interesting half was **typing
      `JSON.parse`**: it's `any` in TypeScript, which the statically-typed subset can't represent, so
      the **target type is required up front** — `JSON.parse(text) as T` (a new, narrowly-scoped
      `as`-expression branch in [src/frontend/lower.ts](src/frontend/lower.ts), accepted *only* on a
      `JSON.parse` call) or an annotated target (`const x: T = JSON.parse(text)`, handled in
      `lowerVarDecl`). `T` is any JSON value type (scalars / arrays / objects, nested); a class target
      is a clean `tsnc:` error (no prototype to rebuild). Two new IR nodes (`jsonStringify`,
      `jsonParse { text, type }`); both are threaded through `repr.ts` (a parsed `number` is always
      f64 — JSON numbers parse to doubles) and the module `Renamer` (so a `JSON.*` call on a module
      variable still resolves). The **runtime** ([src/codegen/cpp/tsn_runtime.h](src/codegen/cpp/tsn_runtime.h))
      gained a generic `tsn_json` tagged-union value + a recursive-descent `tsn_json_parse` (full JSON
      grammar incl. `\uXXXX` + surrogate pairs), scalar `tsn_json_as_*` accessors, and the
      `tsn_json_stringify` scalar overloads + array template. **Codegen**: `stringify` mirrors the
      `tsn_inspect` split exactly (generated per-object/class overloads + forward decls, array elements
      resolved by ADL), but emits JSON (double-quoted keys, no spaces, `null` for `NaN`/`Infinity`, no
      class name). `parse` emits a recursive **extraction expression** — scalars via the accessors,
      arrays/objects via inline immediately-invoked lambdas (no per-type helpers/forward-decls needed:
      a JSON value type is a finite tree, the subset has no recursive/aliased types). No exceptions in
      the subset, so malformed JSON or a value that doesn't match `T` prints to stderr and exits
      non-zero (`tsn_json_fail`) — the closest analog to an uncaught `SyntaxError`. **Deferred** (clean
      errors): `stringify`'s `replacer`/`space` args, `parse`'s `reviver` arg, and class targets.
- [x] **Ternary `? :`** — the conditional expression, lowering to the C++ `?:`. The textbook
      ~3-touch feature: one IR node (`ternary { cond, whenTrue, whenFalse }`), one `lower` branch
      (`ts.isConditionalExpression`), one `emit` case. The condition reuses the existing `condition()`
      helper (number/boolean, like `if`/`while`); the two branches must **share a type** — that's the
      result type (no union in the subset; a mismatch is a clean `tsnc:` error, so `cond ? xs : (a === b)`
      with `number[]`/`boolean` branches is rejected rather than miscompiled). Reference-typed branches
      (arrays/objects/instances → `shared_ptr`, strings → `tsn_str`) work because C++'s `?:` has a common
      type for matching branches. For a **number** result the rep follows both branches via `combineRep`
      (i64 only when both are; a mixed i64/f64 pair is promoted to `double` by C++, matching the f64 rep).
      Also threaded through `repr.ts` (same `combineRep` rule) and the module `Renamer` (rewrites all
      three sub-expressions). Nested ternaries fall out for free (the false branch is just another `Expr`).
- [x] **Template-literal interpolation** — `` `a${x}b` ``. Even cheaper than the 3-touch pattern: a
      pure **desugar in lowering**, with *no* IR node, `emit` case, `repr.ts`, or `Renamer` change. A
      `ts.TemplateExpression` lowers to a left-folded chain of `+`-concatenations
      (`head + e0 + mid + e1 + tail`), so it rides the existing string-concat machinery end-to-end —
      including `repr.ts` and the module `Renamer`, which already handle `binary` nodes. The `head` (a
      `str`, possibly empty) **anchors the chain to `string`**, so a lone `` `${n}` `` of a number is
      still a string; empty middle/tail quasis are dropped so the emitted C++ has no redundant `+ ""`.
      Interpolated values coerce exactly as `+` does (string and number operands) — anything else is the
      same clean "Cannot concatenate" error, not a new code path. ([src/frontend/lower.ts](src/frontend/lower.ts);
      no-substitution `` `...` `` literals already lowered as plain strings.)
- [x] **Control flow — `do…while`, `for…of`, `for…in`, `switch`, `break`/`continue`, labeled loops,
      `try`/`catch`/`finally`/`throw`** — the rest of JS's statement-level control flow, in one pass.
      Nine new `Stmt` nodes ([src/ir/nodes.ts](src/ir/nodes.ts)) threaded through `lower` → `emit` →
      `repr.ts` → the module `Renamer`. Highlights:
      - **`for…of`** (arrays/strings) and **`for…in`** (keys) are real IR nodes (not a lowering desugar)
        so `emit` can scope their temporaries in `{ }` and resolve the element/key type — which lowering
        doesn't have. `for…of`'s number loop var is forced **f64** in `repr.ts` (array elements/string
        chars are stored as `double`), keeping the rep sound. Both compile to an index loop over a
        once-evaluated temp.
      - **`switch`** and **labeled `break`/`continue`** are compiled the way a C compiler lowers them
        internally — a single discriminant eval (or loop) + **`goto`s to generated labels** — so JS
        `===` matching, **fall-through**, **`default` in the middle**, and **multi-level** jumps are all
        exact. The emitter carries a `breakStack` of `BreakCtx`: an unlabeled loop is *native*
        (`break;`/`continue;`); a **labeled** loop or any `switch` is *goto-form* (a labeled `for` moves
        its update after the continue label so `continue` still runs it). Each `switch` clause body is
        its own `{ }` block so the forward dispatch `goto`s never bypass a clause-local's initialization.
      - **`try`/`catch`/`finally`/`throw`** picks a small exception model: `throw` takes a **string**
        (`throw new Error(msg)` lowers to throwing `msg`), `catch (e)` binds `e` as a **string** (no
        `Error` objects / no `unknown`/union to type a general value). `finally` is a C++ **RAII guard**
        (`tsn_make_finally`, the one runtime addition), so it runs on normal exit, `return`, *and*
        exception unwind — meaning a `finally` needs **no** C++ `try` (only a `catch` does). Escaping
        control flow inside a `finally` (`return`/`throw`/`break`/`continue`) is rejected, since the body
        runs from a destructor. The `-Werror=return-type` build survives `return`-in-every-`case`
        switches (clang proves the `goto` dispatch never falls through), and clang's only gripe is a
        harmless `-Wparentheses-equality` (the pre-existing fully-parenthesized `(a == b)` style).
- [x] **`Math.*`, `Map` / `Set`, broader string/array methods** — the stdlib-breadth item, in one
      pass across all four files (`lower` → `repr.ts` → `emit` → the runtime header) plus the module
      `Renamer`. Three parts:
      - **`Math.*`** — functions (`floor`/`ceil`/`round`/`trunc`/`sign`/`abs`/`sqrt`/`cbrt`/`exp`/
        `log`/`log2`/`log10`/trig + `pow`/`atan2`/variadic `min`/`max`/`hypot`/`random`) and constants
        (`PI`/`E`/`LN2`/…). Recognized as builtins in lowering exactly like `JSON.*` (two IR nodes:
        `mathCall`, `mathConst`); the result is always a `number` in the **f64 rep**, so `repr.ts`
        stays simple. Most map straight to `<cmath>`; the JS-divergent ones use a small `tsn_math_*`
        helper (`round` half-to-+∞, NaN-propagating `min`/`max`, `sign`, `random`). Constants emit as
        exact double literals (byte-for-byte with Node — no `M_PI` dependency).
      - **Broader string/array methods** — purely additive (no IR/lower change — they were already
        `methodCall`s): string `includes`/`startsWith`/`endsWith`/`lastIndexOf`/`repeat`/`trim`(`Start`/
        `End`)/`padStart`/`padEnd`/`replace`/`replaceAll`/`concat`, and array `includes`/`lastIndexOf`/
        `reverse`/`fill`/`concat`/`shift`/`unshift`. New `tsn_*` runtime helpers + dispatch cases +
        `repr.ts` return types. The callback-based methods (`map`/`filter`/`reduce`/`forEach`/`sort`)
        stay out — they need first-class functions. (Bumped the stage-0 lib ES2020→ES2021 just for
        `String.prototype.replaceAll`; still no DOM.)
      - **`Map<K, V>` / `Set<T>`** — the keystone-ish part. Two new `Type` variants (`map`/`set`) +
        two `Expr` nodes (`mapNew`/`setNew`), threaded everywhere a `Type`/`Expr` is switched on
        (`cppType`/`sameType`/`displayType`, the `Renamer.type`, `repr.ts`). They're **reference
        types** (`std::shared_ptr<tsn_map/tsn_set>`), so aliasing / shared mutation / identity `===`
        fall out exactly like arrays. The runtime `tsn_map`/`tsn_set` are insertion-ordered with
        linear lookup by `operator==` (clarity over a hashed structure — matches JS SameValueZero for
        the common cases). The interesting constraint was that **`Map.get` is `V | undefined`** in TS,
        which the no-union/no-`undefined` subset can't represent: get returns `V` and yields the value
        type's **default** on a miss (the user opted into this divergence), and a transparent
        **non-null assertion `!`** (lowered as identity — no runtime effect) lets `map.get(k)!`
        type-check. `console.log` matches Node (`Map(2) { 'a' => 1 }` / `Set(3) { 1, 2, 3 }`); `for…of`
        iterates a Set directly (a Map iterates entries = tuples → clean error; use `.keys()`/
        `.values()`, which return arrays). Deferred (clean `tsnc:` errors): `forEach` (no closures),
        `entries`/`for…of`-over-Map (no tuples), `JSON.stringify` of a Map/Set, `new Map(entries)`.
- [x] **Async / await (faithful event loop)** — `async` functions/methods, `await`, the `Promise<T>`
      type (a first-class value, incl. `Promise<void>`), and `Promise.resolve`/`Promise.all`. The
      design decision was **faithful vs. synchronous-erasure**, and this is the **faithful** one: an
      `async` function compiles to a **C++20 coroutine** returning a real `tsn_promise<T>` (`return`
      → `co_return`, `await` → `co_await`), `await` **suspends** and schedules its continuation on a
      **microtask queue**, and `main()` drains that queue after the synchronous top-level. The key
      realization that made it tractable *without* closures: C++20 coroutines provide the suspension
      natively, the subset has no timers/IO (so the microtask queue is the *entire* event loop — no
      macrotasks, and the drain provably terminates since every promise settles synchronously), and
      the subset exposes no `.then`/`new Promise(executor)` (so the only continuations are internal
      coroutine handles, never user closures). Ordering matches Node/V8 **byte-for-byte** — verified
      against `node` in the e2e cases — including the famous one-tick deferral (`await_ready` is
      always false; `initial_suspend`/`final_suspend` are `suspend_never`; settling a promise
      schedules its waiters as microtasks). **Rejection** reuses the string-only `throw` model:
      `unhandled_exception` rejects the promise, `await_resume` re-throws the `tsn_str` (caught by an
      ordinary `try`/`catch`, `finally` still runs via the RAII guard — works across a `co_await`).
      Threaded across all the usual files: a new `Type` (`{ kind: "promise"; value? }`), three `Expr`
      nodes (`await`, `promiseResolve`, `promiseAll`), an `async` flag on `Func`/`Method`, plus
      `repr.ts` (awaited/promise values are f64), the module `Renamer`, and the runtime
      ([src/codegen/cpp/tsn_runtime.h](src/codegen/cpp/tsn_runtime.h): the microtask queue,
      `tsn_promise`/`tsn_promise_state`, `tsn_unit`, `tsn_resolve`, `tsn_all`, and a promise
      `tsn_inspect`). The backend bumped `-std=c++17` → `-std=c++20`. Non-async programs are
      byte-identical (the microtask drain is gated on a module actually using async). **Subset
      divergence:** `await` can't appear inside a non-boolean `&&`/`||` operand or `Array.fill`'s index
      args (they lower to a C++ lambda body, where `co_await` is illegal) — a clean `tsnc:` error asks
      you to bind the awaited value first. **Top-level `await`** is supported in the **entry** module
      (TS requires the entry be a module): its whole top-level is emitted as a `tsn_top_level()`
      coroutine that `main()` starts and then drains (gated on the top-level actually containing an
      `await`, so non-TLA programs stay byte-identical; promoted globals stay file-scope, assigned
      inside the coroutine). **Deferred** (clean `tsnc:` errors): `new Promise(executor)`,
      `Promise.reject`/`race`/`any`/`allSettled` (closures / richer model), top-level `await` in an
      **imported** module (would make the whole module graph async), and `for await` (no async iterables).
- [x] **`fetch` (real, `await`-able HTTP)** — `fetch(url): Promise<Response>`, the genuine idiom:
      `const res = await fetch(url); if (res.ok) { const data = await res.json() as T }`. The design
      decision the async work set up: the microtask runtime has **no async I/O**, so `fetch` does a
      **blocking** libcurl GET and returns an *already-settled* promise (`tsn_fetch` → `tsn_resolve`/
      `tsn_reject`) — `await_ready` is still false, so `await fetch(url)` defers one tick and JS
      ordering holds. A **transport error rejects** (so `await` throws a catchable string — the user's
      choice over hard-exit, and now possible since async exists), while an **HTTP error status
      resolves** with `ok === false` (real-fetch semantics). `Response` is a built-in reference type
      (`isResponse`, like Map/Set): `status`/`ok` fields + `text(): Promise<string>` / `json():
      Promise<T>`. The one real constraint was **typing `json()`** — it's `Promise<any>`, which the
      no-`any` subset can't hold, so the target type is captured up front (idiomatic TS): a new
      `as`-expression form `await res.json() as T` (and `const x: T = await res.json()`) lowers to a
      `responseJson { receiver, type }` node that **reuses the typed-`JSON.parse` extraction**
      (`extractJson`) — so `JSON.parse(await res.text()) as T` works identically. Threaded across the
      usual files: a `Type` (`{ kind: "response" }`), two `Expr` nodes (`fetch`, `responseJson`),
      `lowerType`/`tryLowerFetchCall`/the `as`-branch, `repr.ts`, the module `Renamer`, and the runtime
      ([src/codegen/cpp/tsn_runtime.h](src/codegen/cpp/tsn_runtime.h): `tsn_response`, a guarded
      `tsn_fetch`, `tsn_reject`, a Response `tsn_inspect`). A program that uses fetch emits `#define
      TSN_ENABLE_FETCH` (gating the curl include) and the driver links `-lcurl` (threaded out of
      `emit(mod) → { cpp, usesFetch }`, parallel to the `usesAsync` gate); **non-fetch programs are
      byte-identical and link without curl**. Network-hermetic tests (localhost server, ephemeral port)
      live in [tests/fetch.test.ts](tests/fetch.test.ts), not a `cases/*` pair. **Deferred** (clean
      `tsnc:` errors): request options / non-GET (`fetch(url, {…})` — needs optional object fields,
      blocked on unions), `res.headers`/`blob()`/`statusText`, and a bare `res.json()` with no target.
- [x] **Non-atomic ref-counting for aggregates (`tsn_rc`)** — a runtime-only perf fix that removed a
      latent ~7× slowdown on object/array-heavy code. Arrays/objects/class-instances/Map/Set/Response
      were represented as **`std::shared_ptr`**, whose refcount is **atomic** on macOS libc++ (always —
      no single-threaded fast path). In an O(n²) insertion sort over an object array, every
      `players[j+1] = players[j]` swap is a `shared_ptr` copy = an atomic inc/dec; a microbench isolated
      the cost (N=40k: `shared_ptr` 5.58s, value `std::vector<Player>` 0.77s, raw `Player*` 0.36s — so
      **~93% of the time was the atomic refcount**, not indirection). `tsn_str` *already* used a plain
      (non-atomic) `long` refcount ("generated programs are single-threaded"), so the string word-sort
      was fine (~3%) — but that invariant was never applied to the `shared_ptr`-based aggregates, and the
      "~3%" figure was measured only on strings. The fix adds **`tsn_rc<T>`** to the runtime — a
      drop-in, non-atomic, control-block ref-counted pointer (`operator->`/`*`/`bool`, identity
      `==`/`!=`, `tsn_make_rc` mirroring `make_shared`) — and `cppType` + every `make_shared` site +
      the per-type `tsn_inspect`/`tsn_json_stringify` overloads now emit `tsn_rc`/`tsn_make_rc` for all
      six aggregate reference types (Promise's *internal* state stays `std::shared_ptr` — not hot). No
      semantics change (aliasing, shared mutation, `===` identity all hold) and all 143 tests stay green;
      the object-heavy leaderboard benchmark dropped **~6×** (tsnc/cpp 7.55× → 1.24×, now ~parity with
      hand-written C++ and HotSpot C2), while the integer (primes) and string (word-sort) benchmarks are
      unchanged. See `tsn_rc` in [src/codegen/cpp/tsn_runtime.h](src/codegen/cpp/tsn_runtime.h).
- [x] **Union types (the keystone) + `typeof` narrowing + `null`/`undefined` + optional params** —
      `A | B | …` (e.g. `number | string`, `T | null`, `T | undefined`), represented in C++ as a
      **`tsn_union<…>`** (a `std::variant` wrapper, so ADL finds our overloads even for an all-scalar
      union); `null`/`undefined` are empty tag structs (`tsn_null`/`tsn_undefined`). The keystone
      decisions: (1) **canonicalization** in lowering (flatten/dedupe/collapse/stable-sort) so
      `number | string` ≡ `string | number` — and `cppType` re-sorts the C++ alternatives by their
      *final* (post-rename) type text, with `undefined`/`null` first, so the type identity is
      rename-stable *and* the variant's default alternative is the JS-correct `Map.get`-miss value;
      (2) **assignability vs. equality split** — `isAssignable` (member→union and narrower→wider
      widening, top-level only) drives a `coerceTo` that constructs the variant with explicit
      `std::in_place_type` (dodging `std::variant`'s `double`-vs-`bool` ctor ambiguity) and
      `tsn_union_widen` for union→union; equality is a separate `holds-and-equals` form; (3)
      **flow narrowing done in the emitter** (no checker threading — stage 0 already proved the
      program correct, so the emitted `std::get<Member>` is sound): `analyzeGuard` recognizes
      `typeof x === "…"`, `x === null`/`undefined`, bare truthiness, and boolean-`&&` chains in
      `if`/`else`/ternary, plus **early-return** narrowing (`if (x === null) return; …` narrows the
      fallthrough via an `emitBlock` snapshot/restore of the narrowing map); reassignment drops the
      narrowing. Threaded through all the usual files: two `Type` scalars + a `union` variant, three
      `Expr` nodes (`null`/`undefined`/`typeof`), `lower` (+ `canonicalizeUnion`), `repr.ts` (unions
      are never i64), the module `Renamer`, `emit.ts`, and the runtime (`tsn_null`/`tsn_undefined`/
      `tsn_union`/`tsn_union_widen` + `tsn_inspect`/`tsn_json_stringify`/`tsn_truthy`/`tsn_typeof`/
      `tsn_console_union` overloads via `std::visit`). `typeof e` is also a first-class `string`
      (runtime for a union, static otherwise). **Optional parameters** `(a?: T)` desugar to
      `T | undefined` (an omitted trailing arg defaults to `undefined`). Stage 0 (real TS) needs no
      change — it already understands unions/narrowing — so the work is all lower→repr→emit→runtime;
      non-union programs are byte-identical. Tests: `tests/cases/union-{basic,pass,narrow,typeof,
      narrow-object,optional,widen}.ts` + [tests/union.test.ts](tests/union.test.ts) (rejections).
      **Deferred** (clean `tsnc:` errors / follow-ups): optional object **fields** (`{ x?: T }` —
      need object-literal field-defaulting + nested coercion), a **ternary** whose branches have
      *different* types (union-merge), and union-typed **array/Map/Set element** coercion.

### todo

Ordering is a rough dependency chain: cheap self-contained syntax first → the **union-types
keystone** (which unlocks `null`/optional/literals) → closures → generics. **Every item still
ships with a `tests/cases/*.ts` + `.expected` pair** (red → green), except programs that must be
*rejected* ([tests/typecheck.test.ts](tests/typecheck.test.ts) / [tests/modules.test.ts](tests/modules.test.ts))
or that need a live server (`fetch`, in [tests/fetch.test.ts](tests/fetch.test.ts)).

**Cheap, self-contained syntax** (each is ~one IR node + one `lower` branch + one `emit` case):

- [ ] **Bitwise `& | ^ ~ << >> >>>` and exponentiation `**`** — today: `Unsupported binary operator`.
- [ ] **`console.log` with multiple args** — currently exactly one ([src/frontend/lower.ts](src/frontend/lower.ts)).

**Control flow** — the statement-level control flow is now complete (`if`/`else`, `while`,
`do…while`, C-style `for`, `for…of`/`for…in`, `switch`, `break`/`continue` + labeled loops,
`try`/`catch`/`finally`/`throw`; see _Done_). Still open at the statement level: only the rarely
needed **`for await`** (needs async iterables / `Symbol.asyncIterator` — `await`/`async` themselves
shipped, see _Done_) and **labeling a non-loop** (a block/labeled-block representation) — both
currently clean `tsnc:` errors.

**Builtins / stdlib** — `Math.*`, `Map`/`Set`, and broader (non-callback) string/array methods are
done (see _Done_). Still open:

- [ ] **Callback array methods** — `map` / `filter` / `reduce` / `forEach` / `some` / `every` /
      `sort`(comparator) / `find` / `findIndex`. **Now unblocked** — closures / first-class functions
      shipped (see _Done_) — but not yet implemented (each is still a clean "unsupported array method"
      error). `Map.forEach` / `Set.forEach` and `new Promise(executor)` / `Promise.reject`/`race` are
      likewise unblocked by closures and still to do.

### Blocked on the type system

The **union-types keystone is now done** (`tsn_union` + `typeof` narrowing + `null`/`undefined`;
see _Done_), which unblocks most of what was here. Still open:

- [x] **Union types** — done (`A | B`, canonical `tsn_union<…>`; see _Done_).
- [~] **`null` / `undefined` + optional `?:`** — `null`/`undefined` types + optional **parameters**
      done; optional object **fields** (`{ x?: T }`) deferred (need object-literal field-defaulting).
- [ ] **Enums & literal types**, **tuples** (`[number, string]`), **intersection** (`A & B`).
- [ ] **Union polish** — a **ternary** with differing branch types (union-merge result) and
      **union-typed array/Map/Set element** coercion (`(number | string)[]` push/index) — both
      currently clean `tsnc:` errors / structural-match-only (top-level widening only today).
- [ ] **Thread the `TypeChecker`'s inferred types into lowering** — stage 0 is a *gate* only;
      lowering re-reads annotations off the AST and can't see inferred types
      ([src/frontend/check.ts](src/frontend/check.ts)). Narrowing is currently reproduced in the
      emitter (`analyzeGuard`); threading would let it follow TS's inference exactly.

### Later

- [ ] **Classes — beyond the basic shape** — the basic shape is done (see above). Still to come:
      `extends` / inheritance (base-struct layout + virtual dispatch + `super(...)`), enforcing
      `private`/`public`/`protected`/`readonly` visibility, `static` members, get/set accessors,
      parameter properties, and field initializers (default member init). (Bare `this` as a value is
      **out of scope** — see _will never support_.)
- [x] **Closures + first-class functions** — done (arrows / function expressions / function-typed
      values / boxed capture machinery; see _Done_). Default / rest / destructuring **parameters** on
      closures are done too (see _Destructuring + spread/rest + default/rest params_). Still open as
      follow-ups: **async arrow/function expressions** (clean error today), and the callback array
      methods / `new Promise(executor)` / `Promise.reject`/`race` that closures unblock (see _todo_).
- [x] **Destructuring + spread/rest + default/rest params** — done. **Default params** `(a: T = expr)`
      and **rest params** `(...xs: T[])` on functions / methods / constructors / closures (rest also in
      function-type annotations); **spread arguments** `f(...xs)` / `new C(...xs)` into a rest param;
      **spread in array literals** `[...a, ...b, c]` (a fresh copy); and **array / object destructuring**
      in `let`/`const` and **parameter** position (rename, holes, element defaults, array rest, and
      nesting). Two implementation strategies: destructuring + parameter spread are **desugared in
      lowering** ([src/frontend/lower.ts](src/frontend/lower.ts)) into the source temp + per-binding
      `let`s / synthetic params (so the rest of the pipeline only ever sees simple bindings and array
      literals), needing no IR/emit change beyond a `spread` element node; default/rest params are
      handled in **codegen** — `checkArgs` works over normalized `CallSlot`s (rest collection + spread
      splicing + optional/default tail-fill), and a default param is received as `T | undefined` at the
      boundary and rebound to `T` at function entry (so the default may reference earlier params). The
      `spread` `Expr`, `default`/`rest` on `Param`, and `restParam` on the function `Type` were threaded
      through lower → repr → closures → the module `Renamer` → emit. **Deferred** (clean `tsnc:` errors):
      object rest `{ ...rest }` (residual-object build), destructuring a `for…of`/`for…in` binding, a
      destructuring assignment statement (`[a, b] = xs` — only declarations destructure), a destructured
      rest param (`...[a, b]`), and a default on a union-typed parameter. Tests:
      `tests/cases/{spread-array,rest-params,default-params,destructure-var,destructure-params}.ts` +
      [tests/destructure.test.ts](tests/destructure.test.ts) (rejections).
- [ ] **Generics / type parameters** — `<T>(x: T) => T`, `Map<K, V>`; depends on the type-system work above.
- [ ] **`typeof` / `instanceof` / `in`**, **optional chaining `?.` / nullish `??`**.

### Deferred module forms (clean `tsnc:` errors today)

- [ ] `export default` / default imports, `import * as` namespace imports, import aliasing
      (`{ a as b }`), re-export statements, non-relative (package) specifiers, and circular imports.
      See [src/frontend/modules.ts](src/frontend/modules.ts).

## will never support

- class bare `this` as a value ( `let b = this` / passing `this` around works)
- typescript any type
