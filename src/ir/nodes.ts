// Internal IR: a small, typed representation lowered from the TypeScript AST.
// Codegen consumes this — never the raw TS AST.

// Arrays carry their element type but not a length — length is a value-level
// property (arrays compile to std::vector; `.length` maps to `.size()`).
// Objects carry their fields in declaration order — that order is the layout.
export type Field = { name: string; type: Type };

export type Type =
  | "number"
  | "boolean"
  | "string"
  // The `null` / `undefined` value types. Each is a *unit* type (one value), used
  // mostly as a union member (`T | null`, `T | undefined`) and as the desugaring of
  // an optional field/param (`x?: T` ⇒ `T | undefined`). Codegen maps them to empty
  // tag structs (`tsn_null` / `tsn_undefined`) so a union variant can discriminate
  // them and so `typeof` differs (`typeof null === "object"` vs `"undefined"`).
  | "null"
  | "undefined"
  | { kind: "array"; element: Type }
  | { kind: "object"; fields: Field[] }
  // An instance of a named class. Like arrays/objects, a class instance is a
  // *reference* type — see codegen (compiles to tsn_rc<C>).
  | { kind: "class"; name: string }
  // `Map<K, V>` / `Set<T>` — reference types backed by an insertion-ordered
  // tsn_map / tsn_set (see codegen). Keys/values/elements may be any value type;
  // numbers are stored in the f64 rep (like array elements / object fields).
  | { kind: "map"; key: Type; value: Type }
  | { kind: "set"; element: Type }
  // `Promise<T>` — the result type of an async function and a first-class value
  // (reference type: a handle to shared promise state). `value` is the resolved
  // type; absent means `Promise<void>` (resolves to nothing / JS `undefined`).
  // `await` on a promise yields its `value`; codegen compiles it to a C++20
  // coroutine type `tsn_promise<…>` (see codegen). Numbers in `value` use the
  // f64 rep (like array elements / object fields).
  | { kind: "promise"; value?: Type }
  // The `Response` of a `fetch(...)` — a built-in reference type (like Map/Set),
  // compiled to `tsn_rc<tsn_response>`. Fields `status: number` /
  // `ok: boolean`; methods `text(): Promise<string>` and `json(): Promise<T>`
  // (the body is buffered, so both return already-resolved promises). See codegen.
  | { kind: "response" }
  // A union `A | B | …`. Members are canonicalized in lowering: nested unions
  // flattened, duplicates removed (by structural equality), a single-member union
  // collapsed to that member, and the members sorted into a stable order (so
  // `number | string` and `string | number` are the *same* type). Codegen maps it
  // to `tsn_union<…>` (a `std::variant`); a member value widens into it (coercion)
  // and `typeof`/`=== null`/truthiness guards narrow it back (see codegen).
  | { kind: "union"; members: Type[] }
  // A first-class function value `(p0: T0, …) => R` — an arrow function, a function
  // expression, or a reference to a top-level function used as a value. Codegen maps
  // it to `std::function<Rc(P0c, …)>` (a reference type); a `number` parameter or
  // return uses the **f64 rep** in the signature (like array elements / promise
  // values), so a function value's C++ type is stable regardless of context.
  // `restParam: true` ⇒ the LAST `params` entry is a **rest** parameter (a `T[]`);
  // callers may pass zero or more trailing `T` args, collected into a fresh array.
  // An **optional** param is encoded as a `T | undefined` member (so it may be
  // omitted at a call); the type carries no separate optional flag.
  | { kind: "function"; params: Type[]; ret: RetType; restParam?: boolean };

export type BinaryOp =
  // arithmetic (number -> number)
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  // relational (number -> boolean)
  | "<"
  | "<="
  | ">"
  | ">="
  // equality (scalar -> boolean)
  | "==="
  | "!=="
  // logical (boolean -> boolean)
  | "&&"
  | "||";

export type Expr =
  | { kind: "num"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "str"; value: string }
  | { kind: "var"; name: string }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr }
  // `cond ? whenTrue : whenFalse`. The two branches must share a type (no union
  // result in the subset), and that's the result type; `cond` is a number/boolean.
  | { kind: "ternary"; cond: Expr; whenTrue: Expr; whenFalse: Expr }
  // `!e` (boolean) and unary `-e` / `+e` (number).
  | { kind: "unary"; op: "!" | "-" | "+"; operand: Expr }
  | { kind: "array"; elements: Expr[] }
  | { kind: "index"; arr: Expr; index: Expr }
  | { kind: "object"; properties: { name: string; value: Expr }[] }
  // member covers both `obj.field` and `arr.length` — the emitter resolves it by type.
  | { kind: "member"; obj: Expr; name: string }
  | { kind: "call"; callee: string; args: Expr[] }
  // a method call like `xs.push(v)` — resolved by receiver type during codegen
  | { kind: "methodCall"; receiver: Expr; method: string; args: Expr[] }
  // `new C(args)` — construct a class instance
  | { kind: "new"; className: string; args: Expr[] }
  // `this` inside a method/constructor (only valid as `this.field`/`this.method()`)
  | { kind: "this" }
  // `JSON.stringify(arg)` — serialize any value to a JSON string.
  | { kind: "jsonStringify"; arg: Expr }
  // `Math.<fn>(args)` — a builtin math call (e.g. `Math.floor(x)`, `Math.pow(a, b)`,
  // `Math.min(...)`). Recognized in lowering (like `JSON.*`), not a method call; the
  // result is always a `number` (f64). `fn` is the method name (`floor`, `min`, …).
  | { kind: "mathCall"; fn: string; args: Expr[] }
  // `Math.<name>` — a builtin math constant (`Math.PI`, `Math.E`, …). A `number`.
  | { kind: "mathConst"; name: string }
  // `new Map<K, V>()` — construct an empty map (entries are added via `.set`).
  | { kind: "mapNew"; key: Type; value: Type }
  // `new Set<T>()` / `new Set<T>(arr)` — construct a set, optionally seeded from
  // an array `init` (the only iterable form the subset supports).
  | { kind: "setNew"; element: Type; init?: Expr }
  // `JSON.parse(text) as T` (or a `T`-annotated target) — parse a JSON string into
  // a value of a statically-known type `T`. JSON.parse is `any` in TypeScript, so
  // the subset requires the target type up front (it can't lower an untyped value).
  | { kind: "jsonParse"; text: Expr; type: Type }
  // `await expr` — suspend the enclosing async function until `expr`'s promise
  // settles, then yield its resolved value (or re-throw its rejection). Only valid
  // inside an async function (a coroutine); compiles to `co_await` (see codegen).
  | { kind: "await"; expr: Expr }
  // `Promise.resolve(arg)` — a promise already fulfilled with `arg` (if `arg` is
  // itself a promise it is returned as-is, matching JS).
  | { kind: "promiseResolve"; arg: Expr }
  // `Promise.all(arg)` — `arg` is a `Promise<T>[]`; resolves to a `T[]` once every
  // input promise resolves (rejects if any rejects).
  | { kind: "promiseAll"; arg: Expr }
  // `fetch(url)` — a blocking HTTP GET that returns an already-settled
  // `Promise<Response>` (the microtask runtime has no async I/O; see codegen).
  // A transport error rejects the promise; an HTTP error status resolves with
  // `ok === false` (matching real `fetch`).
  | { kind: "fetch"; url: Expr }
  // `res.json()` as a `Promise<T>` — `Response.json()` is `Promise<any>`, which
  // the subset can't represent, so the target type `T` is captured up front (from
  // `await res.json() as T` or `const x: T = await res.json()`, like `jsonParse`).
  // Resolves to the response body parsed as JSON into a value of type `T`.
  | { kind: "responseJson"; receiver: Expr; type: Type }
  // The `null` / `undefined` literals (value types `"null"` / `"undefined"`).
  | { kind: "null" }
  | { kind: "undefined" }
  // `typeof operand` — a `string` ("number" / "string" / "boolean" / "object" /
  // "undefined"). For a union operand codegen emits a runtime `tsn_typeof` (the
  // active variant decides at runtime); the value also drives flow narrowing when
  // it appears as `typeof x === "…"` in an `if`/ternary condition (see codegen).
  | { kind: "typeof"; operand: Expr }
  // A closure: an arrow function (`(x: T) => e` / `(x: T) => { … }`) or an anonymous
  // function expression (`function (x: T) { … }`). `returnType` absent ⇒ inferred
  // from the body at codegen (an expression-bodied arrow lowers its body to one
  // `return`). `id` is assigned by a pre-pass (src/codegen/closures.ts) so codegen
  // and repr.ts agree on the closure's rep-scope key. Codegen emits a C++ lambda
  // wrapped in `std::function<…>`; captured locals are boxed for shared-mutable
  // closure semantics (see the capture machinery in codegen).
  | {
      kind: "closure";
      params: Param[];
      returnType?: RetType;
      body: Stmt[];
      async: boolean;
      id?: number;
    }
  // Call a function *value* `callee(args)` where `callee` is an arbitrary expression
  // (a call result `getFn()(x)`, an indexed element `fns[0](x)`, …), as opposed to a
  // direct named call (`call`) or a method call (`methodCall`). A bare identifier
  // call stays a `call` node — codegen resolves it to a top-level function or a
  // function-typed variable.
  | { kind: "callValue"; callee: Expr; args: Expr[] }
  // A spread element `...arg` — valid only inside an array literal (`[...a, b]`) or
  // a call's argument list (`f(...xs)`, where it targets a rest parameter). `arg` is
  // an array; its elements are spliced into the surrounding array/argument list.
  // A `spread` reaching `emitExpr` directly (anywhere else) is a clean error.
  | { kind: "spread"; arg: Expr };

// Several binding sites below carry an optional `boxed` flag, set by the capture
// pass (src/codegen/closures.ts) when a local variable is captured by a nested
// closure. A boxed variable is stored in a heap `tsn_box` cell (a `tsn_rc`) so an
// enclosing scope and its closures share one mutable binding — JS closure
// semantics. Codegen reads/writes such a variable through the cell (see codegen).
export type Stmt =
  // `type` is the annotation; absent means infer from the initializer. `init`
  // absent ⇒ a declaration with no initializer (`let x: T;`) — then `type` is
  // required (there's nothing to infer from, and the subset has no `any`); the
  // slot is assigned before it's read (stage 0 enforces "used before assigned").
  // `boxed` ⇒ captured by a nested closure (stored in a shared cell).
  | { kind: "let"; name: string; type?: Type; init?: Expr; boxed?: boolean }
  | { kind: "log"; arg: Expr }
  | { kind: "return"; value?: Expr }
  // a bare expression evaluated for effect (e.g. a function call), result discarded
  | { kind: "exprStmt"; expr: Expr }
  // `target = value`; target is an lvalue: `var`, `index` (a[i]), or `member` (obj.f)
  | { kind: "assign"; target: Expr; value: Expr }
  | { kind: "if"; cond: Expr; then: Stmt[]; else?: Stmt[] }
  | { kind: "while"; cond: Expr; body: Stmt[] }
  // `for (init; cond; update) { body }` — `++`/compound-assign desugar into `update`
  | { kind: "for"; init?: Stmt; cond?: Expr; update?: Stmt; body: Stmt[] }
  // `do { body } while (cond)` — like `while`, but the body runs once first.
  | { kind: "doWhile"; body: Stmt[]; cond: Expr }
  // `for (let name of iterable) { body }` — iterate an array's elements or a
  // string's characters. `name` is bound fresh each iteration to the element /
  // one-char string. (The element/char type is resolved from `iterable` in
  // codegen, since lowering has no type info.)
  | { kind: "forOf"; name: string; iterable: Expr; body: Stmt[]; boxed?: boolean }
  // `for (let name in target) { body }` — iterate the *keys* of `target`: array /
  // string indices as strings ("0", "1", …), or an object/instance's field names.
  // `name` is always a `string`.
  | {
      kind: "forIn";
      name: string;
      target: Expr;
      body: Stmt[];
      boxed?: boolean;
    }
  // `switch (disc) { case t: …; default: … }`. A clause with no `test` is the
  // `default`. JS `switch` matches with `===` and *falls through* until a `break`,
  // so codegen lowers to a dispatch + labels (see emit.ts), not a value table.
  | { kind: "switch"; disc: Expr; cases: SwitchCase[] }
  // `break;` / `break label;` and `continue;` / `continue label;`. An absent label
  // targets the innermost loop (or, for `break`, switch); a label targets the
  // matching enclosing labeled loop.
  | { kind: "break"; label?: string }
  | { kind: "continue"; label?: string }
  // `label: <loop>` — a labeled statement. Only loops may be labeled (so a labeled
  // `break`/`continue` has a well-defined target). `body` is the wrapped loop.
  | { kind: "labeled"; label: string; body: Stmt }
  // `throw value` — value must be a string (the subset has no Error objects; a
  // `throw new Error(msg)` lowers to throwing `msg`). Compiles to a C++ `throw`.
  | { kind: "throw"; value: Expr }
  // `try { block } catch (catchName) { catchBody } finally { finallyBody }`.
  // `catchName`/`catchBody` are absent when there is no `catch`; `finallyBody` is
  // absent when there is no `finally`. The caught value is bound as a `string`.
  | {
      kind: "try";
      block: Stmt[];
      catchName?: string;
      catchBody?: Stmt[];
      finallyBody?: Stmt[];
      // The caught binding is captured by a nested closure (stored in a cell).
      catchBoxed?: boolean;
    };

// One clause of a `switch`. `test` absent ⇒ the `default` clause. `body` are the
// clause's statements (they fall through into the next clause unless a `break`).
export type SwitchCase = { test?: Expr; body: Stmt[] };

// A function's return type, which may be `void` (no value) — distinct from the
// value types in `Type`.
export type RetType = Type | "void";

export interface Param {
  name: string;
  type: Type;
  // Captured by a nested closure ⇒ stored in a shared cell (see `boxed` above).
  boxed?: boolean;
  // A **default** parameter `p: T = <default>`. `type` stays the declared `T` (the
  // type seen in the body); the caller may omit the argument. Codegen receives the
  // value at the boundary as `T | undefined` and, at function entry, rebinds `p` to
  // `T` — the default expression when the argument was omitted (`undefined`), else
  // the passed value. The default is evaluated in the function body's scope (so it
  // may reference earlier parameters), left to right.
  default?: Expr;
  // A **rest** parameter `...p: T[]`. `type` is the array type `T[]`; the body uses
  // `p` as an ordinary array. At a call, the trailing arguments are collected into a
  // fresh `T[]` (so `f(1, 2, 3)` and `f(...arr)` both work). The rest parameter is
  // always last (enforced by TypeScript at stage 0).
  rest?: boolean;
}

export interface Func {
  name: string;
  params: Param[];
  returnType: RetType;
  body: Stmt[];
  // An `async function`. Its `returnType` is a `Promise<T>` (or `Promise<void>`);
  // codegen emits it as a C++20 coroutine (`co_return`, `co_await`). See codegen.
  async: boolean;
}

// An instance method. Same shape as a Func minus the (implicit `this`) receiver,
// which codegen supplies; `this.field`/`this.method()` resolve against the class.
export interface Method {
  name: string;
  params: Param[];
  returnType: RetType;
  body: Stmt[];
  // An `async` method — same coroutine treatment as an async free function.
  async: boolean;
}

// A class: fields (declaration order = struct layout), exactly one constructor,
// and instance methods. Inheritance / static / accessors are not modeled yet.
export interface ClassDecl {
  name: string;
  fields: Field[];
  ctor: { params: Param[]; body: Stmt[] };
  methods: Method[];
}

// A dependency module (one that is imported by another). It compiles to a
// memoized `init()` that runs its top-level code once and returns a *record* of
// its module-level variables — the `let`/`const` declarations in `body` become
// the record's fields; other statements run for their side effects. A reference
// to one of these variables (from this module's own functions or from an
// importer) reads it back through `init()`. Functions and classes are NOT here:
// they stay top-level (in `Module.functions`/`classes`), called/constructed
// directly. `index` is the module's position in dependency order.
export interface DepModule {
  index: number;
  body: Stmt[];
}

export interface Module {
  classes: ClassDecl[];
  functions: Func[];
  main: Stmt[]; // the ENTRY module's top-level statements -> body of C++ main()
  // Dependency modules (those imported by others), in dependency order. Empty for
  // a single-file program — in which case codegen is exactly as before.
  modules: DepModule[];
  // The local name of this file's `export default` target (a function/class name,
  // or a synthetic variable for `export default <expr>`). Set by `lower` on the
  // per-file result so the loader can wire the "default" export; the loader leaves
  // it unset on the merged module. Undefined when the file has no default export.
  defaultExport?: string;
}
