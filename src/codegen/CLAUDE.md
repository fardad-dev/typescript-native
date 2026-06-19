# src/codegen/ — C++ emission (stage 3)

[emit.ts](emit.ts) lowers the internal IR ([../ir/nodes.ts](../ir/nodes.ts)) to **C++ source
text**. `emit(mod): string` returns the full `.cpp`. C++ is a high-level target, so this is
**expression-based**: `emitExpr` returns a C++ expression string and we let `clang++` do the
real lowering — no SSA temporaries or pointer bookkeeping here.

## Type mapping (`cppType`)

| tsn type            | C++ type             | notes                                                  |
| ------------------- | -------------------- | ------------------------------------------------------ |
| `number`            | `double`             | IEEE f64; `%` → `std::fmod`; printed via `tsn_num_to_string` |
| `boolean`           | `bool`               | `std::cout` prints `1`/`0`                             |
| `string`            | `std::string`        | literals are `const char*`, convert implicitly         |
| `T[]`               | `std::vector<T>`     | `.length` → `static_cast<double>(v.size())`; `.push()` → `push_back`; index cast to `std::size_t` |
| `{ ... }`           | generated `struct`   | `structName()` dedupes by field shape                  |

A `Value` is `{ code, type }` — the C++ expression text and its tsn `Type`. No length
tracking is needed anymore (arrays are real `std::vector`s).

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
- Integer literals get an `LL` suffix (`2LL`) to stay 64-bit.
- `let` declares with the **initializer's** type (`cppType(init.type)`), so aggregates get
  their literal's exact `vector`/`struct` shape.
- `console.log` → `std::cout << <expr> << "\n"`.
- Object literals become `structName{...}`; arrays become `std::vector<T>{...}`.
- `cppStringLiteral` encodes JS strings as C++ literals (escape `"`/`\`/controls; other bytes
  as 3-digit octal `\ooo`, which is bounded — unlike `\x`).
- `emitCall(e, asStatement)` — a `void` call is valid only in statement position.
- Helpers: `cppType`/`retType`/`structName`, `sameType` (structural, order-independent for
  objects), `displayType` (error messages), `isArray`/`isObject`/`isAggregate`.

## Guard clauses

Unsupported constructs throw a clear `Error` (→ `tsnc: <message>`) instead of emitting bad
C++: string concatenation, arithmetic on aggregates, `console.log` of an array/object,
indexing a non-array, missing/duplicate fields, type-mismatched assignment, wrong arg
count/type, missing `return`. Several of these (concat, aggregate params) are now trivial to
*enable* given the C++ target — but they stay guarded until intentionally added.
