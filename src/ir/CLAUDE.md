# src/ir/ — the internal IR

[nodes.ts](nodes.ts) defines our small, typed intermediate representation — the **contract** between
the front-end (which produces it) and codegen (which consumes it). Both sides `switch` on the `kind`
discriminant, so TypeScript flags every site when a node is added or changed.

## The definitions

- **`Type`** — `"number" | "boolean" | "string" | "null" | "undefined"` plus composite shapes:
  - `{ kind: "union"; members: Type[] }` — `A | B`. Members are **canonicalized** in lowering
    (flattened/deduped/collapsed/sorted) so `number | string` ≡ `string | number`. Codegen → `tsn_union<…>`.
  - `{ kind: "array"; element }`, `{ kind: "object"; fields: Field[] }` (`Field = { name; type }`),
    `{ kind: "class"; name }`, `{ kind: "map"; key; value }` / `{ kind: "set"; element }`.
  - `{ kind: "promise"; value? }` — `Promise<T>`; `value` absent = `Promise<void>`.
  - `{ kind: "response" }` — the `Response` of a `fetch(...)`.
  - `{ kind: "function"; params: Type[]; ret: RetType; restParam? }` — a first-class function value.
    `restParam: true` ⇒ the last `params` entry is a rest parameter; an optional param surfaces as
    `T | undefined`.
  - Codegen compiles **all** composite shapes (array, object, class, map, set, response, function) to
    `tsn_rc<…>` reference types — the `Type` union doesn't encode value-vs-reference; that's a codegen
    decision. (A `promise` is a `tsn_promise<…>` handle.)
- **`BinaryOp`** — `"+" | "-" | "*" | "/" | "%"`.
- **`Expr`** (discriminated union) — `num`, `bool`, `str`, `var`, `binary`, `ternary`, `unary`,
  `array`, `index`, `object`, `member` (covers `obj.field`, `arr.length`, `map/set.size`), `call`,
  `methodCall`, `new`, `this`, `jsonStringify`, `jsonParse` (`{ text; type }` — the parse target type),
  `mathCall`/`mathConst`, `mapNew`/`setNew`, the async trio `await`/`promiseResolve`/`promiseAll`, the
  fetch pair `fetch`/`responseJson` (`{ receiver; type }`), the `null`/`undefined` literals, `typeof`
  (a `string`; in a guard it drives narrowing), `closure` (`{ params; returnType?; body; async; id? }` —
  `returnType` absent ⇒ inferred at codegen; `id` set by the closure pass), `callValue`
  (`{ callee; args }` — calling a function *value*), and `spread` (`{ arg }` — valid only inside an
  `array` literal or a call's argument list).
- **`Stmt`** — `let`, `log`, `return`, `exprStmt`, `assign`, and control flow: `if`, `while`, `for`,
  `doWhile`, `forOf` (`{ name; iterable; body }`), `forIn` (`{ name; target; body }`), `switch`
  (`{ disc; cases }`, `SwitchCase = { test?; body }`, `test` absent = default), `break`/`continue`
  (optional `label`), `labeled` (`{ label; body }`), `throw` (`{ value }`, a string), and `try`
  (`{ block; catchName?; catchBody?; finallyBody? }`). `switch` + labeled break/continue lower to
  `goto`s in codegen. Several binding sites carry an optional **`boxed`** flag (`let`, `Param`,
  `forOf`/`forIn`, a `try`'s `catchBoxed`), set by the closure pass when captured by a nested closure.
- **`RetType`** — `Type | "void"`. An `async` function's `returnType` is a `promise` `Type`.
- **`Param`** (`name`, `type`, optional `boxed`/`default`/`rest`). `default?: Expr` ⇒ a default param
  (`type` is the declared `T`; codegen receives `T | undefined` and resolves the default at entry).
  `rest?: true` ⇒ a rest param (`type` is the array). Destructuring params have no IR form — lowering
  desugars them.
- **`Func`** (`name`, `params`, `returnType`, `body`, `async`), **`Method`** (a `Func` minus the
  implicit receiver), **`ClassDecl`** (`name`, `fields`, `ctor`, `methods` — one constructor;
  inheritance/static/accessors not modeled).
- **`Module`** — `{ classes; functions; main: Stmt[] }`. `main` is the top-level program body → C++
  `main()`.

## Design notes

- **Arrays carry only their element type**, not a length (length is value-level — arrays compile to
  `std::vector` behind a `tsn_rc`).
- **Objects carry their fields in declaration order**, and that order **is** the struct layout. Type
  *equality* is structural and order-independent, but the stored layout follows the literal.
- `member` and `methodCall` are intentionally generic; codegen resolves them on the receiver's type.
- **Arrays, objects, class instances, Maps/Sets are all reference types** in codegen (each holds a
  `tsn_rc<…>`): aliasing, shared mutation, mutable params, identity `===`/`!==`. Bare `this` as a value
  isn't modeled (only `this.field` / `this.method()`).

## When adding a feature

Add the node here **first**. Then both [../frontend/lower.ts](../frontend/lower.ts) (produce) and
[../codegen/emit.ts](../codegen/emit.ts) (consume) must handle it — the non-exhaustive `switch` errors
will guide you.
