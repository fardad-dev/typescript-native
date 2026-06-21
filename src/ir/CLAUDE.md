# src/ir/ — the internal IR

[nodes.ts](nodes.ts) defines our small, typed intermediate representation. It is the
**contract** between the front-end (which produces it) and codegen (which consumes it).
Both sides `switch` on the `kind` discriminant, so TypeScript flags every site when a node
is added or changed.

## The definitions

- **`Type`** — `"number" | "boolean" | "string" | "null" | "undefined"` plus aggregate shapes, a
  class instance, the Map/Set containers, and unions:
  - `"null"` / `"undefined"` — unit value types (codegen → empty tag structs `tsn_null` /
    `tsn_undefined`); mostly union members and the optional-`?:` desugar.
  - `{ kind: "union"; members: Type[] }` — `A | B | …`. Members are **canonicalized** in lowering
    (flattened, deduped, single-member collapsed, stable-sorted) so `number | string` ≡
    `string | number`. Codegen → `tsn_union<…>` (a `std::variant` wrapper); a member widens in
    (coercion) and `typeof`/`=== null`/truthiness guards narrow it back (see codegen).
  - `{ kind: "array"; element: Type }`
  - `{ kind: "object"; fields: Field[] }` where `Field = { name; type }`
  - `{ kind: "class"; name: string }` — a named class instance.
  - `{ kind: "map"; key: Type; value: Type }` / `{ kind: "set"; element: Type }` — `Map<K, V>` /
    `Set<T>`. Codegen compiles **all** of these composite shapes (array, object, class, map, set) to
    `tsn_rc<…>` reference types (a non-atomic ref-counted pointer) — the `Type` union doesn't encode
    value-vs-reference; that's a codegen decision.
  - `{ kind: "promise"; value?: Type }` — `Promise<T>` (the result type of an `async` function and a
    first-class value); `value` absent = `Promise<void>`. A reference type too (codegen → the C++20
    coroutine type `tsn_promise<…>`); resolved numbers use the f64 rep.
  - `{ kind: "response" }` — the `Response` of a `fetch(...)` — a built-in reference type
    (codegen → `tsn_rc<tsn_response>`): fields `status`/`ok`, methods `text()`/`json()`.
  - `{ kind: "function"; params: Type[]; ret: RetType }` — a first-class function value
    `(p: T, …) => R` (arrow / function expression / top-level-function reference). A reference type
    (codegen → `std::function<Rc(Pc…)>`); number params/returns use the f64 rep (a context-stable
    signature).
- **`BinaryOp`** — `"+" | "-" | "*" | "/" | "%"`.
- **`Expr`** (discriminated union) — `num`, `bool`, `str`, `var`, `binary`, `ternary`
  (`cond ? whenTrue : whenFalse`; branches share a type = the result type), `unary`, `array`,
  `index`, `object`, `member` (covers `obj.field`, `arr.length`, `map/set.size`), `call`,
  `methodCall`, `new` (`new C(args)`), `this`, `jsonStringify` (`JSON.stringify(arg)`), `jsonParse`
  (`{ text; type }` — the parse target type, since `JSON.parse` is `any` and the subset needs a
  concrete type; carried from a `JSON.parse(text) as T` assertion or an annotated target),
  `mathCall` (`{ fn; args }` — a `Math.<fn>(...)` builtin) / `mathConst` (`{ name }` — `Math.PI`, …),
  `mapNew` (`{ key; value }`) / `setNew` (`{ element; init? }` — `new Set<T>(arr?)`), the async
  trio `await` (`{ expr }` — `co_await`), `promiseResolve` (`{ arg }` — `Promise.resolve`), and
  `promiseAll` (`{ arg }` — `Promise.all`), and the fetch pair `fetch` (`{ url }` — a blocking GET
  returning a settled `Promise<Response>`) / `responseJson` (`{ receiver; type }` — `res.json()` as
  a `Promise<T>`; the target `type` is captured up front since `Response.json()` is `Promise<any>`),
  the `null` / `undefined` literals, `typeof` (`{ operand }` — a `string`; on a union resolved
  at runtime, and as `typeof x === "…"` in a guard it drives flow narrowing in codegen), `closure`
  (`{ params; returnType?; body; async; id? }` — an arrow / function expression; `returnType` absent
  ⇒ inferred at codegen; `id` is set by the closure pass), and `callValue` (`{ callee; args }` —
  calling a function *value*, as opposed to a named `call` or a `methodCall`).
- **`Stmt`** — `let`, `log`, `return`, `exprStmt` (a bare expression evaluated for effect),
  `assign`, and the control-flow statements: `if`, `while`, `for`, `doWhile`, `forOf`
  (`{ name; iterable; body }`), `forIn` (`{ name; target; body }`), `switch` (`{ disc; cases }`
  where `SwitchCase = { test?; body }`, `test` absent = `default`), `break`/`continue`
  (optional `label`), `labeled` (`{ label; body }` — wraps a loop), `throw` (`{ value }`, a
  string), and `try` (`{ block; catchName?; catchBody?; finallyBody? }`). `switch` + labeled
  break/continue are lowered to `goto`s in codegen, not modeled with a value table. Several binding
  sites carry an optional **`boxed`** flag (`let`, `Param`, `forOf`/`forIn`, and a `try`'s
  `catchBoxed`), set by the closure pass when the binding is captured by a nested closure (codegen
  then stores it in a shared `tsn_box` cell).
- **`RetType`** — `Type | "void"` (functions may return nothing; values never have `void` type).
  An `async` function's `returnType` is a `promise` `Type` (`Promise<void>` is a promise with no
  `value` — not `"void"`).
- **`Param`**, **`Func`** (`name`, `params`, `returnType`, `body`, `async`). `async: true` ⇒ codegen
  emits a coroutine (`co_return`/`co_await`).
- **`Method`** (a `Func` minus the implicit receiver — also carries `async`) and **`ClassDecl`**
  (`name`, `fields`, `ctor: { params; body }`, `methods`). One constructor; inheritance/static/
  accessors not modeled.
- **`Module`** — `{ classes: ClassDecl[]; functions: Func[]; main: Stmt[] }`. `main` is the
  top-level program body → C++ `main()`.

## Design notes

- **Arrays carry only their element type**, not a length. Length is *value-level* — arrays
  compile to `std::vector` (behind a `tsn_rc`), so `.length` is `.size()` at runtime.
- **Objects carry their fields in declaration order**, and that order **is** the struct layout
  used by codegen. Type *equality* is structural and order-independent, but the stored layout
  follows the object literal.
- `member` is intentionally generic (`{ obj, name }`); codegen resolves it to an array/string
  `length`, a Map/Set `size`, an object field load, or a class field load based on the value's type.
  Likewise `methodCall` dispatches on the receiver type (string/array/map/set helper vs instance method).
- **Arrays, objects, class instances, Maps/Sets, and Promises are all *reference* types** in codegen
  (each holds a `tsn_rc<…>`, a non-atomic ref-counted pointer): aliasing, shared mutation, mutable
  params, identity `===`/`!==`. (A `promise` is a `tsn_promise<…>` handle wrapping a `std::shared_ptr`
  to its state — the one exception.) `this`
  is only valid as `this.field` / `this.method()` (bare `this` as a value isn't modeled yet). The
  `class` `Type` carries just the name; the layout/methods live in the `ClassDecl` (looked up by
  name in codegen).

## When adding a feature

Add the node here **first**. Then both [../frontend/lower.ts](../frontend/lower.ts) (produce)
and [../codegen/emit.ts](../codegen/emit.ts) (consume) must handle it — the non-exhaustive
`switch` errors will guide you.
