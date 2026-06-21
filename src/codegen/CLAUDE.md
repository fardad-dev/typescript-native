# src/codegen/ — C++ emission (stage 3)

[emit.ts](emit.ts) lowers the internal IR ([../ir/nodes.ts](../ir/nodes.ts)) to **C++ source
text**. `emit(mod): string` returns the full `.cpp`. C++ is a high-level target, so this is
**expression-based**: `emitExpr` returns a C++ expression string and we let `clang++` do the
real lowering — no SSA temporaries or pointer bookkeeping here.

## The runtime header (`cpp/tsn_runtime.h`)

The program-**independent** C++ — `tsn_str`, the JS-semantics numeric/string/array helpers
(`tsn_mod`, `tsn_substring`, `tsn_push`, `tsn_str_includes`, `tsn_trim`, `tsn_array_reverse`, …),
the `tsn_math_*` helpers (where Math diverges from `<cmath>`), the `tsn_map`/`tsn_set` container
templates, the **async runtime** (the microtask queue `tsn_microtask_queue`/`tsn_enqueue_microtask`/
`tsn_run_microtasks`, `tsn_unit`, `tsn_promise`/`tsn_promise_state`, and the `tsn_resolve`/`tsn_all`
helpers — see *Async / await* below), the scalar + array/map/set-template `tsn_inspect` overloads
(incl. a `tsn_promise` one), and the JSON runtime
(`tsn_json` + `tsn_json_parse`, the `tsn_json_as_*` accessors, and the scalar +
array-template `tsn_json_stringify`) — lives as **real, editable C++** in
[cpp/tsn_runtime.h](cpp/tsn_runtime.h), not as a string in `emit.ts`. Every emitted `.cpp` is just
`#include "<abs>/tsn_runtime.h"` on top, followed by the program-**dependent** code `emit` generates
(per-object-shape structs, the per-type `tsn_inspect` / `tsn_json_stringify` overloads that know
field names, the user's functions, `main`).

- `emit.ts` resolves `RUNTIME_HEADER = ${__dirname}/cpp/tsn_runtime.h` and emits it as an
  **absolute** path, so the generated `.cpp` recompiles by hand (`clang++ -std=c++17 file.cpp`)
  with no `-I` — keeping it self-contained.
- `tsc` only transpiles `.ts`, so the header doesn't reach `dist` on its own;
  [../../scripts/copy-runtime.mjs](../../scripts/copy-runtime.mjs) (wired into `npm run build`)
  mirrors `cpp/` into `dist/codegen/cpp/`, so `${__dirname}/cpp` resolves whether `emit` runs from
  `src` (the vitest suite imports `../src/driver`) or `dist` (the installed CLI). The published
  package ships only `dist`, so this is also what makes the runtime available to consumers.
- **Inspect ordering / ADL.** The header carries `tsn_inspect`'s scalar overloads + the array
  template (decl + def); the per-struct/class overloads stay in the `.cpp` (they need field
  names). The array template calls `tsn_inspect((*a)[i])` on a *dependent* element type, so an
  object/class element resolves its overload by **ADL at the instantiation point** in the
  generated code (those overloads share the global namespace with their struct/class). Editing the
  header? Keep that contract: scalars + array template here, per-type overloads emitted there.

## Type mapping (`cppType` / `slotType`)

| tsn type            | C++ type             | notes                                                  |
| ------------------- | -------------------- | ------------------------------------------------------ |
| `number`            | `double` or `long long` | f64 by default; integer-valued slots use the `i64` rep (`long long`) — see below. `cppType` returns `double` (the rep used for nested aggregates); `slotType` honors the slot's rep |
| `boolean`           | `bool`               | `console.log` prints `true`/`false` via `tsn_inspect` (see *Printing* below) |
| `string`            | `tsn_str`            | ref-counted immutable string (prelude struct); copy = pointer + refcount bump, so array shuffles don't copy chars. Every string expr is a `tsn_str` (literals too: `tsn_str("…")`); operators (`<` `==` `+` `<<`) and `.str()`/`.size()` are defined on it; methods → `tsn_*` helpers (take `const std::string&` via its conversion; mostly return `tsn_str`, but `split` returns a `tsn_rc<std::vector<tsn_str>>`) |
| `T[]`               | `tsn_rc<std::vector<T>>` | **reference** type (`vecType` = the pointee `std::vector<T>`): literals `tsn_make_rc`, `let b = a` aliases, `===` is identity. `.length` → `(a)->size()` (i64); index derefs: `(*(a))[i]` (cast to `std::size_t`); methods run on `*recv`: `push`→`tsn_push` (new length, f64), `pop`→`tsn_pop` (element; empty → `T()`), `slice`→`tsn_make_rc(tsn_array_slice(...))` (new array), `indexOf`→`tsn_array_index_of` (f64, `==` on `T`), `join`→`tsn_join` (`string[]`/`number[]` → `tsn_str`) |
| `{ ... }`           | `tsn_rc<struct>` | **reference** type: `structName()` dedupes the pointee struct by field shape; literals `tsn_make_rc<struct>(struct{...})`, field access `obj->f`, number fields use the f64 rep |
| class `C`           | `tsn_rc<C>` | **reference** type: `struct C { fields; ctor; methods; }`, instance is a `tsn_rc` — `new` → `tsn_make_rc`, `.field`/`.method()` via `->`. See *Classes* below |
| `Map<K, V>`         | `tsn_rc<tsn_map<Kc, Vc>>` | **reference** type (`mapPointee`): an insertion-ordered `tsn_map` (runtime). `new Map<K,V>()` → `tsn_make_rc`; methods (`set`/`get`/`has`/`del`/`clear`/`keys`/`values`) via `->`; `.size` like `.length` (i64). Keys/values use the f64 rep. See *Math / Map / Set* below |
| `Set<T>`            | `tsn_rc<tsn_set<Tc>>` | **reference** type (`setPointee`): an insertion-ordered `tsn_set`. `new Set<T>(arr?)` → `tsn_make_rc` (the array seeds it); `add`/`has`/`del`/`clear`/`values` via `->`; iterable by `for…of`; `.size` (i64) |
| `Promise<T>`        | `tsn_promise<Tc>` (C++20 coroutine type) | **reference** type: a handle wrapping a `std::shared_ptr` to promise state (the one aggregate left on `shared_ptr` — not a hot path). An `async` function's declared return type — its body is a coroutine (`co_return`/`co_await`). `Promise<void>` → `tsn_promise<tsn_unit>`. Resolved numbers use the f64 rep. See *Async / await* below |
| `Response`          | `tsn_rc<tsn_response>` | **reference** type: the `fetch(...)` result. Fields `status` (f64) / `ok` (bool); methods `text()` → `Promise<string>`, `json()` → `Promise<T>` (target type required). See *fetch / Response* below |
| `null` / `undefined` | `tsn_null` / `tsn_undefined` | empty tag structs (distinct types so a union variant discriminates them; `typeof null === "object"`). Mostly a union member / the optional-`?:` desugar |
| `A \| B \| …` (union) | `tsn_union<M0, …>` | a `std::variant` **wrapper** (ADL). Members rep-stable + `undefined`/`null`-first (the default alternative). See *Union types & narrowing* below |

Arrays, objects and class instances are **all reference types** (`tsn_rc<…>`), so JS
semantics hold uniformly: copy/assign aliases, mutation through one alias is visible through the
others, params are mutable (a `tsn_rc` copy aliases the caller's value), and `===`/`!==` is
pointer identity. `isAggregate` (array||object) still distinguishes object/array *literals* from
class instances where lowering/printing differs, but no longer implies a value type.

**`tsn_rc`, not `std::shared_ptr`.** The reference pointer is `tsn_rc<T>` — a non-atomic,
control-block ref-counted pointer (runtime header), a drop-in for the `shared_ptr` API codegen
uses (`operator->`/`*`/`bool`, identity `==`/`!=`, `tsn_make_rc` ≈ `make_shared`). Generated
programs are single-threaded, so `std::shared_ptr`'s atomic refcount is wasted work — and it
*dominated* element-shuffling hot loops (every `a[j+1] = a[j]` swap is a pointer copy = an atomic
inc/dec). Switching to a plain-`long` refcount (the same trick `tsn_str` already uses) made that
copy as cheap as a value move: ~6× on the object-heavy leaderboard benchmark (tsnc/cpp 7.55× →
1.24×), no semantics change. Only `tsn_promise`'s internal state stays `std::shared_ptr`.

**Aggregates nest.** `T` (array element) and a field type may themselves be aggregates, so
`cppType` recurses: `number[][]` → `tsn_rc<std::vector<tsn_rc<std::vector<double>>>>`,
`{ pts: number[] }` → a struct with a `tsn_rc<std::vector<double>>` member,
`{ inner: { x: number } }` → a struct whose member is a `tsn_rc` to another struct. Because
struct *members* are now `tsn_rc`s (pointers to incomplete types are fine), struct order no
longer needs inner-before-outer — every struct is forward-declared (`struct tsn_ObjN;`) up front.
Element/field values still pass through `f64SlotCode` (an aggregate value returns as-is; only
`i64`-rep *numbers* get the `double` cast), and nested numbers stay f64.

A `Value` is `{ code, type, rep? }` — the C++ expression text, its tsn `Type`, and (for
`number`) its representation `"i64"`/`"f64"`. No length tracking is needed (arrays are real
`std::vector`s behind a `tsn_rc`).

## Number representation (`repr.ts`, run before emission)

JS `number` is f64, but most program numbers are integer-valued. [repr.ts](repr.ts) runs a
**monotone fixpoint** over the whole module and decides, per variable / parameter / return
("slot"), whether it can be a `long long` (`i64`) — i.e. only integer values can flow in — or
must stay `double` (`f64`). The emitter then:

- declares slots with `slotType` / `paramType` / `retSlotType` (consulting the table);
- tags each expression `Value` with a rep, combining locally (`litRep`, `combineRep`): `+ - *`
  are `i64` only when both operands are; `/` is **always** `f64` (so two integer vars don't do
  C++ integer division); `%` yields `f64` (`tsn_imod` for `i64` operands — guarded so `x % 0`
  is `NaN`, not UB — else `tsn_mod`); `.length` is `i64`; fields/elements/`charCodeAt` are `f64`.

Soundness rests on the rep table never declaring an `i64` slot that can receive a fraction
(the fixpoint demotes `i64`→`f64` on the first floating source, and re-walks until stable).
`repr.ts`'s expr typing mirrors the emitter's just well enough to find slots; the emitter stays
the authority on types, so a divergence can only make a rep more conservative, never unsound.
Accepted imprecision: integer wraparound past 2^63.

**Globals + module bodies.** A direct top-level `let`/`const` in the entry is a *global* with its
own rep slot, keyed by name (`globalSlot` / `RepTable.globalRep`) rather than a function scope, so a
function reading it and the global's declaration agree on i64/f64. `analyze` also walks each
dependency module's `init` body under a `$dep<idx>` key (matching the emitter), so nested locals get
reps and a float argument passed from a module's top-level demotes the callee's parameter. Dependency
*module variables* are record (object) fields = f64, reached via member access, so they need no slot.

## The `Emitter` class

- **Module-level:** `sigs` (function signatures, collected first so calls can reference
  any function), `classes`, `structDefs` + `structNames` (generated structs, deduped by field
  shape) + `structFields` (struct name → fields, for `tsn_inspect`).
- **Per-function scratch (reset by `resetForFunction`):** `body` (emitted statement lines),
  `vars` (name → `Type`), `curReturn`, `funcKey` (rep-lookup scope), `currentClass`, `indent`.
- **Module-level state (cont.):** `globals` (name → `Type`, the entry's promoted top-level vars) +
  `globalDecls` (their namespace-scope declaration lines).
- Output shape: `#include "cpp/tsn_runtime.h"` (the fixed runtime — `tsn_str`, helpers incl.
  `tsn_truthy` for `&&`/`||`, and the scalar + array-template `tsn_inspect`; see *The runtime
  header* above) → class/struct forward decls → per-type inspect fwd decls → object struct defs →
  class struct defs → per-type inspect defs → **module-level global decls** → out-of-line class
  method/ctor defs → **dependency `init()` prototypes + defs** → function prototypes → function
  definitions → `int main()`. (The runtime header replaces what used to be an inlined string
  prelude; only the program-dependent parts are generated now.)
- **Emission order matters:** `main` and the dependency `init()`s are emitted **before** the
  function/class bodies, because emitting them populates `this.globals` (entry vars) and registers the
  synthetic `tsn_modN_init` signatures (dependency record types) that those bodies reference.

## Conventions (match these)

- **Expression-based:** build C++ expressions; fully parenthesize binary ops
  (`(${l} ${op} ${r})`) to preserve precedence.
- A safe-integer literal emits as `i64` (`2` → `2LL`); a fractional/large one as a `double`
  literal (`2.5`, `1e21`, `2` → `2.0`).
- `let` declares with the **initializer's** type, but a `number` slot's C++ type comes from its
  rep (`slotType`), not `cppType` — so a demoted slot is `double` even with an `i64` initializer
  (the `i64` literal widens in). Aggregates still get their literal's exact `vector`/`struct` shape.
- `console.log` → `std::cout << <out> << "\n"`, where `<out>` is the bare expr for a top-level
  string, `tsn_num_to_string(...)`/bare for an f64/i64 number, and `tsn_inspect(...)` for everything
  else (boolean / array / object / instance) — see *Printing* below.
- Object literals become `make_shared<struct>(struct{...})`; arrays become
  `make_shared<vector<T>>(vector<T>{...})` (empty: `make_shared<vector<T>>()`). The inner brace-init
  values pass through `f64SlotCode`: element/field slots are always `double`, so an `i64`-rep value
  is cast (`static_cast<double>(…)`) — a brace-init list narrows a *non-constant* `long long`→`double`
  and clang rejects it (a literal constant like `3LL` narrows legally).
- `cppStringLiteral` encodes JS strings as C++ literals (escape `"`/`\`/controls; other bytes
  as 3-digit octal `\ooo`, which is bounded — unlike `\x`).
- `emitCall(e, asStatement)` — a `void` call is valid only in statement position.
- `&&` / `||` follow JS: both-boolean → the plain `(l && r)` boolean; otherwise (operands of the
  same non-boolean type) they **return an operand** via an IIFE
  (`([&]{ auto _t = (L); return tsn_truthy(_t) ? _t : (R); }())` for `||`), which keeps short-circuit
  and evaluates `L` once. `tsn_truthy` (prelude) gives JS truthiness (0/NaN/"" falsy, null ref falsy).
- Helpers: `cppType`/`retType`/`structName`, `sameType` (structural, order-independent for
  objects), `displayType` (error messages), `isArray`/`isObject`/`isAggregate`.

## Function boundaries (params & returns)

Functions take and return aggregates (arrays/objects), not just scalars. Because arrays/objects/
instances are all reference types now, the boundary is uniform and simple:

- **Params: by value, mutable.** `paramType` collapsed to one rule — `slotType` for every param
  (a `number` honors its i64/f64 rep; everything else is `cppType`). For a reference type that's a
  `tsn_rc` copy: a refcount bump that **aliases** the caller's value, so a callee mutation
  (`xs.push(v)`, `xs[i] = e`, `obj.f = e`) is visible to the caller — correct JS semantics. The old
  read-only-param apparatus (`readonlyParams` / `assertMutable` / `rootVarName`) is **gone**; there
  is no longer any mutation-through-param to reject.
- **Returns:** `retSlotType` returns a reference type by value — a `tsn_rc`, i.e. the shared
  reference, not a deep copy. `return xs;` hands back the same array the caller can then alias.

## Modules (entry globals + dependency records)

The loader ([../frontend/modules.ts](../frontend/modules.ts)) hands the emitter a `Module` whose
top-level is split into the **entry** (`mod.main`) and **dependency modules** (`mod.modules`):

- **Entry top-level → `main()` with promoted globals.** `emitMain` runs `emitTopLevel`: a *direct*
  top-level `let`/`const` is **promoted to a file-scope global** (`emitGlobalLet`) — declared in
  `globalDecls` (`<slotType> name;`, honoring its `globalRep`) and *assigned* in `main` — so a
  separately-compiled function body can read it (`this.vars` miss → `this.globals` fallback in the
  `var` / lvalue cases). Nested `let`s (inside a top-level loop/`if`) stay true locals.
- **Dependency module → memoized `init()` returning a record.** `emitDepInit` compiles a
  `DepModule` to `tsn_rc<tsn_ObjN> tsn_modN_init()` with `static rec; if (rec) return rec;
  rec = make_shared<…>(); <body>; return rec;`. The body's direct `let`s become record-field
  assignments (`rec->field = …`, through `f64SlotCode` since record fields are object-struct fields
  = f64); other statements run for side effects. It registers a **synthetic signature**
  `tsn_modN_init : () -> { fields }` (grown field-by-field, so a later statement reading an earlier
  field resolves), so the loader's rewrite of a module-variable reference to `member(call(initN),
  field)` type-checks via the ordinary object/member path.
- **Eager init.** `main` calls every `tsn_modN_init()` (dependency order) *before* the entry's
  top-level — a module's top-level side effects run at import time. `init()` is memoized, so later
  reads just return the cached record.
- A **single-file program** has no `mod.modules`, so none of this fires — codegen is exactly the
  pre-modules shape (entry top-level in `main`, its own vars as globals).

## Classes

A class compiles to `struct C { fields; C(ctor); methods; };` and an **instance** to
`tsn_rc<C>` (`cppType`). This is the roadmap's "heap + ref-counted" representation, and JS
reference semantics fall out for free: copy/assign shares the pointee (aliases see each other's
mutations), `===` is `tsn_rc::operator==` (identity), and the refcount frees the instance.

- **Emission order** (`emitModule`): forward-declare every class and object struct → object struct
  defs (`structDefs`) → class struct definitions (`emitClassStruct`: field members + ctor/method
  **declarations**) → out-of-line **definitions** (`emitClassDefs` → `emitCtorDef`/`emitMethodDef`)
  → functions → main (with the inspect fwd-decls/defs interleaved — see *Printing*). Forward decls
  let any type reference any later/self type via `tsn_rc`; the out-of-line bodies see every type
  complete. Building a class struct calls `cppType` on field types, which lazily generates any
  object structs they need.
- **Methods/ctor are analyzed scopes.** They use scope keys `C#method` / `C#$ctor`
  (`methodKey`/`ctorKey`), matching `repr.ts` (`methodSlotKey`/`ctorSlotKey`), so their number
  params/locals/returns get the same i64/f64 reps as free functions via `slotType`/`retSlotType`/
  `paramType`. **Fields are always f64** (`cppType(number)` = `double`), like object fields. Class-
  method *number returns* are treated as f64 (sound; matches the string-method path) — no method
  retRep is queried. `emitCtorDef`/`emitMethodDef` set `currentClass` + bind params, then emit.
- **`this` and receivers.** `thisValue()` yields `{code:"this", type: class}`; `emitReceiver(e)`
  shortcuts a `this` receiver to that (else `emitExpr`). Member access / method call are uniformly
  `(code)->name` because both `tsn_rc<C>` and the raw `this` pointer use `->`. Bare `this` as a
  value is rejected (the `emitExpr` `case "this"` throws) — only `this.field` / `this.method()`.
- **Params: by value, mutable** — like every parameter now (see *Function boundaries*). An instance
  passes as a `tsn_rc<C>` copy (a refcount bump); mutation through the param (`p.x = …`) is
  visible to the caller — correct JS reference semantics, now shared by array/object params too.
  `new`/method args are type-checked by the shared `checkArgs` (no per-arg `f64SlotCode` cast — reps
  are reconciled by `repr.ts`).

## Printing (`console.log` → `tsn_inspect`)

`console.log` matches Node's `console.log` (`util.inspect`) JS-style format on the subset. The
`log` statement keeps numbers/top-level strings bare and routes everything else through a
`tsn_inspect` family generated into the prelude:

- **Fixed scalar overloads** (`inspectPrelude`): `tsn_inspect(double|long long|bool|const tsn_str&)`
  + a `tsn_quote` (single-quotes a string for *nested* contexts). Quote/escape chars are built from
  their byte values (`(char)39`, `(char)92`) so the generated C++ has **no backslashes**.
- **Array / Map / Set templates** (in the runtime header): `tsn_inspect(const tsn_rc<vector<T>>&)`
  → `[ e0, e1 ]`, `tsn_inspect(const tsn_rc<tsn_map<K,V>>&)` → `Map(n) { k => v, ... }`, and
  `tsn_inspect(const tsn_rc<tsn_set<T>>&)` → `Set(n) { e0, ... }`, each recursing on its
  element/key/value (object/class elements resolve via ADL at the instantiation point, like arrays).
- **Per-struct / per-class overloads** (`aggregateInspectDefs` / `inspectBody`): one function per
  generated object struct (`{ k: v, ... }`) and per class (`Name { k: v, ... }`), knowing the field
  names (struct fields recorded in `structFields` during `structName`).

Ordering in `emitModule`: the scalar prelude + the array template's *forward declaration* come
first; then class/struct forward decls; then the per-type inspect forward decls; then the full
struct/class defs; then the array-template + per-type inspect *definitions* (every type complete by
now). Caveat: always single-line (no Node `breakLength` wrapping) — matches Node for small values.

## JSON (`JSON.stringify` / `JSON.parse`)

Both match Node byte-for-byte on the subset. The runtime ([cpp/tsn_runtime.h](cpp/tsn_runtime.h))
carries the program-independent halves; codegen emits the program-dependent shaping.

- **`jsonStringify` → `tsn_json_stringify(<arg>)`.** Dispatch is pure C++ overload resolution: the
  runtime has the scalar overloads (`double`/`long long`/`bool`/`tsn_str`, with `null` for
  non-finite numbers) + the array template; codegen generates one overload **per object struct /
  class** (`jsonStringifyFwdDecls` / `aggregateJsonStringifyDefs` / `jsonStringifyBody`) — the exact
  `tsn_inspect` machinery, including forward decls and ADL resolution of array elements at the
  instantiation point. The difference is JSON output: double-quoted keys (`"k":v`), no spaces, and
  **no class name** on an instance. These per-type fwd-decls/defs are interleaved in `emitModule`
  right after the matching `tsn_inspect` ones.
- **`jsonParse` → an inline extraction expression** (`emitJsonParse` / `extractJson`). The runtime
  parses the text to a generic `tsn_json` (a tagged union); codegen pulls the **statically-known
  target type** out of it: scalars via the `tsn_json_as_*` accessors, arrays/objects via
  immediately-invoked lambdas that build the `vector`/`struct` and recurse (`uid`-suffixed locals,
  so nested lambdas don't shadow). No per-type helpers or forward decls are needed — a JSON value
  type is a finite tree (the subset has no recursive/aliased types). `assertJsonType` rejects a
  **class** target (no prototype to rebuild). A parsed `number` is always the f64 rep (JSON numbers
  parse to doubles), so `repr.ts` reports `jsonParse` as f64 regardless of the target's number rep.
- **Errors.** No exceptions in the subset, so a malformed parse or a value that doesn't match the
  asserted type calls `tsn_json_fail` (stderr + `exit(1)`) — the closest analog to an uncaught JS
  `SyntaxError`.

## Math / Map / Set (stdlib breadth)

- **`Math.*`** (`emitMathCall` / `emitMathConst`, from the `mathCall`/`mathConst` IR nodes). Always
  `number`-typed and the **f64 rep** (Math is double math), so `repr.ts` reports both as f64 and the
  emitter casts every argument to `double` (`static_cast`) to pick the floating `<cmath>` overload.
  `MATH_UNARY_STD` maps the straight-through functions; `round`/`sign`/`min`/`max`/`random` use a
  `tsn_math_*` helper (JS divergences — half-to-+∞ rounding, NaN propagation); `min`/`max`/`hypot`
  are **folded** over the variadic args; constants emit as exact double literals (`MATH_CONST`), not
  `M_PI`, so the output matches Node byte-for-byte.
- **Broader string/array methods** are just more `case`s in `emitStringMethod` / the array branch of
  `emitMethodCall`, each calling a `tsn_*` runtime helper. The two in-place-then-return-the-array
  methods (`reverse`, `fill`) emit an **IIFE that takes the receiver by value** (a refcount bump,
  evaluated once) and returns it, so they stay chainable; `concat` folds `tsn_array_concat` and wraps
  in a fresh `make_shared` (new identity); a value/search arg is `f64SlotCode`-cast so template
  deduction sees one element type. `repr.ts` learned each method's return type.
- **`Map`/`Set`** (`emitMapMethod` / `emitSetMethod`, constructed by the `mapNew`/`setNew` IR nodes;
  `mapPointee`/`setPointee` give the `tsn_map<Kc,Vc>` / `tsn_set<Tc>` pointee, keys/values/elements
  in the f64 rep). They're reference types, so `cppType` wraps them in `tsn_rc` and `===`/`for…of`
  (Set) / `.size` reuse the array machinery. `set`/`add` return the receiver via the same by-value
  IIFE (chainable); `get` returns the value type (`tsn_map::get` yields the value **default** on a
  miss — the no-`undefined` divergence, which the transparent `!` non-null assertion in lowering lets
  type-check); `clear` is statement-only (`asStatement` guard). Per-type `tsn_inspect` isn't needed —
  the `tsn_map`/`tsn_set` inspect overloads are **templates in the runtime header** (they recurse on
  K/V/T, resolving object/class elements by ADL like the array template). `JSON.stringify` of a
  Map/Set is a clean `tsnc:` error (no overload — Node would print `{}`); `assertJsonType` likewise
  rejects a Map/Set `JSON.parse` target.

## Control flow (loops, switch, break/continue, try)

Beyond `if`/`while`/C-style `for`, the emitter lowers JS's remaining statement-level control flow:

- **`for…of` / `for…in`** (`emitForOf` / `emitForIn`) — an index loop over a once-evaluated temp
  (`auto _tsn_itN = <iterable>;`). `for…of` over an array reads `(*_it)[i]`, over a string reads a
  one-char `tsn_str`; the element type comes from the iterable's `Value.type` (lowering can't see
  it). A number `for…of` var is declared `double` — array elements/string chars are the f64 rep, and
  `repr.ts` demotes the loop-var slot to match. `for…in` yields *string* keys: array/string indices
  (`tsn_str(std::to_string(i))`) or an object/instance's field names (a fixed `std::vector<tsn_str>`,
  from `forInKeys`).
- **`break` / `continue` and the `breakStack`.** Every loop pushes a `BreakCtx`; a `switch` pushes
  one too. A context is *native* (`goto:false`) — `break;`/`continue;` are the C++ keywords — or
  *goto-form* (`goto:true`) — it carries generated `breakLabel`/`continueLabel` and the statements
  emit `goto`s. **Unlabeled loops are native; every labeled loop and every `switch` is goto-form**
  (so a labeled break/continue, which may target an *outer* loop, can jump to it, and so a `switch`'s
  fall-through works). `breakTarget`/`continueTarget` resolve the stack: a label finds the matching
  loop; unlabeled `break` takes the innermost loop-or-switch, unlabeled `continue` the innermost loop
  (skipping switches). A `labeled` statement just stashes `pendingLabel`, which the wrapped loop
  consumes in `enterLoop`. A goto-form `for` moves its update after the continue label so `continue`
  still runs it.
- **`switch`** (`emitSwitch`) — compiled like a C compiler does internally, *not* as a value table
  (JS matches with `===`, falls through, and `default` can sit anywhere — none of which a C++
  `switch` expresses): evaluate the discriminant once into `auto _sw = …`, emit `if ((_sw == test))
  goto _cN;` per case in source order (first match wins, later tests unevaluated), then `goto` the
  default (or the end). Each clause body is its own `{ }` block (so the forward dispatch `goto`s never
  bypass a clause-local's initialization) at a label, in source order — so fall-through is just
  falling into the next block. `break` (the switch's `BreakCtx`) is `goto _swend`.
- **`try` / `catch` / `finally` / `throw`** (`emitTry`). `throw` requires a `string` (→ C++ `throw
  <tsn_str>`); the subset has no `Error`/`unknown`. A `catch` is a C++ `catch (const tsn_str& e)`
  (the binding typed `string`). A **`finally` is a RAII guard** — `auto _tsn_finN =
  tsn_make_finally([&]{ … });` (the one runtime addition, [cpp/tsn_runtime.h](cpp/tsn_runtime.h)) —
  whose destructor runs the body on *every* exit (normal, `return`, exception unwind), so a `finally`
  needs **no** C++ `try`; only a `catch` does. `assertFinallySafe` rejects `return`/`throw`/escaping
  `break`/`continue` inside a `finally` (the body runs from a destructor, which must not unwind).
- **`-Werror=return-type`.** A `switch` whose every clause `return`s and a goto-form loop both leave
  no trailing `return`, but clang's reachability analysis follows the `goto` dispatch and is
  satisfied. (Clang does emit a harmless `-Wparentheses-equality` on the fully-parenthesized
  `(_sw == test)` dispatch — a warning, not an error, and the same style the rest of codegen uses.)

## Async / await (faithful event loop)

`async`/`await` is a **faithful event-loop** implementation (not synchronous erasure), built on
**C++20 coroutines** + a **microtask queue** — no closures needed, because the only continuations
are internal coroutine handles. Ordering matches Node/V8 byte-for-byte (verified in the e2e cases).

- **Async function → coroutine.** `emitFunction`/`emitMethodDef` set `curAsync = fn.async`. The
  declared return type is the promise type, so `retSlotType`→`cppType` gives `tsn_promise<…>` (the
  coroutine return type, which carries a `promise_type`). A `return` becomes `emitAsyncReturn` →
  `co_return <value>` against the promise's **resolved** type (curReturn is `Promise<T>`, so the
  value is checked against `T`, not the promise); numbers store in the f64 rep. Returning a
  `Promise<T>` from a `Promise<T>` function **adopts** it (`co_return co_await …`, JS flattening).
  A **void** async coroutine (`Promise<void>`) gets a trailing `co_return tsn_unit{};`
  (`emitAsyncVoidTail`) — both to make it a coroutine when the body has no other `co_return` and to
  satisfy the fall-off-the-end path.
- **`await` → `co_await`** (`emitAwait`). On a `Promise<T>` it's `co_await (p)` yielding `T`
  (f64 for numbers); on a non-promise it wraps in `tsn_resolve(v)` so the one-tick deferral still
  happens (JS `await 5`). Valid inside any async function/method **and at the entry's top level**
  (see the next bullet); a void-promise await is statement-only (`emitStmt`'s `exprStmt` routes an
  `await` node through `emitAwait`), used as a value it's a clean error.
- **Top-level `await`.** When the entry's top-level statements contain an `await` (`stmtContainsAwait`),
  `emitMain` routes to `emitTopLevelCoroutine`: the whole top-level becomes a coroutine
  `tsn_promise<tsn_unit> tsn_top_level()` (`curAsync = true`, `funcKey = MAIN_KEY` so rep slots match
  `repr.ts`), and `main()` runs the dependency inits, *starts* `tsn_top_level()` (it runs to its first
  await), then `tsn_run_microtasks()`. Promoted globals stay file-scope (declared at namespace scope,
  assigned inside the coroutine). Gated on an actual top-level `await`, so non-TLA `main()` is
  byte-identical. Top-level `await` in an **imported** module is rejected in `emitDepInit` (its init()
  isn't a coroutine — the full async-module-graph is out of subset).
- **`Promise.resolve` / `Promise.all`** (`promiseResolve` / `promiseAll` nodes) → `tsn_resolve(v)`
  (identity if `v` is already a promise) / `tsn_all(ps)` (a runtime coroutine that awaits each input
  in order → a `T[]`). `Promise.reject`/`race`/`any`/`allSettled` and `new Promise(executor)` are
  clean `tsnc:` errors (lowering).
- **The event loop.** `emitMain` appends one `tsn_run_microtasks();` after the synchronous top-level
  — **gated on `this.usesAsync`** (any function/method is async), so a non-async program's `main()`
  is byte-identical to the pre-async output. No timers/IO ⇒ the microtask queue is the entire loop.
- **Runtime** ([cpp/tsn_runtime.h](cpp/tsn_runtime.h)): `tsn_promise<T>` (a `promise_type` with
  `initial_suspend`/`final_suspend` = `suspend_never` so the body runs synchronously until the first
  `await` and the frame self-destroys at the end; `await_ready` always false so `await` defers ≥1
  tick; settling schedules waiters as microtasks) + `tsn_promise_state<T>` (the `shared_ptr`ed state
  that outlives the frame). **Rejection** reuses the string-only `throw`: `unhandled_exception`
  rejects, `await_resume` re-throws the `tsn_str` (an ordinary `catch (const tsn_str&)` handles it;
  `finally`'s RAII guard still runs across a `co_await`).
- **Lambda-body limitation.** `await` can't appear inside a construct codegen lowers to a C++
  **lambda body** — the operand-returning `&&`/`||` IIFE and `Array.fill`'s index args — since a
  lambda isn't a coroutine. `containsAwait` detects this and raises a clean `tsnc:` error (assign the
  awaited value first). `await` in IIFE *arguments* (e.g. the receiver of a chainable method, or
  `JSON.parse(await …)`) is fine — it's evaluated in the enclosing coroutine, not the lambda.

## fetch / Response

`fetch(url)` → `Promise<Response>`, faithfully `await`-able, built on the async runtime above. The
microtask loop has **no async I/O**, so `fetch` does a **blocking** libcurl GET and returns an
*already-settled* promise (`tsn_fetch` calls `tsn_resolve`/`tsn_reject`); `await_ready` being false
keeps the one-tick deferral, so JS ordering still holds.

- **`fetch` node** → `tsn_fetch(url)` (verifies the URL is a string). The runtime
  ([cpp/tsn_runtime.h](cpp/tsn_runtime.h)) buffers the body, then resolves `tsn_rc<tsn_response>{
  status, ok = 200..=299, body }`; a **transport error rejects** (so `await` throws the reason
  string, catchable by `try`/`catch`), while an **HTTP error status resolves** with `ok === false`
  (matching real fetch). The curl include + `tsn_fetch` are `#ifdef TSN_ENABLE_FETCH`.
- **`Response` is a built-in reference type** (`isResponse`, like Map/Set). `res.status`/`res.ok` are
  emitted as member loads in `emitExpr`'s `member` case; `res.text()` dispatches in `emitMethodCall`
  (`emitResponseMethod`) to `tsn_resolve((res)->body)` (a `Promise<string>`).
- **`json()`** is `Promise<any>`, which the subset can't represent, so the **target type is required**
  (idiomatic TS): lowering captures it from `await res.json() as T` (a new `as`-expression form) or an
  annotated target (`const x: T = await res.json()`) into a `responseJson { receiver, type }` node;
  emit reuses `extractJson` to parse `(res)->body` into `T`, wrapped in `tsn_resolve` → a `Promise<T>`.
  A bare `res.json()` (no target) reaches `emitResponseMethod` and is a clean `tsnc:` error.
- **`usesFetch` gate** (parallel to `usesAsync`): set when a `fetch`/`responseJson`/`res.text()` is
  emitted. It prepends `#define TSN_ENABLE_FETCH 1` before the runtime `#include`, and the driver
  threads it out of `emit(mod) → { cpp, usesFetch }` to add `-lcurl` to the clang link. A non-fetch
  program emits neither and links exactly as before. `console.log(res)` works via a `tsn_inspect`
  overload (`Response { status: N, ok: B }`). **Deferred** (clean errors): request options
  (`fetch(url, {…})` — caught at stage 0 by the one-arg ambient signature), `res.headers`/`blob()`/
  `statusText`, GET only.

## Union types & narrowing

A union `A | B | …` compiles to **`tsn_union<…>`** — a thin `std::variant` wrapper (runtime header).
The wrapper (not a bare `std::variant`) is what makes our `tsn_inspect` / `tsn_json_stringify` /
`tsn_truthy` / `tsn_typeof` overloads resolve by **ADL** even for an all-scalar union like
`number | string` (whose alternatives have no associated namespace of ours). `null` / `undefined`
are empty tag structs `tsn_null` / `tsn_undefined`.

- **Type identity / canonical order.** Lowering canonicalizes a union's members (flatten/dedupe/
  collapse/sort). `cppType` then re-sorts the C++ alternatives by their **final** (post-rename) type
  text, with `undefined`/`null` first (`unionMemberCpps`). So two structurally equal unions emit
  byte-identical `tsn_union<…>` (rename-stable — the module `Renamer` can mangle a class member's
  name without reordering the variant), and the variant's **default alternative** is the JS-correct
  value for a `Map.get` miss on a `T | undefined` / `T | null` value type.
- **Assignability vs. equality.** `isAssignable(target, source)` allows a **member → union** widen
  and a **narrower → wider union** widen (top-level only — nested element unions must match
  structurally). It drives `coerceTo`, which constructs the variant with explicit
  `std::in_place_type<Member>` (dodging `std::variant`'s `double`-vs-`bool` ctor ambiguity) and uses
  `tsn_union_widen<Wider>(u)` (a runtime `std::visit` re-wrap) for union→union. `coerceTo` is applied
  at every value-flow site (`let`/`assign`/`return`/async return/args/dep-init field). **Equality**
  is separate (`emitUnionEquality`): `u === member` is `holds_alternative<M> && get<M> == m` (single-
  eval of `u` via an IIFE), `u === u` (same canonical type) compares the underlying variants;
  `!==` negates. `console.log` of a union routes through `tsn_console_union` — the active member
  printed with **top-level** semantics (a string bare, like a top-level string; else `tsn_inspect`).
- **Flow narrowing (`analyzeGuard` + `this.narrowed`).** Narrowing is done **in the emitter**, not by
  threading the checker — stage 0 (real TS) already proved the program correct under TS narrowing, so
  the emitted `std::get<Member>` is sound (no runtime variant-access check). `this.vars` keeps the
  *declared* union; `this.narrowed` overrides it for reads inside a guarded region. `analyzeGuard`
  recognizes the v1 forms: `typeof x === "lit"` (and `!==`), `x === null`/`undefined` (and `!==`),
  bare truthiness `x` / `!x` (drops null/undefined), and a boolean-`&&` chain over the same variable.
  The `if`/ternary emitters install the positive narrowing for the then-branch and the negative for
  the else via `withNarrowed` (save/run/restore); `&&`/`||` narrow their right operand by the left's
  guard. **Early-return narrowing**: when a then-block always exits (`alwaysExits`) and there's no
  `else`, the negative narrowing is installed for the rest of the enclosing block — `emitBlock`
  snapshots/restores `this.narrowed` so it doesn't leak past the block. A narrowed read (the `var`
  case) emits `std::get<Member>((x).v())` when narrowed to one member (else keeps the variant, typed
  as the smaller union); **reassigning** a narrowed var drops its narrowing. `typeof e` itself is a
  first-class `string` (`tsn_typeof` via `std::visit` for a union; `staticTypeof` otherwise).
- **Optional parameters** `(a?: T)` are `T | undefined` (lowering); `checkArgs` allows omitted
  trailing optionals (arity is `min..max`, `min` = first optional param) and appends a
  `tsn_undefined{}` default. `emitCall` shares `checkArgs`.
- **Deferred (clean `tsnc:` errors / structural-only):** optional object **fields** (`{ x?: T }` —
  need object-literal field-defaulting + nested coercion), a **ternary** whose branches have
  different types (no union-merge), and union-typed **array/Map/Set element** coercion. Member access
  / arithmetic on an *un-narrowed* union is caught at stage 0 (TS), never miscompiled.

## Guard clauses

Type errors (wrong assignment/argument/return types, undeclared names, bad property access) are
caught earlier by the stage-0 `ts.Program` type checker ([../frontend/check.ts](../frontend/check.ts))
and never reach codegen. The emitter still throws a clear `Error` (→ `tsnc: <message>`) for
constructs the subset doesn't lower: string concatenation of incompatible types, arithmetic on
aggregates, indexing a non-array, an empty array literal with no annotation, void-as-value (incl.
`Map`/`Set.clear()` as a value), an **unknown class** (`new X` / a `: X` annotation with no class
`X`), an **unknown method/field** on a class/Map/Set, a **`JSON.parse`/`JSON.stringify` target that
is a class/Map/Set type** (`assertJsonType` / the `jsonStringify` guard), `Map.forEach`/`entries`
and `for…of` over a Map (need closures / tuples), and **bare `this`** used as a value.
(`console.log` of an array/object/instance/Map/Set is supported — see *Printing* — and `===`/`!==`
on reference types is identity, not an error.) Lowering ([../frontend/lower.ts](../frontend/lower.ts))
adds two more: a bare `JSON.parse(x)` with no target type, and a general `as T` assertion (only
`JSON.parse(text) as T` is accepted).
