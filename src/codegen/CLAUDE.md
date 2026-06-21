# src/codegen/ — C++ emission (stage 3)

[emit.ts](emit.ts) lowers the IR ([../ir/nodes.ts](../ir/nodes.ts)) to **C++ source text**.
`emit(mod)` returns the full `.cpp`. It is **expression-based**: `emitExpr` returns a C++ expression
string and we let `clang++` do the real lowering — no SSA temporaries or pointer bookkeeping.

## The runtime header (`cpp/tsn_runtime.h`)

The program-**independent** C++ lives as real, editable C++ in [cpp/tsn_runtime.h](cpp/tsn_runtime.h),
not as a string in `emit.ts`: `tsn_str`, the JS-semantics numeric/string/array helpers, `tsn_math_*`
helpers, the `tsn_map`/`tsn_set` containers, `tsn_rc`/`tsn_box`, the async runtime (microtask queue,
`tsn_promise`, `tsn_resolve`/`tsn_all`), `tsn_fetch`/`tsn_response`, the union types, and the scalar +
array/map/set `tsn_inspect` / `tsn_json_*` overloads. Every emitted `.cpp` is `#include`-on-top + the
program-**dependent** code `emit` generates (per-shape structs, the per-type `tsn_inspect` /
`tsn_json_stringify` overloads that know field names, the user's functions, `main`).

- `emit.ts` emits the header path as an **absolute** path, so the generated `.cpp` recompiles by hand
  with no `-I`.
- `tsc` doesn't transpile `.h`, so [../../scripts/copy-runtime.mjs](../../scripts/copy-runtime.mjs)
  (wired into `npm run build`) mirrors `cpp/` into `dist/codegen/cpp/`.
- **Inspect ordering / ADL.** The header carries the scalar overloads + the array/map/set templates;
  the per-struct/class overloads are emitted into the `.cpp` (they need field names). A dependent
  element type resolves its overload by **ADL at the instantiation point**. Editing the header? Keep
  that contract: scalars + templates here, per-type overloads emitted there.

## Type mapping (`cppType` / `slotType`)

| tsn type             | C++ type                  | notes                                                                              |
| -------------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| `number`             | `double` or `long long`   | f64 by default; integer-valued slots use the i64 rep. `cppType`→`double`; `slotType` honors the rep |
| `boolean`            | `bool`                    | `console.log` prints via `tsn_inspect`                                             |
| `string`             | `tsn_str`                 | ref-counted immutable string; copy = pointer + refcount bump; methods → `tsn_*` helpers |
| `T[]`                | `tsn_rc<std::vector<T>>`  | reference type; `.length`→`->size()`, index `(*a)[i]`, methods on `*recv`          |
| `{ ... }`            | `tsn_rc<struct>`          | reference type; `structName()` dedupes the struct by field shape; field access `obj->f` |
| class `C`            | `tsn_rc<C>`               | reference type; `struct C { fields; ctor; methods; }`; `new`→`tsn_make_rc`         |
| `Map<K,V>`           | `tsn_rc<tsn_map<Kc,Vc>>`  | reference type; methods via `->`; keys/values f64                                  |
| `Set<T>`             | `tsn_rc<tsn_set<Tc>>`     | reference type; iterable by `for…of`                                               |
| `Promise<T>`         | `tsn_promise<Tc>`         | C++20 coroutine type; `Promise<void>`→`tsn_promise<tsn_unit>`                      |
| `Response`           | `tsn_rc<tsn_response>`    | `fetch` result; `status`/`ok`, `text()`/`json()`                                   |
| `null`/`undefined`   | `tsn_null`/`tsn_undefined`| empty tag structs (distinct so a union discriminates them)                         |
| `A \| B`             | `tsn_union<M0, …>`        | a `std::variant` wrapper (ADL); members rep-stable, `undefined`/`null` first       |
| `(P…) => R`          | `std::function<Rc(Pc…)>`  | reference type; number params/returns are the f64 rep; captured locals boxed       |

- **All composites are reference types (`tsn_rc<…>`)**, so JS semantics hold uniformly: copy/assign
  aliases, mutation is shared, params are mutable, `===`/`!==` is pointer identity. `isAggregate`
  (array||object) still distinguishes object/array *literals* from class instances where
  lowering/printing differs, but no longer implies a value type.
- **`tsn_rc`, not `std::shared_ptr`.** A non-atomic, control-block ref-counted pointer (the trick
  `tsn_str` already used). Generated programs are single-threaded, so `shared_ptr`'s atomic refcount
  is wasted work — and it dominated element-shuffling loops (~6× on the object benchmark). Only
  `tsn_promise`'s internal state stays `std::shared_ptr`.
- **Aggregates nest:** `cppType` recurses (`number[][]` → `tsn_rc<std::vector<tsn_rc<std::vector<double>>>>`).
  Struct members are `tsn_rc`s (pointers to incomplete types are fine), so every struct is
  forward-declared up front and order doesn't matter. Nested numbers stay f64.

A `Value` is `{ code, type, rep? }` — the C++ expression text, its tsn `Type`, and (for `number`) its
representation `"i64"`/`"f64"`.

## Number representation (`repr.ts`, run before emission)

JS `number` is f64, but most program numbers are integer-valued. [repr.ts](repr.ts) runs a **monotone
fixpoint** over the module and decides, per slot (variable/param/return/global), whether only integer
values can flow in (→ `long long`/i64) or not (→ `double`/f64). The emitter then declares slots via
`slotType`/`paramType`/`retSlotType` and tags each expression's rep (`litRep`/`combineRep`): `+ - *`
are i64 only when both operands are; `/` is **always** f64; `%` yields f64 (`tsn_imod` guarded so
`x % 0` is `NaN`); `.length` is i64; fields/elements are f64.

Soundness rests on the fixpoint never declaring an i64 slot that can receive a fraction (it demotes
i64→f64 on the first floating source and re-walks). The emitter stays the type authority, so a
divergence can only make a rep more conservative, never unsound. Entry-module top-level vars are
**globals** with name-keyed rep slots; dependency `init` bodies are walked under a `$dep<idx>` key.

## The `Emitter` class

- **Module-level:** `sigs` (function signatures, collected first so any call resolves), `classes`,
  `structDefs`/`structNames`/`structFields` (generated structs, deduped by field shape), `globals` +
  `globalDecls` (the entry's promoted top-level vars).
- **Per-function scratch** (reset by `resetForFunction`): `body`, `vars`, `curReturn`, `funcKey`
  (rep-lookup scope), `currentClass`, `indent`, `boxed`, `narrowed`.
- **Output shape:** `#include "tsn_runtime.h"` → class/struct forward decls → per-type inspect fwd
  decls → struct defs → class defs → per-type inspect defs → global decls → out-of-line class
  method/ctor defs → dependency `init()` defs → function prototypes → function defs → `int main()`.
- **Emission order matters:** `main` and the dependency `init()`s are emitted *before* the function
  bodies, because doing so populates `this.globals` and registers the synthetic `init` signatures
  those bodies reference.

## Conventions (match these)

- Build C++ expressions; fully parenthesize binary ops (`(${l} ${op} ${r})`).
- A safe-integer literal emits as i64 (`2`→`2LL`); fractional/large as a `double` literal.
- `let` declares with the initializer's type, but a `number` slot's C++ type comes from its rep
  (`slotType`), not `cppType`.
- `console.log` → `std::cout << <out> << "\n"`: bare for a top-level string, `tsn_num_to_string`/bare
  for a number, `tsn_inspect(...)` for everything else (see *Printing*).
- Object/array literals → `tsn_make_rc<…>(…)`; brace-init values pass through `f64SlotCode` (element/
  field slots are always `double`, so an i64-rep value is cast — a brace-init narrows a non-constant
  `long long`→`double` and clang rejects it).
- `&&`/`||` follow JS: both-boolean → plain `(l && r)`; otherwise they **return an operand** via an
  IIFE (`tsn_truthy` gives JS truthiness), keeping short-circuit + single left-eval.
- `emitCall(e, asStatement)` — a `void` call is valid only in statement position.

## Function boundaries (params & returns)

Because arrays/objects/instances are all reference types, the boundary is uniform:

- **Params: by value, mutable.** `paramType` is `slotType` for every param. For a reference type
  that's a `tsn_rc` copy aliasing the caller's value, so callee mutation is visible (correct JS).
  The old read-only-param apparatus is gone.
- **Returns:** `retSlotType` returns a reference type by value — the shared `tsn_rc`, not a deep copy.
- **Default / rest / spread (`checkArgs`).** Every call routes args through `checkArgs`, over
  normalized `CallSlot`s (`{ type, optional, rest }`): a default param's slot is optional with
  boundary type `T | undefined`; a rest param's slot is `{ type: T[], rest: true }`. Arity is checked
  against `[minFixed, fixedCount]`; an omitted trailing optional appends a `tsn_undefined{}`; the rest
  slot collects remaining args into a fresh `T[]` (so `f(1, ...xs, 2)` splices). A spread arg is
  allowed only in the rest region. A default param is received at the boundary as `T | undefined`
  under a mangled name and rebound to `T` at entry (`resolveDefault`), so the default may reference
  earlier params. Destructuring params never reach codegen — lowering desugars them.
- **Spread in array literals.** `emitArrayLiteral` handles `[...a, ...b, c]`: with spreads it builds a
  fresh array via an IIFE that `push_back`s elements and splices spread arrays (so `[...a]` is a copy).

## Modules (entry globals + dependency records)

The loader ([../frontend/modules.ts](../frontend/modules.ts)) splits the top-level into the **entry**
(`mod.main`) and **dependency modules** (`mod.modules`):

- **Entry → `main()` with promoted globals.** A direct top-level `let`/`const` is promoted to a
  file-scope global (declared in `globalDecls`, assigned in `main`) so a separately-compiled function
  body can read it. Nested `let`s stay locals.
- **Dependency → memoized `init()` returning a record.** `emitDepInit` compiles a `DepModule` to
  `tsn_rc<tsn_ObjN> tsn_modN_init()` with `static rec; if (rec) return rec; …`. Its direct `let`s
  become record-field assignments; it registers a synthetic `init` signature so the loader's rewrite
  of a module-variable reference to `member(call(initN), field)` type-checks.
- **Eager init.** `main` calls every `init()` in dependency order before the entry top-level (import
  side-effect timing). A single-file program has no `mod.modules`, so none of this fires.

## Classes

A class → `struct C { fields; C(ctor); methods; };`, an instance → `tsn_rc<C>` (JS reference
semantics fall out for free; `===` is identity).

- **Emission order:** forward-declare every class/struct → struct defs → class struct defs (field
  members + ctor/method declarations) → out-of-line defs → functions → main. Forward decls let any
  type reference any later/self type via `tsn_rc`.
- **Methods/ctor are analyzed scopes** (keys `C#method` / `C#$ctor`, matching `repr.ts`), so their
  number params/locals/returns get i64/f64 reps. **Fields are always f64.**
- **`this` and receivers.** Member access / method call are uniformly `(code)->name` (both `tsn_rc<C>`
  and the raw `this` pointer use `->`). Bare `this` as a value is rejected.
- **Params: by value, mutable** — like every param now.

## Printing (`console.log` → `tsn_inspect`)

Matches Node's `util.inspect` JS-style format on the subset. The `log` statement keeps numbers/
top-level strings bare and routes everything else through a `tsn_inspect` family:

- **Fixed scalar overloads** + `tsn_quote` (quote/escape chars built from byte values, so the
  generated C++ has no backslashes).
- **Array / Map / Set templates** (runtime header), recursing on element/key/value (object/class
  elements resolve via ADL).
- **Per-struct / per-class overloads** emitted into the `.cpp` (they know field names).

Always single-line (no Node `breakLength` wrapping) — matches Node for small values.

## JSON (`JSON.stringify` / `JSON.parse`)

Both match Node byte-for-byte. The runtime carries the program-independent halves; codegen the shaping.

- **`jsonStringify`** is C++ overload resolution: scalar overloads + array template in the runtime,
  one overload per object struct/class generated by codegen (the `tsn_inspect` machinery, but JSON
  output — double-quoted keys, no spaces, no class name).
- **`jsonParse`** → an inline extraction expression (`extractJson`): the runtime parses to a generic
  `tsn_json`; codegen pulls the statically-known target type out (scalars via accessors, arrays/objects
  via IIFEs that recurse). A parsed `number` is always f64. A class/Map/Set target is rejected
  (`assertJsonType`).
- **Errors.** No exceptions in the subset, so a malformed parse or type mismatch calls `tsn_json_fail`
  (stderr + `exit(1)`).

## Math / Map / Set

- **`Math.*`** (`emitMathCall`/`emitMathConst`) — always `number`/f64; args cast to `double` for the
  `<cmath>` overload. JS-divergent functions use `tsn_math_*`; constants emit as exact double literals
  (not `M_PI`), so output matches Node.
- **Broader string/array methods** are more `case`s calling `tsn_*` helpers. In-place-then-return
  methods (`reverse`/`fill`) and `set`/`add` use a by-value IIFE so they stay chainable; `concat`
  wraps in a fresh `tsn_make_rc` (new identity).
- **`Map`/`Set`** (`emitMapMethod`/`emitSetMethod`) are reference types reusing the array machinery
  for `===`/`for…of`/`.size`. `get` returns the value **default** on a miss (the no-`undefined`
  divergence; the transparent `!` lets it type-check); `clear` is statement-only.

## Control flow (loops, switch, break/continue, try)

- **`for…of` / `for…in`** — an index loop over a once-evaluated temp; the element type comes from the
  iterable's `Value.type` (lowering can't see it). A number `for…of` var is f64; `for…in` yields
  string keys.
- **`break`/`continue` + `breakStack`.** Every loop and `switch` pushes a `BreakCtx`. Unlabeled loops
  are *native* (`break;`/`continue;`); every labeled loop and every `switch` is *goto-form* (carries
  generated labels), so a labeled break/continue can target an outer loop and `switch` fall-through
  works. A goto-form `for` moves its update after the continue label so `continue` still runs it.
- **`switch`** (`emitSwitch`) — compiled like a C compiler internally (JS `===`, fall-through,
  `default` anywhere): evaluate the discriminant once, emit `if ((_sw == test)) goto _cN;` per case in
  source order, then `goto` default/end. Each clause body is its own `{ }` block.
- **`try`/`catch`/`finally`/`throw`** (`emitTry`). `throw` requires a `string` (→ C++ `throw
  <tsn_str>`); `catch` is `catch (const tsn_str& e)`. A `finally` is a **RAII guard**
  (`tsn_make_finally`), so it runs on every exit and needs no C++ `try`. `assertFinallySafe` rejects
  `return`/`throw`/escaping `break`/`continue` inside a `finally` (it runs from a destructor).
- **`-Werror=return-type`** survives switches/loops where every path returns — clang follows the
  `goto` dispatch.

## Async / await (faithful event loop)

Built on **C++20 coroutines** + a **microtask queue** — no closures needed (the only continuations are
internal coroutine handles). Ordering matches Node/V8 byte-for-byte.

- **Async function → coroutine.** `emitFunction`/`emitMethodDef` set `curAsync`. The declared return
  type is the promise type, so `retSlotType` gives `tsn_promise<…>`. A `return` becomes `co_return`
  against the promise's resolved type; a void async gets a trailing `co_return tsn_unit{};`. Returning
  a `Promise<T>` from a `Promise<T>` function **adopts** it (`co_return co_await …`).
- **`await` → `co_await`** (`emitAwait`). On a non-promise it wraps in `tsn_resolve(v)` so the one-tick
  deferral still happens.
- **Top-level `await`** — when the entry top-level contains an `await`, `emitMain` routes to
  `emitTopLevelCoroutine`: the top-level becomes `tsn_promise<tsn_unit> tsn_top_level()` that `main()`
  starts then drains. Gated, so non-TLA `main()` is byte-identical. TLA in an imported module is rejected.
- **`Promise.resolve`/`all`** → `tsn_resolve`/`tsn_all`. `reject`/`race`/etc. and `new Promise(executor)`
  are clean errors.
- **The event loop.** `emitMain` appends one `tsn_run_microtasks();`, gated on `this.usesAsync`, so a
  non-async `main()` is byte-identical.
- **Lambda-body limitation.** `await` can't appear inside a construct codegen lowers to a C++ lambda
  body (the `&&`/`||` IIFE, `Array.fill` index args) — `containsAwait` raises a clean error.

## fetch / Response

`fetch(url)` → `Promise<Response>`. No async I/O in the microtask loop, so `fetch` does a **blocking**
libcurl GET and returns an already-settled promise; `await` still defers one tick.

- **`fetch` node** → `tsn_fetch(url)`. A transport error **rejects** (so `await` throws a catchable
  string); an HTTP error status **resolves** with `ok === false` (real-fetch semantics). The curl
  include + `tsn_fetch` are `#ifdef TSN_ENABLE_FETCH`.
- **`Response`** (`isResponse`): `res.status`/`res.ok` are member loads; `res.text()` →
  `tsn_resolve((res)->body)`.
- **`json()`** is `Promise<any>`, so the target type is required (`await res.json() as T` or an
  annotated target → a `responseJson` node reusing `extractJson`). A bare `res.json()` is a clean error.
- **`usesFetch` gate** prepends `#define TSN_ENABLE_FETCH 1` and the driver adds `-lcurl`. Non-fetch
  programs link unchanged.

## Union types & narrowing

A union → **`tsn_union<…>`** — a `std::variant` wrapper (so our `tsn_inspect`/`tsn_truthy`/`tsn_typeof`
overloads resolve by ADL even for an all-scalar union). `null`/`undefined` are empty tag structs.

- **Type identity.** Lowering canonicalizes members; `cppType` re-sorts the C++ alternatives by final
  (post-rename) type text, `undefined`/`null` first — so equal unions emit byte-identical types
  (rename-stable) and the variant's default alternative is the JS-correct `Map.get`-miss value.
- **Assignability vs. equality.** `isAssignable` allows member→union and narrower→wider widening
  (top-level only), driving `coerceTo` (explicit `std::in_place_type`, `tsn_union_widen` for
  union→union) at every value-flow site. Equality is separate (`emitUnionEquality`): `u === member` is
  holds-and-equals; `u === u` compares the variants.
- **Flow narrowing** (`analyzeGuard` + `this.narrowed`) is done **in the emitter** — stage 0 already
  proved the program correct, so the emitted `std::get<Member>` is sound. Recognizes `typeof x ===
  "lit"`, `x === null`/`undefined`, truthiness, and `&&` chains; `if`/ternary install positive/negative
  narrowing via `withNarrowed`; early-return narrowing installs the negative for the rest of the block.
  Reassigning a narrowed var drops its narrowing. `typeof e` is a first-class `string`.
- **Deferred** (clean errors): optional object fields, a ternary with differing branch types
  (union-merge), and union-typed array/Map/Set element coercion.

## Closures / first-class functions

A function value → **`std::function<Rc(Pc…)>`** where number params/returns use the f64 rep (so the
C++ type is context-stable).

- **The capture pass** ([closures.ts](closures.ts), run before `repr`/`emit`) assigns each `closure` an
  `id` (rep-scope key `$closure<id>`) and marks every local **captured** by a nested closure as `boxed`.
  Top-level module variables are file-scope and never boxed.
- **Boxing.** A boxed binding is a heap cell `tsn_rc<tsn_box<T>>`; reads/writes go through `(name)->v`.
  A boxed param is copied into its cell at entry; a boxed `let` uses a two-step alloc-then-assign form
  (so a self-referential closure captures the cell first); a captured `for…of`/`for…in` var is re-boxed
  each iteration; a captured C-style `for` counter is one shared cell (JS `var`-like). The lambda's
  `[=]` copies the shared cell pointer — full JS capture semantics.
- **`emitClosure`** swaps the entire per-function scratch (inheriting `vars`+`boxed` so the body
  resolves captured outer vars), emits the body, restores. The return type is the annotation else
  **inferred** from the body's `return`s (`unifyReturns`, like a ternary). Closures nest; async closures
  are rejected in lowering.
- **Calling.** `emitCallValue` for any function-typed expression; `emitFieldCall` for a function-valued
  field; a bare top-level-function name in value position becomes `std::function<…>(name)` (and
  `repr.ts` demotes that function's params/return to f64).
- **Runtime:** `tsn_box<T>` + `std::function` overloads of `tsn_truthy`/`tsn_typeof_one`/`tsn_inspect`/
  `tsn_json_stringify`.
- Closures support default/rest/destructuring params like any function.

## Guard clauses

Type errors are caught earlier by stage 0 ([../frontend/check.ts](../frontend/check.ts)) and never
reach codegen. The emitter still throws a clear `Error` (→ `tsnc:`) for constructs the subset doesn't
lower: incompatible string concat, arithmetic on aggregates, indexing a non-array, an empty array
literal with no annotation, void-as-value, an unknown class/method/field, a class/Map/Set `JSON`
target, `Map.forEach`/`entries`, and bare `this` as a value. Lowering adds: a bare `JSON.parse(x)` with
no target, and a general `as T` assertion (only `JSON.parse(text) as T` / `await res.json() as T` are
accepted).
