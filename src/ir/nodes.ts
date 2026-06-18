// Internal IR: a small, typed representation lowered from the TypeScript AST.
// Codegen consumes this — never the raw TS AST.

export type Type = "number" | "boolean";

export type BinaryOp = "+" | "-" | "*" | "/" | "%";

export type Expr =
  | { kind: "num"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "var"; name: string }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr };

export type Stmt =
  | { kind: "let"; name: string; type: Type; init: Expr }
  | { kind: "log"; arg: Expr };

export interface Module {
  stmts: Stmt[];
}
