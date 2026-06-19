# src/ir/ — the internal IR

[nodes.ts](nodes.ts) defines our small, typed intermediate representation. It is the
**contract** between the front-end (which produces it) and codegen (which consumes it).
Both sides `switch` on the `kind` discriminant, so TypeScript flags every site when a node
is added or changed.

## The definitions

- **`Type`** — `"number" | "boolean" | "string"` plus two aggregate shapes and a class instance:
  - `{ kind: "array"; element: Type }`
  - `{ kind: "object"; fields: Field[] }` where `Field = { name; type }`
  - `{ kind: "class"; name: string }` — a named class instance (a *reference* type; codegen
    compiles it to `std::shared_ptr<C>`, distinct from the value-typed aggregates above)
- **`BinaryOp`** — `"+" | "-" | "*" | "/" | "%"`.
- **`Expr`** (discriminated union) — `num`, `bool`, `str`, `var`, `binary`, `array`, `index`,
  `object`, `member` (covers `obj.field` and `arr.length`), `call`, `methodCall`, `new`
  (`new C(args)`), `this`.
- **`Stmt`** — `let`, `log`, `return`, `exprStmt` (a bare expression evaluated for effect).
- **`RetType`** — `Type | "void"` (functions may return nothing; values never have `void` type).
- **`Param`**, **`Func`** (`name`, `params`, `returnType`, `body`).
- **`Method`** (a `Func` minus the implicit receiver) and **`ClassDecl`** (`name`, `fields`,
  `ctor: { params; body }`, `methods`). One constructor; inheritance/static/accessors not modeled.
- **`Module`** — `{ classes: ClassDecl[]; functions: Func[]; main: Stmt[] }`. `main` is the
  top-level program body → C++ `main()`.

## Design notes

- **Arrays carry only their element type**, not a length. Length is *value-level* — arrays
  compile to `std::vector`, so `.length` is `.size()` at runtime, not encoded in the `Type`.
- **Objects carry their fields in declaration order**, and that order **is** the struct layout
  used by codegen. Type *equality* is structural and order-independent, but the stored layout
  follows the object literal.
- `member` is intentionally generic (`{ obj, name }`); codegen resolves it to an array/string
  `length`, an object field load, or a class field load based on the value's type. Likewise
  `methodCall` dispatches on the receiver type (string/array helper vs instance method).
- **Class instances are *reference* types**, the one non-value `Type`. `this` is only valid as
  `this.field` / `this.method()` (bare `this` as a value isn't modeled yet). The `class` `Type`
  carries just the name; the layout/methods live in the `ClassDecl` (looked up by name in codegen).

## When adding a feature

Add the node here **first**. Then both [../frontend/lower.ts](../frontend/lower.ts) (produce)
and [../codegen/emit.ts](../codegen/emit.ts) (consume) must handle it — the non-exhaustive
`switch` errors will guide you.
