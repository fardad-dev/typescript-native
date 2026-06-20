# src/codegen/ — C++ emission (stage 3)

[emit.ts](emit.ts) lowers the internal IR ([../ir/nodes.ts](../ir/nodes.ts)) to **C++ source
text**. `emit(mod): string` returns the full `.cpp`. C++ is a high-level target, so this is
**expression-based**: `emitExpr` returns a C++ expression string and we let `clang++` do the
real lowering — no SSA temporaries or pointer bookkeeping here.

## The runtime header (`cpp/tsn_runtime.h`)

The program-**independent** C++ — `tsn_str`, the JS-semantics numeric/string/array helpers
(`tsn_mod`, `tsn_substring`, `tsn_push`, …), and the scalar + array-template `tsn_inspect`
overloads — lives as **real, editable C++** in [cpp/tsn_runtime.h](cpp/tsn_runtime.h), not as a
string in `emit.ts`. Every emitted `.cpp` is just `#include "<abs>/tsn_runtime.h"` on top,
followed by the program-**dependent** code `emit` generates (per-object-shape structs, the
per-type `tsn_inspect` overloads that know field names, the user's functions, `main`).

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
| `string`            | `tsn_str`            | ref-counted immutable string (prelude struct); copy = pointer + refcount bump, so array shuffles don't copy chars. Every string expr is a `tsn_str` (literals too: `tsn_str("…")`); operators (`<` `==` `+` `<<`) and `.str()`/`.size()` are defined on it; methods → `tsn_*` helpers (take `const std::string&` via its conversion; mostly return `tsn_str`, but `split` returns a `std::shared_ptr<std::vector<tsn_str>>`) |
| `T[]`               | `std::shared_ptr<std::vector<T>>` | **reference** type (`vecType` = the pointee `std::vector<T>`): literals `make_shared`, `let b = a` aliases, `===` is identity. `.length` → `(a)->size()` (i64); index derefs: `(*(a))[i]` (cast to `std::size_t`); methods run on `*recv`: `push`→`tsn_push` (new length, f64), `pop`→`tsn_pop` (element; empty → `T()`), `slice`→`make_shared(tsn_array_slice(...))` (new array), `indexOf`→`tsn_array_index_of` (f64, `==` on `T`), `join`→`tsn_join` (`string[]`/`number[]` → `tsn_str`) |
| `{ ... }`           | `std::shared_ptr<struct>` | **reference** type: `structName()` dedupes the pointee struct by field shape; literals `make_shared<struct>(struct{...})`, field access `obj->f`, number fields use the f64 rep |
| class `C`           | `std::shared_ptr<C>` | **reference** type: `struct C { fields; ctor; methods; }`, instance is a shared_ptr — `new` → `make_shared`, `.field`/`.method()` via `->`. See *Classes* below |

Arrays, objects and class instances are now **all reference types** (`std::shared_ptr<…>`), so JS
semantics hold uniformly: copy/assign aliases, mutation through one alias is visible through the
others, params are mutable (a `shared_ptr` copy aliases the caller's value), and `===`/`!==` is
pointer identity. `isAggregate` (array||object) still distinguishes object/array *literals* from
class instances where lowering/printing differs, but no longer implies a value type.

**Aggregates nest.** `T` (array element) and a field type may themselves be aggregates, so
`cppType` recurses: `number[][]` → `std::shared_ptr<std::vector<std::shared_ptr<std::vector<double>>>>`,
`{ pts: number[] }` → a struct with a `std::shared_ptr<std::vector<double>>` member,
`{ inner: { x: number } }` → a struct whose member is a `shared_ptr` to another struct. Because
struct *members* are now `shared_ptr`s (pointers to incomplete types are fine), struct order no
longer needs inner-before-outer — every struct is forward-declared (`struct tsn_ObjN;`) up front.
Element/field values still pass through `f64SlotCode` (an aggregate value returns as-is; only
`i64`-rep *numbers* get the `double` cast), and nested numbers stay f64.

A `Value` is `{ code, type, rep? }` — the C++ expression text, its tsn `Type`, and (for
`number`) its representation `"i64"`/`"f64"`. No length tracking is needed (arrays are real
`std::vector`s behind a `shared_ptr`).

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
  `shared_ptr` copy: a refcount bump that **aliases** the caller's value, so a callee mutation
  (`xs.push(v)`, `xs[i] = e`, `obj.f = e`) is visible to the caller — correct JS semantics. The old
  read-only-param apparatus (`readonlyParams` / `assertMutable` / `rootVarName`) is **gone**; there
  is no longer any mutation-through-param to reject.
- **Returns:** `retSlotType` returns a reference type by value — a `shared_ptr`, i.e. the shared
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
  `DepModule` to `std::shared_ptr<tsn_ObjN> tsn_modN_init()` with `static rec; if (rec) return rec;
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
`std::shared_ptr<C>` (`cppType`). This is the roadmap's "heap + ref-counted" representation, and JS
reference semantics fall out for free: copy/assign shares the pointee (aliases see each other's
mutations), `===` is `shared_ptr::operator==` (identity), and the refcount frees the instance.

- **Emission order** (`emitModule`): forward-declare every class and object struct → object struct
  defs (`structDefs`) → class struct definitions (`emitClassStruct`: field members + ctor/method
  **declarations**) → out-of-line **definitions** (`emitClassDefs` → `emitCtorDef`/`emitMethodDef`)
  → functions → main (with the inspect fwd-decls/defs interleaved — see *Printing*). Forward decls
  let any type reference any later/self type via `shared_ptr`; the out-of-line bodies see every type
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
  `(code)->name` because both `shared_ptr<C>` and the raw `this` pointer use `->`. Bare `this` as a
  value is rejected (the `emitExpr` `case "this"` throws) — only `this.field` / `this.method()`.
- **Params: by value, mutable** — like every parameter now (see *Function boundaries*). An instance
  passes as a `std::shared_ptr<C>` copy (a refcount bump); mutation through the param (`p.x = …`) is
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
- **Array template** (`arrayInspectDef`): `tsn_inspect(const shared_ptr<vector<T>>&)` → `[ e0, e1 ]`,
  recursing on each element.
- **Per-struct / per-class overloads** (`aggregateInspectDefs` / `inspectBody`): one function per
  generated object struct (`{ k: v, ... }`) and per class (`Name { k: v, ... }`), knowing the field
  names (struct fields recorded in `structFields` during `structName`).

Ordering in `emitModule`: the scalar prelude + the array template's *forward declaration* come
first; then class/struct forward decls; then the per-type inspect forward decls; then the full
struct/class defs; then the array-template + per-type inspect *definitions* (every type complete by
now). Caveat: always single-line (no Node `breakLength` wrapping) — matches Node for small values.

## Guard clauses

Type errors (wrong assignment/argument/return types, undeclared names, bad property access) are
caught earlier by the stage-0 `ts.Program` type checker ([../frontend/check.ts](../frontend/check.ts))
and never reach codegen. The emitter still throws a clear `Error` (→ `tsnc: <message>`) for
constructs the subset doesn't lower: string concatenation of incompatible types, arithmetic on
aggregates, indexing a non-array, an empty array literal with no annotation, void-as-value, an
**unknown class** (`new X` / a `: X` annotation with no class `X`), an **unknown method/field** on a
class, and **bare `this`** used as a value. (`console.log` of an array/object/instance is now
supported — see *Printing* — and `===`/`!==` on arrays/objects is reference identity, not an error.)
