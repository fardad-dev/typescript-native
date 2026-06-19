# src/codegen/ — C++ emission (stage 3)

[emit.ts](emit.ts) lowers the internal IR ([../ir/nodes.ts](../ir/nodes.ts)) to **C++ source
text**. `emit(mod): string` returns the full `.cpp`. C++ is a high-level target, so this is
**expression-based**: `emitExpr` returns a C++ expression string and we let `clang++` do the
real lowering — no SSA temporaries or pointer bookkeeping here.

## Type mapping (`cppType` / `slotType`)

| tsn type            | C++ type             | notes                                                  |
| ------------------- | -------------------- | ------------------------------------------------------ |
| `number`            | `double` or `long long` | f64 by default; integer-valued slots use the `i64` rep (`long long`) — see below. `cppType` returns `double` (the rep used for nested aggregates); `slotType` honors the slot's rep |
| `boolean`           | `bool`               | `std::cout` prints `1`/`0`                             |
| `string`            | `tsn_str`            | ref-counted immutable string (prelude struct); copy = pointer + refcount bump, so array shuffles don't copy chars. Every string expr is a `tsn_str` (literals too: `tsn_str("…")`); operators (`<` `==` `+` `<<`) and `.str()`/`.size()` are defined on it; methods → `tsn_*` helpers (take `const std::string&` via its conversion; mostly return `tsn_str`, but `split` returns `std::vector<tsn_str>`) |
| `T[]`               | `std::vector<T>`     | `.length` → `static_cast<long long>(v.size())` (i64); `.push()` → `push_back`; `.join(sep?)` → `tsn_join` (`string[]`/`number[]` → `tsn_str`); index cast to `std::size_t` |
| `{ ... }`           | generated `struct`   | `structName()` dedupes by field shape; number fields use the f64 rep |
| class `C`           | `std::shared_ptr<C>` | **reference** type (not an `isAggregate`): `struct C { fields; ctor; methods; }`, instance is a shared_ptr — `new` → `make_shared`, `.field`/`.method()` via `->`. See *Classes* below |

**Aggregates nest.** `T` (array element) and a field type may themselves be aggregates, so
`cppType` recurses: `number[][]` → `std::vector<std::vector<double>>`, `{ pts: number[] }` →
a struct with a `std::vector<double>` member, `{ inner: { x: number } }` → a struct with a struct
member. `structName` registers its own name *before* building members, then `cppType(field)`
triggers inner `structName` calls — so a nested struct is pushed to `structDefs` ahead of the
struct that embeds it (correct C++ declaration order). Element/field values still pass through
`f64SlotCode` (an aggregate value returns as-is; only `i64`-rep *numbers* get the `double` cast),
and nested numbers stay f64. The only blocks were two scalar-field guards (one in `lowerType`, one
in the object-literal emitter) — both removed.

A `Value` is `{ code, type, rep? }` — the C++ expression text, its tsn `Type`, and (for
`number`) its representation `"i64"`/`"f64"`. No length tracking is needed (arrays are real
`std::vector`s).

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

## The `Emitter` class

- **Module-level:** `sigs` (function signatures, collected first so calls can reference
  any function), `structDefs` + `structNames` (generated structs, deduped by field shape).
- **Per-function scratch (reset by `resetForFunction`):** `body` (emitted statement lines),
  `vars` (name → `Type`), `curReturn`, `terminated` (set on `return`; stops emitting after it,
  since there's no control flow yet).
- Output shape: `#include`s → struct defs → function prototypes (so order/recursion is fine)
  → function definitions → `int main()` (top-level statements + `return 0`).

## Conventions (match these)

- **Expression-based:** build C++ expressions; fully parenthesize binary ops
  (`(${l} ${op} ${r})`) to preserve precedence.
- A safe-integer literal emits as `i64` (`2` → `2LL`); a fractional/large one as a `double`
  literal (`2.5`, `1e21`, `2` → `2.0`).
- `let` declares with the **initializer's** type, but a `number` slot's C++ type comes from its
  rep (`slotType`), not `cppType` — so a demoted slot is `double` even with an `i64` initializer
  (the `i64` literal widens in). Aggregates still get their literal's exact `vector`/`struct` shape.
- `console.log` → `std::cout << <expr> << "\n"`.
- Object literals become `structName{...}`; arrays become `std::vector<T>{...}`. Element/field
  values pass through `f64SlotCode`: those slots are always `double`, so an `i64`-rep value is
  cast (`static_cast<double>(…)`) — a brace-init list narrows a *non-constant* `long long`→`double`
  and clang rejects it (a literal constant like `3LL` narrows legally, which is why literal-only
  aggregates never tripped it).
- `cppStringLiteral` encodes JS strings as C++ literals (escape `"`/`\`/controls; other bytes
  as 3-digit octal `\ooo`, which is bounded — unlike `\x`).
- `emitCall(e, asStatement)` — a `void` call is valid only in statement position.
- Helpers: `cppType`/`retType`/`structName`, `sameType` (structural, order-independent for
  objects), `displayType` (error messages), `isArray`/`isObject`/`isAggregate`.

## Function boundaries (params & returns)

Functions take and return aggregates (arrays/objects), not just scalars:

- **Params:** `paramType` passes scalars by value (a `tsn_str` copy is just a refcount bump) and
  **aggregates by `const&`** — no per-call copy of a whole `vector`/`struct`. The `const` also
  makes aggregate params **read-only**: `emitFunction` records their names in `readonlyParams`,
  and `assertMutable` (called from `emitLValue` and the `push` branch) rejects `xs.push(v)` /
  `xs[i] = v` / `xs.f = v` / `xs = …` with a clean `tsnc:` message. This is deliberate — JS shares
  arrays/objects by reference, so a callee mutation would be visible to the caller; value
  semantics can't express that, so we fail loudly rather than silently diverge. To mutate, copy
  into a local first (`let ys = xs`).
- **Returns:** `retSlotType` returns aggregates **by value**. `return xs;` (a named local) is
  NRVO and `return {…}` is RVO, so no extra copy is made; a copy materializes only where the
  result is bound (`let r = f()` → elision) or consumed — never gratuitously. Returning a `const&`
  param does copy (you can't move from a const ref), but that's a rare, semantically-needed copy.

## Classes

A class compiles to `struct C { fields; C(ctor); methods; };` and an **instance** to
`std::shared_ptr<C>` (`cppType`). This is the roadmap's "heap + ref-counted" representation, and JS
reference semantics fall out for free: copy/assign shares the pointee (aliases see each other's
mutations), `===` is `shared_ptr::operator==` (identity), and the refcount frees the instance.

- **Emission order** (`emitModule`): forward-declare every class (`struct C;`) → object structs
  (`structDefs`) → class struct definitions (`emitClassStruct`: field members + ctor/method
  **declarations**) → out-of-line **definitions** (`emitClassDefs` → `emitCtorDef`/`emitMethodDef`)
  → functions → main. Forward decls let a field reference a later/self class via `shared_ptr`; the
  out-of-line bodies see every class complete. Building a class struct calls `cppType` on field
  types, which lazily generates any object structs they need (placed earlier, so the order holds).
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
- **Params: by value, mutable.** An instance is **not** an `isAggregate`, so `paramType` passes it
  by value (`std::shared_ptr<C>` — a refcount bump, not marked `readonly`). Mutation through the
  param (`p.x = …`) is allowed and visible to the caller — correct JS reference semantics, the
  opposite of the read-only `const&` array/object params above. `new`/method args are type-checked
  by the shared `checkArgs` (no per-arg `f64SlotCode` cast — reps are reconciled by `repr.ts`).

## Guard clauses

Unsupported constructs throw a clear `Error` (→ `tsnc: <message>`) instead of emitting bad
C++: string concatenation of incompatible types, arithmetic on aggregates, `console.log` of an
array/object/**class instance**, indexing a non-array, missing/duplicate fields, type-mismatched
assignment, wrong arg count/type, missing `return`, **mutating a `const&` aggregate param** (see
Function boundaries above), an **unknown class** (`new X` / a `: X` annotation with no class `X`),
an **unknown method/field** on a class, and **bare `this`** used as a value. Concat of unsupported
types stays trivial to *enable* given the C++ target, but is guarded until intentionally added.
