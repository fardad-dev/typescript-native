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
  | { kind: "object"; fields: Field[] };

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
  | { kind: "unary"; op: "!"; operand: Expr }
  | { kind: "array"; elements: Expr[] }
  | { kind: "index"; arr: Expr; index: Expr }
  | { kind: "object"; properties: { name: string; value: Expr }[] }
  // member covers both `obj.field` and `arr.length` — the emitter resolves it by type.
  | { kind: "member"; obj: Expr; name: string }
  | { kind: "call"; callee: string; args: Expr[] };

export type Stmt =
  | { kind: "let"; name: string; type: Type; init: Expr }
  | { kind: "log"; arg: Expr }
  | { kind: "return"; value?: Expr }
  // a bare expression evaluated for effect (e.g. a function call), result discarded
  | { kind: "exprStmt"; expr: Expr }
  | { kind: "assign"; name: string; value: Expr }
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

export interface Module {
  functions: Func[];
  main: Stmt[]; // top-level statements -> body of C++ main()
}
