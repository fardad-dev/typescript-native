# src/ir/ — the internal IR

[nodes.ts](nodes.ts) defines our small, typed intermediate representation. It is the
**contract** between the front-end (which produces it) and codegen (which consumes it).
Both sides `switch` on the `kind` discriminant, so TypeScript flags every site when a node
is added or changed.

## The definitions

- **`Type`** — `"number" | "boolean" | "string"` plus two aggregate shapes:
  - `{ kind: "array"; element: Type }`
  - `{ kind: "object"; fields: Field[] }` where `Field = { name; type }`
- **`BinaryOp`** — `"+" | "-" | "*" | "/" | "%"`.
- **`Expr`** (discriminated union) — `num`, `bool`, `str`, `var`, `binary`, `array`, `index`,
  `object`, `member` (covers both `obj.field` and `arr.length`), `call`.
- **`Stmt`** — `let`, `log`, `return`, `exprStmt` (a bare expression evaluated for effect).
- **`RetType`** — `Type | "void"` (functions may return nothing; values never have `void` type).
- **`Param`**, **`Func`** (`name`, `params`, `returnType`, `body`).
- **`Module`** — `{ functions: Func[]; main: Stmt[] }`. `main` is the top-level program body
  → LLVM `@main`.

## Design notes

- **Arrays carry only their element type**, not a length. Length is *value-level* — our arrays
  are stack-allocated with a compile-time-known size, tracked alongside the value in codegen
  (see the `Value.length` field there), not encoded in the `Type`.
- **Objects carry their fields in declaration order**, and that order **is** the struct layout
  used by codegen. Type *equality* is structural and order-independent, but the stored layout
  follows the object literal.
- `member` is intentionally generic (`{ obj, name }`); codegen resolves it to either an array
  `length` constant or an object field load based on the value's type.

## When adding a feature

Add the node here **first**. Then both [../frontend/lower.ts](../frontend/lower.ts) (produce)
and [../codegen/emit.ts](../codegen/emit.ts) (consume) must handle it — the non-exhaustive
`switch` errors will guide you.
