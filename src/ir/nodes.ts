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
  | { kind: "array"; element: Type }
  | { kind: "object"; fields: Field[] }
  // An instance of a named class. Unlike arrays/objects (value types), a class
  // instance is a *reference* type — see codegen (compiles to std::shared_ptr<C>).
  | { kind: "class"; name: string };

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
  // `JSON.parse(text) as T` (or a `T`-annotated target) — parse a JSON string into
  // a value of a statically-known type `T`. JSON.parse is `any` in TypeScript, so
  // the subset requires the target type up front (it can't lower an untyped value).
  | { kind: "jsonParse"; text: Expr; type: Type };

export type Stmt =
  // `type` is the annotation; absent means infer from the initializer.
  | { kind: "let"; name: string; type?: Type; init: Expr }
  | { kind: "log"; arg: Expr }
  | { kind: "return"; value?: Expr }
  // a bare expression evaluated for effect (e.g. a function call), result discarded
  | { kind: "exprStmt"; expr: Expr }
  // `target = value`; target is an lvalue: `var`, `index` (a[i]), or `member` (obj.f)
  | { kind: "assign"; target: Expr; value: Expr }
  | { kind: "if"; cond: Expr; then: Stmt[]; else?: Stmt[] }
  | { kind: "while"; cond: Expr; body: Stmt[] }
  // `for (init; cond; update) { body }` — `++`/compound-assign desugar into `update`
  | { kind: "for"; init?: Stmt; cond?: Expr; update?: Stmt; body: Stmt[] };

// A function's return type, which may be `void` (no value) — distinct from the
// value types in `Type`.
export type RetType = Type | "void";

export interface Param {
  name: string;
  type: Type;
}

export interface Func {
  name: string;
  params: Param[];
  returnType: RetType;
  body: Stmt[];
}

// An instance method. Same shape as a Func minus the (implicit `this`) receiver,
// which codegen supplies; `this.field`/`this.method()` resolve against the class.
export interface Method {
  name: string;
  params: Param[];
  returnType: RetType;
  body: Stmt[];
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
}
